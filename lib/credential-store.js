/**
 * credential-store.js —— ZCode 凭据的**第二来源**：加密凭据库 `~/.zcode/v2/credentials.json`（方案 B）。
 *
 * 背景（2026-10-01 真机事故）：
 * 用户在 ZCode 里 OAuth 重新登录后，ZCode 把**新签发的 API Key 只写进 credentials.json
 * （加密存储）**，**没有回写 config.json**；而 config.json 里留着已失效的旧 Key。
 * 结果：ZCode CLI 与本插件（都读 config.json）一起 401「身份验证失败」——**连 CLI 自己都挂**。
 *
 * 因此本模块提供"第二来源"，让插件跟随 ZCode 的实际登录态，而不是依赖它是否回写 config.json。
 *
 * 解密机制（从 zcode.cjs 反编译实证，非猜测）：
 *   格式  : `enc:v1:<iv b64url>.<tag b64url>.<data b64url>`
 *   算法  : AES-256-GCM
 *   密钥  : sha256(secret)
 *   secret: env `ZCODE_CREDENTIAL_SECRET`；缺省 = `zcode-credential-fallback:<platform>:<homedir>:<username>`
 *   （zcode.cjs: Qdn="enc:v1:" / KZr=12(iv) / H7s=16(tag) / K7s=sha256 / Z7s=resolveCredentialSecret）
 *
 * 设计约束：
 * - **尽力而为**：任何失败（文件缺失、格式变化、解密失败、Node 版本差异）都返回 null，绝不抛；
 * - **零落盘**：只在内存持有明文，不写任何副本文件；
 * - **零明文日志**：本模块不打印任何值；错误消息只描述原因；
 * - **可关闭**：调用方（credential.js）决定是否采用，且采用前必须**验活**（见下）。
 */

import { readFileSync } from 'node:fs';
import { createDecipheriv, createHash } from 'node:crypto';
import { homedir, platform, userInfo } from 'node:os';
import { join } from 'node:path';

/** 加密值前缀与算法常量（与 zcode.cjs 一致）。 */
const ENC_PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET';

/** 默认凭据库路径。 */
export function defaultCredentialStorePath() {
  return join(homedir(), '.zcode', 'v2', 'credentials.json');
}

/** 解出解密 secret（env 优先，否则 ZCode 的 fallback 串——与 zcode.cjs Z7s 同式）。 */
function resolveSecret() {
  const fromEnv = process.env[SECRET_ENV]?.trim();
  if (fromEnv) return { secret: fromEnv, source: 'env' };
  let user = 'unknown';
  try {
    user = userInfo().username;
  } catch {
    /* 取不到用户名就用 unknown（与 zcode.cjs 同式） */
  }
  return { secret: `zcode-credential-fallback:${platform()}:${homedir()}:${user}`, source: 'fallback' };
}

/**
 * 解密单个 enc:v1 值。失败返回 null（绝不抛、绝不打印值）。
 * @param {unknown} value
 * @returns {string|null}
 */
export function decryptCredentialValue(value) {
  try {
    if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return null;
    const parts = value.slice(ENC_PREFIX.length).split('.');
    if (parts.length !== 3) return null;
    const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url'));
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN || data.length === 0) return null;
    const key = createHash('sha256').update(resolveSecret().secret).digest();
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** zhipu 平台 API Key 形态（32 hex id + "." + 16 secret）。 */
const API_KEY_RE = /^[0-9a-f]{32}\.[A-Za-z0-9]{16}$/;

/**
 * 从凭据库读出全部 **api-key 形态**的候选（coding-plan 的 account-provider 条目）。
 * 只认形如 `account-provider:coding-plan:...:api-key` 的键，且解密后必须匹配 API Key 形态。
 * 返回顺序稳定（按 key 字典序），便于调用方按序验活。
 * @param {string} [storePath]
 * @returns {Array<{ id: string, apiKey: string }>} 失败 = 空数组
 */
export function readStoredApiKeys(storePath = defaultCredentialStorePath()) {
  try {
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    if (raw === null || typeof raw !== 'object') return [];
    const out = [];
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('account-provider:coding-plan:')) continue;
      if (!k.endsWith(':api-key')) continue;
      const plain = decryptCredentialValue(v);
      if (typeof plain !== 'string' || !API_KEY_RE.test(plain)) continue;
      /* 真实键名（实测 2026-10-01）：
       *   account-provider:coding-plan:account:<planId>:account:<accountId>:api-key
       * 例：account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:12345678901234567:api-key
       * id 取 <planId>（如 bigmodel-individual-coding-plan），只用于日志/去重，不含 key 本身。 */
      const segs = k.split(':');
      const planId = segs[0] === 'account-provider' && segs[1] === 'coding-plan' && segs[2] === 'account' ? segs[3] : undefined;
      out.push({ id: planId ?? 'unknown', apiKey: plain });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } catch {
    return [];
  }
}

/** 脱敏指纹（仅供日志/诊断，绝不还原 key）。 */
export function keyFingerprint(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length < 12) return '(invalid)';
  return `head=${apiKey.slice(0, 8)}*** tail=***${apiKey.slice(-4)}`;
}
