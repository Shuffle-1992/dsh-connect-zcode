/**
 * credential.js —— ZCode Coding Plan 凭据读取（零落盘、零缓存、零日志）。
 *
 * 契约（T20 §3.1 / T18 §1）：
 * - 源文件 `~/.zcode/v2/config.json`，条目 `provider[planKey].options.{apiKey, baseURL}`；
 * - 每次调用现读（readFileSync，小文件），返回值只在调用方内存存活；
 * - 任何错误消息不得含 key 原文；不写任何凭据副本文件；
 * - 只接 api-key 形态（Coding Plan）；`ey` 开头的 JWT = start-plan 账户 token，显式拒绝。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readStoredApiKeys, defaultCredentialStorePath, keyFingerprint } from './credential-store.js';

/** 本插件唯一接受的套餐条目（start-plan 的 JWT + 验证码门禁形态结构性不可直连，T18 已证）。 */
export const DEFAULT_PLAN_KEY = 'builtin:bigmodel-coding-plan';

/** 默认凭据文件路径（ZCode 桌面端 /login 后写入）。 */
export function defaultCredentialPath() {
  return join(homedir(), '.zcode', 'v2', 'config.json');
}

/** 可操作错误（消息面向用户，永不携带 key 原文）。 */
export class CredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredentialError';
  }
}

/**
 * 读取并校验 Coding Plan 凭据。失败一律抛 CredentialError（可操作文案）。
 * @param {string} [configPath] 显式配置路径；缺省 `~/.zcode/v2/config.json`。
 * @param {string} [planKey] 套餐条目键；缺省 builtin:bigmodel-coding-plan。
 * @returns {{ apiKey: string, baseURL: string }} 仅存内存的凭据。
 */
export function readPlanCredential(configPath = defaultCredentialPath(), planKey = DEFAULT_PLAN_KEY) {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new CredentialError(
      `ZCode Coding Plan 未启用或未登录：读不到 ${configPath}（${err?.code ?? err?.message}）。` +
        '请打开 ZCode 桌面端执行 /login bigmodel-coding-plan 后重试。'
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new CredentialError(`ZCode 配置不是合法 JSON：${configPath}。请打开 ZCode 桌面端重新登录后重试。`);
  }
  const entry = cfg?.provider?.[planKey];
  if (!entry || entry.enabled !== true) {
    throw new CredentialError(
      `ZCode Coding Plan 未启用（config.json 缺少 enabled 的 ${planKey} 条目）。` +
        '请打开 ZCode 桌面端执行 /login bigmodel-coding-plan 并启用该套餐后重试。'
    );
  }
  const options = entry?.options ?? {};
  const { apiKey, baseURL } = options;
  if (typeof apiKey !== 'string' || apiKey.length === 0 || typeof baseURL !== 'string' || baseURL.length === 0) {
    throw new CredentialError(
      'ZCode Coding Plan 缺 apiKey 或 baseURL：请打开 ZCode 桌面端执行 /login bigmodel-coding-plan 后重试。'
    );
  }
  if (/^ey/.test(apiKey)) {
    throw new CredentialError(
      '该条目是 start-plan 账户 token 而非 API Key，本插件不支持：' +
        '请改用 builtin:bigmodel-coding-plan（api-key 形态）的登录条目。'
    );
  }
  return { apiKey, baseURL };
}

/**
 * 校验一把 key 是否真的能调通（方案 B 的**采用前置**：不验活不切换，避免"换了更坏的"）。
 * 用 `GET {baseURL}/v1/models`（零推理成本）。
 *
 * ⚠️ **不能只看 HTTP 状态码**（2026-10-01 实测）：bigmodel 网关对**失效 key** 也返回
 * `HTTP 200`，但响应体是 `{"code":1000,"msg":"身份验证失败。","success":false}`。
 * 只看 `res.ok` 会把无效 key 判为有效 ⇒ 回退逻辑形同虚设。故必须**校验响应体**：
 *   ① 存在 `data` 数组且非空 ⇒ 通过；
 *   ② 出现 `code`/`success:false`/`msg` 含认证失败 ⇒ 判失败。
 * 永不抛；网络异常/形态不符一律 false。
 * @param {string} apiKey
 * @param {string} baseURL
 * @param {{ fetchFn?: Function, signal?: AbortSignal, timeoutMs?: number }} [io]
 * @returns {Promise<boolean>}
 */
