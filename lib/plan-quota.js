/**
 * plan-quota.js —— 读「赠送额度（Start Plan）」的剩余量，**只读 ZCode 自己写的日志**。
 *
 * 为什么不去自己调上游（2026-10-10 实测结论）：
 *   额度端点是 `{origin}/api/v1/zcode-plan/billing/balance`，属 **Plan 通道**，
 *   外部 HTTP 直连会被上游风控拦（本机在同类 plan 端点上实测 `405 / code 3012
 *   unusual activity`）。而 **ZCode 桌面端自己一直在调这个端点**（`usage-stats` 与
 *   `coding-plan-availability` 两个模块各调一份），响应**逐次落在**
 *   `~/.zcode/v2/logs/<date>.log` 里。所以最稳、零风控、零新请求的拿法就是**读它的日志**。
 *
 * 代价（如实标注）：新鲜度取决于 ZCode 桌面端是否在运行/轮询。日志里带 `server_time`
 * 与行首时刻，两者都会进状态文档，面板可以据此显示"数据时间"，让用户自己判断新鲜度。
 *
 * 纪律：本模块**不发任何网络请求**；不解析、不返回任何凭据字段（billing/balance 响应里
 * 只有套餐/桶 id 与 token 数，本模块只取其中的数值与窗口时间）。
 */
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 日志行标记（`usage-stats` / `coding-plan-availability` 两个模块都会打这一行）。 */
const MARKER = 'billing/balance 请求完成';

/** 尾部倒读的块大小与上界（命中即止；超过上界就放弃，避免退化为全量读）。 */
const TAIL_CHUNK_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 4 * 1024 * 1024;

/** ZCode 日志目录默认值。 */
function defaultZcodeLogDir(dataBaseDir) {
  const base = typeof dataBaseDir === 'string' && dataBaseDir.trim() !== '' ? dataBaseDir.trim() : homedir();
  return join(base, '.zcode', 'v2', 'logs');
}

/**
 * 从文件尾部倒读，返回**最后一条**含 `billing/balance 请求完成` 的整行。
 * @param {string} file
 * @param {object} [fsImpl] 测试注入（openSync/fstatSync/readSync/closeSync）
 * @returns {string|null}
 */
function findNewestBalanceLine(file, fsImpl = { openSync, fstatSync, readSync, closeSync }) {
  let fd;
  try {
    fd = fsImpl.openSync(file, 'r');
    const { size } = fsImpl.fstatSync(fd);
    if (!Number.isFinite(size) || size === 0) return null;
    let readBytes = 0;
    let carry = '';
    while (readBytes < size && readBytes < TAIL_MAX_BYTES) {
      const chunk = Math.min(TAIL_CHUNK_BYTES, size - readBytes);
      const position = size - readBytes - chunk;
      const buf = Buffer.allocUnsafe(chunk);
      const got = fsImpl.readSync(fd, buf, 0, chunk, position);
      if (!Number.isFinite(got) || got <= 0) break;
      readBytes += got;
      // 本次块 + 上一轮的半行（carry 是更"新"的那半边的头部）
      const text = buf.subarray(0, got).toString('utf8') + carry;
      const lines = text.split('\n');
      // 非文件头时，首行可能是被截断的半行 —— 它是本块里"最旧"的，留作下一轮 carry
      carry = position === 0 ? '' : lines.shift();
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].includes(MARKER)) return lines[i];
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fsImpl.closeSync(fd);
      } catch {
        /* 关闭失败不影响结果 */
      }
    }
  }
}

/** 从日志行里抠出 JSON 体（行前缀是时间戳与日志级别，JSON 从第一个 `{"` 开始）。 */
function parseBalanceLine(line) {
  if (typeof line !== 'string') return null;
  const start = line.indexOf('{"');
  if (start < 0) return null;
  try {
    return JSON.parse(line.slice(start));
  } catch {
    return null;
  }
}

