/**
 * web-status.js —— 面板只读状态（T21 §3.3 方案 B）：
 * client 半无法读文件/开关，概览所需的动态事实（冻结态、台账、注册态、目录）
 * 由 host 半经回环路由 `/plugins/dsh-connect-zcode/status` 提供（trae 同款机制，
 * trae lib/index.js :3697-3720）。本模块只做纯构建与校验，不持有任何凭据。
 *
 * 安全约束（T21 §3.3-B 硬要求）：
 * - 仅回环：Origin/Host 都必须是回环地址（trae :1664-1679 / :3571-3581 同款判定）；
 * - 响应零凭据：endpoint 只出 host（不含 path/key），台账摘要出前行再脱敏一次。
 */
import { readFileSync } from 'node:fs';

/** 面板状态路由（client 半 lib/client.js 里有一份同值副本——跨半不能 import，改动需两处同步）。 */
export const ZCODE_STATUS_PATH = '/plugins/dsh-connect-zcode/status';

/** 疑似密钥形态（与 lib/ledger.js SECRET_PATTERNS 同集；此处是出站前最后一道）。 */
const SECRET_PATTERNS = [
  /[0-9a-f]{32}\.[A-Za-z0-9]{16}/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
];

/** 出站文本脱敏 + 截断（任何进入状态文档的动态字符串都过一遍）。 */
export function redactStatusText(text) {
  let out = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '<REDACTED>');
  return out.slice(0, 200);
}

/** JSON 响应（trae :3563-3570 同款：显式 Content-Type + Content-Length）。 */
export function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Origin 是否回环（undefined/空 = 同源无 Origin 头，放行——trae :3572-3581 同款）。
 * @param {string|undefined} origin
 */
export function originIsLoopback(origin) {
  if (typeof origin !== 'string' || origin.trim() === '') return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Host 头是否回环（带端口也可，如 `localhost:5173`——trae :1664-1679 同款）。
 * @param {string|undefined} host
 */
export function hostIsLoopback(host) {
  if (typeof host !== 'string' || host.trim() === '') return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}

/**
 * 读台账最后一条 channel=provider 行，压成面板摘要（读不到/损坏 → null，尽力而为）。
 * 只出 {ts, model, exit, input, output, elapsedMs}；exit 为字符串时再脱敏。
 * @param {string} ledgerPath
 */
export function readLastLedgerRow(ledgerPath) {
  try {
    const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let row;
      try {
        row = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (row?.channel !== 'provider') continue;
      return {
        ts: typeof row.ts === 'string' ? row.ts : null,
        model: typeof row.model === 'string' ? row.model : null,
        exit: typeof row.exit === 'string' ? redactStatusText(row.exit) : (typeof row.exit === 'number' ? row.exit : null),
        input: typeof row.input === 'number' ? row.input : null,
        output: typeof row.output === 'number' ? row.output : null,
        elapsedMs: typeof row.elapsedMs === 'number' ? row.elapsedMs : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 组装面板状态文档（纯函数；deps 全部注入，便于自检）。
 * models[] 行（T22）：除 id/name 外携带面板行控件所需的**能力事实**
 * （official 徽标 / 1M 选项显隐 / 图片锁定态 / 官方推理档），全部为静态目录事实，
 * 零凭据；预算/开关等用户配置由面板从 settings 快照自取，不进状态文档。
 * @param {{
 *   registered: () => boolean,
 *   readSwitch: () => { enabled: boolean },
 *   endpointHost: () => string | null,
 *   catalog: () => readonly {id: string, name?: string, official?: boolean, maxContextWindow?: number, input?: string[], reasoningEfforts?: object}[],
 *   enabledModelIds: () => readonly string[],
 *   lastLedger?: () => unknown,
 * }} deps
 */
export function buildStatusDocument(deps) {
  const catalog = Array.isArray(deps.catalog?.()) ? deps.catalog() : [];
  const enabledIds = [...new Set((Array.isArray(deps.enabledModelIds?.()) ? deps.enabledModelIds() : []).filter((id) => typeof id === 'string' && id.length > 0))];
  const enabled = new Set(enabledIds);
  const frozen = deps.readSwitch?.().enabled === false;
  const host = deps.endpointHost?.();
  return {
    providerRegistered: deps.registered?.() === true,
    frozen,
    endpointHost: typeof host === 'string' && host !== '' ? host : null,
    modelsTotal: catalog.length,
    models: catalog.map((row) => {
      const efforts = row?.reasoningEfforts !== null && typeof row?.reasoningEfforts === 'object' ? row.reasoningEfforts : undefined;
      return {
        id: row?.id,
        name: typeof row?.name === 'string' && row.name !== '' ? row.name : row?.id,
        official: row?.official === true,
        // 1M 选项判定来源：官方声明了高于基础档的 Max 档（无官方 Max 的模型面板不出 1M）。
        has1m: Number.isInteger(row?.maxContextWindow) && row.maxContextWindow > 0,
        imageSupported: Array.isArray(row?.input) && row.input.includes('image'),
        ...(efforts !== undefined && row?.official === true ? { reasoningVariants: Object.keys(efforts) } : {}),
      };
    }),
    enabledModelIds: enabledIds,
    enabledCount: enabledIds.length === 0 ? catalog.length : catalog.filter((row) => enabled.has(row?.id)).length,
    ...(deps.lastLedger ? { lastLedger: deps.lastLedger() } : {}),
  };
}
