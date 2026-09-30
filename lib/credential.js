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