/** 行首 `[YYYY-MM-DD HH:MM:SS.mmm]` → ISO 字符串（取不到返回 null）。 */
function parseLineTimestamp(line) {
  const m = typeof line === 'string' ? line.match(/^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/) : null;
  if (m === null) return null;
  const d = new Date(m[1].replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const toInt = (v) => (Number.isFinite(v) ? Math.trunc(v) : null);

/**
 * 把 `billing/balance` 响应归一成面板要的形状（**纯函数**，便于自检）。
 *
 * 关键语义（2026-10-10 实测）：
 *   - `plans[]` 里的 start-plan 条目是"授予"，`entitlements[].grant_units` 是总量；
 *   - `balances[]` 是"余额桶"：**只有权益生效后才会出现**（`effective_at` 之前为空数组）
 *     —— 所以生效前 `remaining` 不可知，本函数用 `state:'pending'` 如实标注，
 *     而不是拿 grant_units 冒充"剩余"（那会在面板上显示成"一分没用"的误导）；
 *   - `remaining_units` 直接取自桶（不再自算 `total-used`，避免口径漂移）。
 *
 * @param {unknown} payload 日志行 JSON（形如 {payload:{data:{plans,balances,server_time}}})
 * @param {number} [nowMs] 判定 pending/active/expired 的基准时刻
 * @returns {{ok:true, state:string, planId:string, planName:string, model:string|null,
 *   totalUnits:number|null, usedUnits:number|null, remainingUnits:number|null, availableUnits:number|null,
 *   startsAt:number|null, effectiveAt:number|null, endsAt:number|null, serverTime:number|null}
 *   | {ok:false, reason:string}}
 */
export function normalizeQuota(payload, nowMs = Date.now()) {
  const data = payload?.payload?.data;
  if (data === null || typeof data !== 'object') return { ok: false, reason: 'no-payload' };
  const plans = Array.isArray(data.plans) ? data.plans : [];
  const balances = Array.isArray(data.balances) ? data.balances : [];
  // 只认 start-plan（Coding Plan 不在这个端点的 balances 里，本功能专供赠送额度）
  const starts = plans.filter((p) => typeof p?.plan_id === 'string' && p.plan_id.includes('start-plan'));
  if (starts.length === 0) return { ok: false, reason: 'no-start-plan' };
  // 多份时取结束最晚的那份（活动叠加时以长期/更晚者为准）
  const plan = starts.slice().sort((a, b) => (toInt(b?.ends_at) ?? 0) - (toInt(a?.ends_at) ?? 0))[0];
  const entitlements = Array.isArray(plan.entitlements) ? plan.entitlements : [];
  const ent = entitlements[0] ?? {};
  const bucket =
    balances.find((b) => b?.entitlement_id !== undefined && b.entitlement_id === ent.entitlement_id) ??
    balances.find((b) => b?.plan_id === plan.plan_id) ??
    null;

  const totalUnits = toInt(bucket?.total_units) ?? toInt(ent.grant_units);
  const usedUnits = toInt(bucket?.used_units);
  const remainingUnits = toInt(bucket?.remaining_units);
  const availableUnits = toInt(bucket?.available_units);
  const startsAt = toInt(plan.starts_at);
  const effectiveAt = toInt(ent.effective_at);
  const endsAt = toInt(bucket?.expires_at) ?? toInt(plan.ends_at);

  let state;
  if (effectiveAt !== null && effectiveAt > 0 && nowMs < effectiveAt * 1000) state = 'pending';
  else if (endsAt !== null && endsAt > 0 && nowMs >= endsAt * 1000) state = 'expired';
  else if (bucket === null) state = 'pending'; // 无桶 = 还没开始计（同上，别冒充"剩余=总量"）
  else state = 'active';

  return {
    ok: true,
    state,
    planId: String(plan.plan_id),
    planName: typeof plan.name === 'string' && plan.name !== '' ? plan.name : String(plan.plan_id),
    model: typeof ent.show_name === 'string' && ent.show_name !== '' ? ent.show_name : null,
    totalUnits,
    usedUnits,
    remainingUnits,
    availableUnits,
    startsAt,
    effectiveAt,
    endsAt,
    serverTime: toInt(data.server_time),
  };
}

/** 目录里最新的 `*.log`（按 mtime；取不到返回 null）。 */
function newestLogFile(logDir, fsImpl) {
  let names;
  try {
    names = fsImpl.readdirSync(logDir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    if (!/\.log$/i.test(name)) continue;
    const file = join(logDir, name);
    let stat;
    try {
      stat = fsImpl.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (best === null || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
  }
  return best === null ? null : best.file;
}

/**
 * 读取当前赠送额度（尽力而为，**永不抛**）。
 * @param {{ dataBaseDir?: string, logDir?: string, nowMs?: number, fsImpl?: object }} [io]
 * @returns {{ok:true, ...}|{ok:false, reason:string, logDir?:string}}
 */
export function readPlanQuota(io = {}) {
  const fsImpl = io.fsImpl ?? { readdirSync, statSync, openSync, fstatSync, readSync, closeSync };
  const logDir = typeof io.logDir === 'string' && io.logDir !== '' ? io.logDir : defaultZcodeLogDir(io.dataBaseDir);
  try {
    const file = newestLogFile(logDir, fsImpl);
    if (file === null) return { ok: false, reason: 'no-log', logDir };
    const line = findNewestBalanceLine(file, fsImpl);
    if (line === null) return { ok: false, reason: 'no-balance-line', logDir };
    const parsed = parseBalanceLine(line);
    if (parsed === null) return { ok: false, reason: 'bad-json', logDir };
    const quota = normalizeQuota(parsed, Number.isFinite(io.nowMs) ? io.nowMs : Date.now());
    if (quota.ok !== true) return { ...quota, logDir };
    return { ...quota, observedAt: parseLineTimestamp(line), logFile: file.split(/[\\/]/).pop(), logDir };
  } catch (error) {
    return { ok: false, reason: `error: ${String(error?.message ?? error).slice(0, 120)}`, logDir };
  }
}
