/**
 * probe-context-declared.mjs —— **零额度**探针：问网关自己声明了多大上下文。
 *
 * 只发 `GET {baseURL}/v1/models`（列目录，**不推理、不消耗额度**），把原始响应里
 * 每个模型的**全部字段**打印出来，回答两个问题：
 *   ① 网关列目录时到底宣不声明 context 长度（有没有 context_length / max_context 之类字段）；
 *   ② 声明值是多少（与 ZCode config.json 的 limit.context=1000000 是否一致）。
 *
 * ⚠️ 只读 `~/.zcode/v2/config.json` 的 baseURL/apiKey，**不打印 key**（只打印指纹前缀）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const configPath = process.env.ZCODE_CONFIG_PATH ?? join(homedir(), '.zcode', 'v2', 'config.json');
const planKey = process.env.ZCODE_PLAN_KEY ?? 'builtin:bigmodel-coding-plan';
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const provider = cfg?.provider?.[planKey];
if (!provider) {
  console.error(`✗ config.json 里没有 provider["${planKey}"]`);
  process.exit(1);
}
const baseURL = provider?.options?.baseURL;
const apiKey = provider?.options?.apiKey;
if (typeof baseURL !== 'string' || baseURL === '' || typeof apiKey !== 'string' || apiKey === '') {
  console.error('✗ provider 缺少 baseURL / apiKey（可能需要先跑 scripts/sync-key-to-config.mjs）');
  process.exit(1);
}
const fp = createHash('sha256').update(apiKey).digest('hex').slice(0, 8);
console.log(`provider=${planKey}  baseURL=${baseURL}  key指纹=sha256:${fp}…`);

const url = `${baseURL.replace(/\/+$/, '')}/v1/models`;
const res = await fetch(url, { method: 'GET', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
console.log(`GET ${url} → HTTP ${res.status}`);
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  console.log('响应不是 JSON，前 400 字符：', text.slice(0, 400));
  process.exit(1);
}
const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
console.log(`顶层键: ${Object.keys(body ?? {}).join(',')}；模型数 ${list.length}`);

const ctxLike = [];
for (const model of list) {
  const keys = Object.keys(model ?? {});
  const ctxKeys = keys.filter((k) => /context|window|token|limit|max/i.test(k));
  if (ctxKeys.length > 0) ctxLike.push({ id: model.id, fields: Object.fromEntries(ctxKeys.map((k) => [k, model[k]])) });
}
if (ctxLike.length === 0) {
  console.log('\n⇒ 网关目录响应里**没有**任何 context/window/token/limit 字段（只有目录元数据）。');
} else {
  console.log('\n⇒ 网关目录里与上下文相关的字段：');
  for (const row of ctxLike) console.log(`  ${row.id}: ${JSON.stringify(row.fields)}`);
}
console.log('\n每个模型的所有字段（前 2 个）：');
for (const model of list.slice(0, 2)) console.log('  ' + JSON.stringify(model));
