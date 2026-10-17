#!/usr/bin/env node
/**
 * probe-context-limit.mjs —— **需额度**的边界探针：实测上游到底接受多大上下文。
 *
 * 为什么需要它：网关 `GET /v1/models` **不声明**上下文长度；1M 只是 ZCode `config.json`
 * 的官方声明值（`limit.context`），本项目没有任何一次真正的"超 200K 请求"记录。
 * 于是"200K 还是 1M"只能靠真实请求探边界 —— 本脚本就是干这个的。
 *
 * 做法（最省额度的版本）：
 *   1. 构造一条约 `--tokens`（默认 205000）token 的**纯 filler 用户消息**（ASCII 重复文本，
 *      tokenizer 约 4 字符/token ⇒ 字符数 = tokens × 4），`max_tokens: 1`（几乎不产生输出）；
 *   2. `POST {baseURL}/v1/messages`；
 *   3. 判定：
 *       HTTP 200          ⇒ **窗口 ≥ 该 token 数**（1M 声明成立到这一档）
 *       HTTP 4xx + 报错文本 ⇒ 报错里通常写明上限（如 "maximum context length is …"）⇒ 直接读出真值
 *       HTTP 429/3012     ⇒ 额度/风控问题，不是窗口问题（脚本会点明）
 *
 * 成本：一次请求 = 约 `--tokens` 输入 token（默认 20.5 万）+ 1 个输出 token。
 *      **只在你愿意花这份额度时跑**。
 *
 * 用法：
 *   node scripts/probe-context-limit.mjs                  # 205k，验证"是否 >200K"
 *   node scripts/probe-context-limit.mjs --tokens 400000  # 探更高档
 *   node scripts/probe-context-limit.mjs --tokens 1000000 # 直接撞 1M（最贵，一次看报错上限）
 *   node scripts/probe-context-limit.mjs --model glm-5.3-flash
 *
 * ⚠️ 只读 `~/.zcode/v2/config.json` 的 baseURL/apiKey，**不打印 key**（仅 sha256 前 8 位）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const TOKENS = Math.max(1000, Number(flag('tokens', '205000')) | 0);
const MODEL = flag('model', 'glm-5.3');
const PLAN_KEY = process.env.ZCODE_PLAN_KEY ?? 'builtin:bigmodel-coding-plan';

const cfg = JSON.parse(readFileSync(process.env.ZCODE_CONFIG_PATH ?? join(homedir(), '.zcode', 'v2', 'config.json'), 'utf8'));
const provider = cfg?.provider?.[PLAN_KEY];
const baseURL = provider?.options?.baseURL;
const apiKey = provider?.options?.apiKey;
if (typeof baseURL !== 'string' || baseURL === '' || typeof apiKey !== 'string' || apiKey === '') {
  console.error('✗ provider 缺少 baseURL / apiKey（可先跑 scripts/sync-key-to-config.mjs）');
  process.exit(1);
}
const fp = createHash('sha256').update(apiKey).digest('hex').slice(0, 8);
const url = `${baseURL.replace(/\/+$/, '')}/v1/messages`;
const fillerChars = TOKENS * 4;
const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(fillerChars / 45)).slice(0, fillerChars);

console.log(`POST ${url}`);
console.log(`model=${MODEL}  目标上下文≈${TOKENS} tokens（filler ${filler.length} 字符）key指纹=sha256:${fp}…`);
const startedAt = Date.now();
let res;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: `${filler}\n\n只回复 OK。` }],
    }),
  });
} catch (error) {
  console.log(`✗ 网络/传输失败（不是窗口问题）：${error?.message ?? error}`);
  process.exit(2);
}
const elapsed = Date.now() - startedAt;
const text = await res.text();
console.log(`HTTP ${res.status}（${elapsed}ms）`);
let body = null;
try {
  body = JSON.parse(text);
} catch {
  /* 非 JSON */
}

if (res.ok) {
  console.log('⇒ ✅ 上游接受了这个上下文 ⇒ **有效窗口 ≥ 该 token 数**');
  console.log('  usage:', JSON.stringify(body?.usage ?? null));
  process.exit(0);
}

const message = String(body?.error?.message ?? body?.message ?? text ?? '').slice(0, 500);
console.log('⇒ ✗ 被拒绝。响应文本（判断是不是窗口上限 / 额度 / 风控）：');
console.log('   ' + message.replace(/\s+/g, ' '));
const lower = message.toLowerCase();
if (/context|token|too long|length|exceed|maximum/.test(lower)) {
  const m = message.match(/(\d{5,})/);
  console.log(`\n⇒ 这看起来是**上下文上限**报错${m ? `，报错里的数字 = ${m[1]}` : ''}；该数字通常就是真实窗口。`);
  process.exit(0);
}
if (/quota|额度|429|rate|limit reached|3012|unusual/.test(lower)) {
  console.log('\n⇒ 这是**额度/风控**问题（不是窗口）。换个时间/通道再测。');
  process.exit(3);
}
console.log('\n⇒ 无法归类，请把上面的响应文本发我。');
process.exit(4);
