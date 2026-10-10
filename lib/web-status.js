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
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { redactSecrets } from './ledger.js';

/** 面板状态路由（client 半 lib/client.js 里有一份同值副本——跨半不能 import，改动需两处同步；
 *  test/selfcheck.mjs 的 DE-10 组有守卫断言防止漂移）。 */
export const ZCODE_STATUS_PATH = '/plugins/dsh-connect-zcode/status';

/** 出站文本脱敏 + 截断（S-02：复用 lib/ledger.js 的单实现，消除两份正则副本）。
 *  任何进入状态文档的动态字符串都过一遍。 */
export function redactStatusText(text) {
  return redactSecrets(text);
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
 *
 * R-09：改为**尾部增量读**（原实现全量 readFileSync + split，40 万行/97MB 实测 244ms
 * 同步阻塞在 DSH 主进程，且发生在**每次面板状态 GET**）。台账只追加、无轮转，
 * 重度使用一年即数十 MB ⇒ 随时间线性劣化。provider 行必然在末尾若干行内，
 * 故从文件尾按块倒读，命中即止；块内首行可能被截断，解析失败会被跳过（安全）。
 * @param {string} ledgerPath
 */
const TAIL_CHUNK_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 1024 * 1024; // 上界：尾部 1MB 内找不到 provider 行就放弃（避免退化为全量读）

export function readLastLedgerRow(ledgerPath) {
  let fd;
  try {
    fd = openSync(ledgerPath, 'r');
    const { size } = fstatSync(fd);
    if (size === 0) return null;
    let readBytes = 0;
    let carry = '';
    while (readBytes < size && readBytes < TAIL_MAX_BYTES) {
      const chunk = Math.min(TAIL_CHUNK_BYTES, size - readBytes);
      const position = size - readBytes - chunk;
      const buf = Buffer.allocUnsafe(chunk);
      const got = readSync(fd, buf, 0, chunk, position);
      readBytes += got;
      const text = buf.subarray(0, got).toString('utf8') + carry;
      const lines = text.split('\n');
      /* 未读到文件头时，首行可能是被截断的半行 —— 从尾部扫描时它是"最旧"的一行，
       * 直接丢弃（下一轮它会作为 carry 的前缀重新出现，或本就无关紧要）。 */
      carry = position === 0 ? '' : lines.shift();
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].trim() === '') continue;
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
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* 关闭失败不影响结果 */
      }
    }
  }
}

/** 出站短字符串（脱敏 + 截断；动态字符串一律过这里）。 */
function shortText(value, maxLength = 80) {
  if (typeof value !== 'string' || value === '') return null;
  return redactStatusText(value).slice(0, maxLength);
}

/**
 * 赠送额度（Start Plan）摘要 —— 进状态文档前的归一 + 脱敏。
 *
 * 只出**数值与短字符串**：日志原始负载里有 plan/entitlement/bucket 各类 id，
 * 整份塞进状态文档既无必要也扩大暴露面。失败形态保留一句可诊断的 reason
 * （面板要能区分"读不到日志"与"日志里就是没有 start-plan"）。
 * @param {unknown} raw readPlanQuota 的返回值
 */
export function toQuotaSummary(raw) {
  if (raw === null || typeof raw !== 'object' || raw.ok !== true) {
    const reason = typeof raw?.reason === 'string' ? shortText(raw.reason, 60) : null;
    return { ok: false, reason: reason === null ? 'unavailable' : reason };
  }
  const num = (value) => (Number.isFinite(value) ? Math.trunc(value) : null);
  return {
    ok: true,
    state: ['active', 'pending', 'expired'].includes(raw.state) ? raw.state : 'unknown',
    planId: shortText(raw.planId),
    planName: shortText(raw.planName),
    model: shortText(raw.model, 40),
    totalUnits: num(raw.totalUnits),
    usedUnits: num(raw.usedUnits),
    remainingUnits: num(raw.remainingUnits),
    availableUnits: num(raw.availableUnits),
    startsAt: num(raw.startsAt),
    effectiveAt: num(raw.effectiveAt),
    endsAt: num(raw.endsAt),
    serverTime: num(raw.serverTime),
    observedAt: typeof raw.observedAt === 'string' ? raw.observedAt : null,
    source: 'zcode-log',
  };
}

/**
 * 赠送额度通道（app-server）摘要 —— 进状态文档前的归一 + 脱敏。
 *
 * 只出**布尔/短字符串/模型列表**：面板要用它渲染"赠送额度通道"区块，
 * 并在通道没就绪时显示可操作原因（`reason`）——这正是"模型选项里没有它"时的第一手判据。
 * @param {unknown} raw index.js 现读的注册状态
 */
export function toAppServerSummary(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const models = Array.isArray(source.models) ? source.models : [];
  return {
    enabled: source.enabled === true,
    registered: source.registered === true,
    reason: shortText(source.reason, 120),
    cliPath: shortText(source.cliPath, 200),
    toolPolicy: shortText(source.toolPolicy, 20),
    reasoningLevel: shortText(source.reasoningLevel, 20),
    providerId: shortText(source.providerId, 40),
    imagesSupported: source.imagesSupported === true,
    models: models
      .filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '')
      .map((row) => ({
        id: row.id,
        name: typeof row.name === 'string' && row.name !== '' ? shortText(row.name, 80) : row.id,
        contextWindow: Number.isFinite(row.contextWindow) ? Math.trunc(row.contextWindow) : 200000,
        /* 思考档事实（官方 variants，来自适配器同一份 reasoningFacts）：
         * 面板据此渲染"默认思考档"单选 —— 不硬编码档位。 */
        reasoningLevels: (Array.isArray(row.reasoningLevels) ? row.reasoningLevels : [])
          .filter((v) => typeof v === 'string' && v !== '')
          .slice(0, 8)
          .map((v) => shortText(v, 16)),
        defaultReasoningLevel: shortText(row.defaultReasoningLevel, 16),
      })),
  };
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
    /* 赠送额度（Start Plan）：数值来自 ZCode 自己写的日志（见 lib/plan-quota.js）。
     * 读取失败不抛——状态文档是所有面板功能的载体，一项读不到不该打挂整份文档。 */
    ...(deps.planQuota
      ? {
          planQuota: (() => {
            try {
              return toQuotaSummary(deps.planQuota());
            } catch (error) {
              return { ok: false, reason: `read-failed: ${String(error?.message ?? error).slice(0, 60)}` };
            }
          })(),
        }
      : {}),
    /* 赠送额度通道（app-server / Start Plan）：面板据此渲染「赠送额度通道」区块，
     * 并在未启用/未注册时给出**可操作原因**（否则用户只看到"模型不见了"）。 */
    ...(deps.appServer
      ? {
          appServer: (() => {
            try {
              return toAppServerSummary(deps.appServer());
            } catch (error) {
              return { enabled: false, registered: false, reason: `read-failed: ${String(error?.message ?? error).slice(0, 60)}`, models: [] };
            }
          })(),
        }
      : {}),
  };
}