export async function validateApiKey(apiKey, baseURL, io = {}) {
  try {
    const fetchFn = io.fetchFn ?? fetch;
    if (typeof fetchFn !== 'function') return false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), io.timeoutMs ?? 8000);
    const signal = io.signal ?? ac.signal;
    try {
      const res = await fetchFn(`${String(baseURL).replace(/\/+$/, '')}/v1/models`, {
        method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal,
      });
      if (res?.ok !== true) return false;
      // 关键：状态码 200 也可能是认证失败（body 带 code:1000），必须验体
      let body;
      try {
        body = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
      } catch {
        return false;
      }
      if (body === null || typeof body !== 'object') return false;
      if (body.success === false) return false;
      if (body.code !== undefined && body.code !== 200) return false;
      return Array.isArray(body.data) && body.data.length > 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * 解析可用凭据（方案 B）：config.json 优先；若它**验活失败**，回退到加密凭据库
 * `~/.zcode/v2/credentials.json` 里的 coding-plan api-key 候选（逐个验活，取第一个通过的）。
 *
 * 为什么需要它（2026-10-01 真机事故）：ZCode OAuth 重登后只把新 key 写进凭据库、
 * **不回写 config.json**，而 config.json 留着失效旧 key ⇒ CLI 与插件一起 401。
 *
 * 安全与稳定性约束：
 * - **必须验活才切换**：不验活就切换可能选到同样失效的 key，比不切更糟；
 * - 全程零明文日志（只用 keyFingerprint）；
 * - 任何失败回退为"用 config.json 的原值"（保持既有行为，不引入新失败面）。
 *
 * @param {string} [configPath]
 * @param {string} [planKey]
 * @param {{ fetchFn?: Function, storePath?: string, signal?: AbortSignal, onDiagnostic?: (msg: string) => void }} [io]
 * @returns {Promise<{ apiKey: string, baseURL: string, source: 'config'|'store' }>}
 */
export async function resolvePlanCredential(configPath = defaultCredentialPath(), planKey = DEFAULT_PLAN_KEY, io = {}) {
  const base = readPlanCredential(configPath, planKey); // 失败即抛（可操作文案），与既有行为一致
  const diag = typeof io.onDiagnostic === 'function' ? io.onDiagnostic : () => {};

  if (await validateApiKey(base.apiKey, base.baseURL, io)) {
    return { ...base, source: 'config' };
  }
  diag('config.json 中的 API Key 验活失败（401/网络），尝试回退到 ZCode 加密凭据库');

  // 把凭据库的静默过滤（读不到/解密失败/形态不符）也透传到调用方诊断，
  // 否则"库里有 key 却回退失败"会毫无线索（见 credential-store.js 的 API_KEY_RE 注释）。
  const candidates = readStoredApiKeys(io.storePath ?? defaultCredentialStorePath(), { onDiagnostic: diag });
  if (candidates.length === 0) {
    diag('凭据库中没有可用的 coding-plan api-key 候选（原因见上），沿用 config.json 原值');
    return { ...base, source: 'config' };
  }
  for (const cand of candidates) {
    if (await validateApiKey(cand.apiKey, base.baseURL, io)) {
      diag(`已回退到凭据库中的有效 key（account=${cand.id}, ${keyFingerprint(cand.apiKey)}）`);
      return { apiKey: cand.apiKey, baseURL: base.baseURL, source: 'store' };
    }
  }
  diag(`凭据库中 ${candidates.length} 个候选均验活失败，沿用 config.json 原值`);
  return { ...base, source: 'config' };
}
