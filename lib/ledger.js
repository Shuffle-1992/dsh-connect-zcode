/**
 * ledger.js —— 额度通道登记（PROTOCOL §5.2，channel=provider）。
 *
 * 每次请求完成后（含失败）向 collab/logs/zcode-runs.jsonl 追加一行 JSON：
 *   {ts, tag, billing:"zcode-plan", provider:"zcode", endpoint, channel:"provider",
 *    model, input, output, exit, elapsedMs}
 * 约束：appendFileSync 追加写（绝不重写整个文件，防与派发通道并发冲突）；
 * exit 填错误摘要（经 sanitizeErr 脱敏，不得含 key）。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 台账默认路径（可移植）：
 *   1. env `ZCODE_CONNECT_LEDGER_PATH`（最高优先）
 *   2. `~/.dsh/zcode-runs.jsonl`（本插件的通用默认位置）
 *   3. 亦可在插件 config 里用 `ledgerPath` 覆盖（见 index.js）
 * 目录不存在时自动创建；写入失败只记录不抛（不影响推理主流程）。
 */
export const DEFAULT_LEDGER_PATH =
  process.env.ZCODE_CONNECT_LEDGER_PATH || join(homedir(), '.dsh', 'zcode-runs.jsonl');

/** zhipu 平台 key 形态（32 位 hex id + "." + 16 位 secret）；任何落盘文本先抹除再写。 */
const SECRET_PATTERNS = [
  /[0-9a-f]{32}\.[A-Za-z0-9]{16}/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
];

/** 错误摘要脱敏：截断 + 抹除任何疑似密钥形态（自检 §3.5-4 的运行时半边）。 */
export function sanitizeErrorSummary(err) {
  let text = String(err?.message ?? err ?? 'unknown error');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '<REDACTED>');
  return text.slice(0, 200);
}

/**
 * 追加一行 provider 通道运行记录。
 * @param {{ model?: string|null, endpoint?: string|null, input?: number|null,
 *           output?: number|null, exit?: number|string, elapsedMs?: number,
 *           tag?: string }} record
 * @param {string} [ledgerPath]
 */
export function appendProviderRun(record, ledgerPath = DEFAULT_LEDGER_PATH) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tag: record.tag ?? 'dsh-provider',
    billing: 'zcode-plan',
    provider: 'zcode',
    endpoint: record.endpoint ?? null,
    channel: 'provider',
    model: record.model ?? null,
    input: record.input ?? null,
    output: record.output ?? null,
    exit: typeof record.exit === 'string' ? sanitizeErrorSummary(record.exit) : (record.exit ?? 0),
    elapsedMs: record.elapsedMs ?? null,
  });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${line}\n`, 'utf8');
}
