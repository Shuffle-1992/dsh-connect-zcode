#!/usr/bin/env node
/**
 * selfcheck.mjs —— dsh-connect-zcode 自检（T20 §3.5 + T21 §3.5 + T22 §1.5）。
 *
 * 纪律：不产生任何网络请求（fetch 全程投毒）；不读真实 ~/.zcode/v2/config.json 内容
 * （凭据与官方元数据用 tmp fixture）；tmp 用后即删；零明文（假 key 现场构造，不落字面量）。
 * 退出码：0=全绿；1=存在 FAIL。
 * T22 新增组：5.3 系显式集合过滤 / 官方元数据归一与合并（锁定）/ 用户开关与上下文预算 /
 * trae 形状完整性（每行正整数 contextWindow + reasoningEfforts 枚举映射）/ host 管线 /
 * 面板行控件（锁定 disabled、1M 显隐、官方徽标）。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir, homedir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as crypto from 'node:crypto';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function waitFor(cond, ms = 4000) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  return cond();
}

/* ⚠️ 网络投毒必须在**任何被测模块导入之前**（R-01，2026-10-06 复核修复）。
 * 原实现把投毒放在全链路注册段（旧 :865），晚于 :858 的 `await opts.resolveApiKey(...)`；
 * 那一行会走凭据门 → `resolvePlanCredential` 回退路径 → 按 **默认路径** 读取并解密
 * 真实 `~/.zcode/v2/credentials.json`（实测基线日志："凭据库中 2 个候选均验活失败"，
 * 而 fixture 只埋了 1 把 key —— 多出来的只能是真实用户凭据库）。
 * 后果三层：① 自述的"零网络零凭据"纪律被确定性打破；② 真实 key 解密进内存后被当
 * x-api-key 发出（当前被 .test 不可解析兜住，DNS 环境异常时是真外发）；
 * ③ DNS 慢的环境额外 3×8s 串行等待。
 * 故：投毒提前到模块导入前，全模块加载期与全部 gate 路径零真实 fetch。 */
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('NETWORK FORBIDDEN BY SELFCHECK');
};
/** 真实 console 方法的模块级备份（段 7 会临时替换以捕获插件日志）。 */
const REAL_WARN = console.warn;
const REAL_LOG = console.log;
// ─── 模块导入（被测物） ───────────────────────────────────────────────────────
const credential = await import('../lib/credential.js');
const credStore = await import('../lib/credential-store.js');
const sw = await import('../lib/switch.js');
const ledger = await import('../lib/ledger.js');
const discovery = await import('../lib/discovery.js');
const modelMeta = await import('../lib/model-meta.js');
const webStatus = await import('../lib/web-status.js');
const appServer = await import('../lib/app-server.js');
const planQuota = await import('../lib/plan-quota.js');
const { Semaphore, instrumentApi } = await import('../lib/api-instrument.js');

const tmp = mkdtempSync(join(tmpdir(), 'dsh-connect-zcode-selfcheck-'));
const cleanupFiles = [];
function tmpFile(name, content) {
  const file = join(tmp, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  cleanupFiles.push(file);
  return file;
}

/** 假 zhipu 形态 key（32 hex + "." + 16 alnum）——现场构造，任何文件里不出现字面量。 */
const fakeKey = `${'a'.repeat(32)}.${'b'.repeat(16)}`;
/* 官方 models 段（T22）：形状照真实 ZCode config.json 的 provider[planKey].models 段
 * （key 大小写与网关 id 不同 → 匹配须大小写不敏感；只有这 2 个模型有官方数据，
 * FlashX 无 → 用作「无官方数据」对照）。不含任何凭据字段。 */
const fixtureModels = () => ({
  'GLM-5.3': {
    reasoning: { enabled: true, variants: ['low', 'max', 'high'], defaultVariant: 'max' },
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ['text'], output: ['text'] },
  },
  'GLM-5.3-Flash': {
    reasoning: { enabled: true, variants: ['low', 'max', 'high'], defaultVariant: 'max' },
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
  },
});
const fixtureConfig = (over = {}, withModels = true) =>
  JSON.stringify({
    provider: {
      'builtin:bigmodel-coding-plan': {
        enabled: true,
        ...(withModels ? { models: fixtureModels() } : {}),
        options: { apiKey: fakeKey, baseURL: 'https://example.test/api/anthropic', ...over },
      },
    },
  });

async function assertRejects(promise, pattern, label) {
  try {
    await promise;
    return false;
  } catch (err) {
    return pattern.test(err?.message ?? String(err)) ? true : `意外错误形态: ${err?.message ?? err}`;
  }
}

// ─── 1. 凭据读取（§3.1） ─────────────────────────────────────────────────────
{
  const okPath = tmpFile('cred-ok.json', fixtureConfig());
  const hit = credential.readPlanCredential(okPath);
  check('凭据: 正常态返回 {apiKey, baseURL}', hit.apiKey === fakeKey && hit.baseURL === 'https://example.test/api/anthropic' && Object.keys(hit).length === 2);

  const errMissing = (() => {
    try {
      credential.readPlanCredential(join(tmp, 'nope.json'));
      return null;
    } catch (e) {
      return e;
    }
  })();
  check('凭据: 缺文件 → CredentialError 且文案可操作', errMissing?.name === 'CredentialError' && /bigmodel-coding-plan/.test(errMissing.message) && !errMissing.message.includes(fakeKey), errMissing?.message?.slice(0, 60));

  const noKey = tmpFile('cred-nokey.json', fixtureConfig({ apiKey: '' }));
  const errNoKey = (() => {
    try {
      credential.readPlanCredential(noKey);
      return null;
    } catch (e) {
      return e;
    }
  })();
  check('凭据: 缺 apiKey → CredentialError', errNoKey?.name === 'CredentialError' && /缺 apiKey/.test(errNoKey.message));

  const jwt = tmpFile('cred-jwt.json', fixtureConfig({ apiKey: 'eyJhbGciOiJIUzI1NiJ9.fake.signature' }));
  const errJwt = (() => {
    try {
      credential.readPlanCredential(jwt);
      return null;
    } catch (e) {
      return e;
    }
  })();
  check('凭据: JWT 形态（start-plan）→ 显式拒绝', errJwt?.name === 'CredentialError' && /start-plan/.test(errJwt.message), errJwt?.message?.slice(0, 60));

  const disabled = tmpFile('cred-disabled.json', JSON.stringify({ provider: { 'builtin:bigmodel-coding-plan': { enabled: false, options: { apiKey: fakeKey, baseURL: 'https://x.test' } } } }));
  const errDisabled = (() => {
    try {
      credential.readPlanCredential(disabled);
      return null;
    } catch (e) {
      return e;
    }
  })();
  check('凭据: enabled:false → CredentialError', errDisabled?.name === 'CredentialError' && /未启用/.test(errDisabled.message));
}

// ─── 1b. 凭据库回退（方案 B，2026-10-01 真机事故修复） ────────────────────────
{
  /* 事故：ZCode OAuth 重登后只把新 key 写进 credentials.json（加密），**不回写 config.json**，
   * 而 config.json 留着失效旧 key ⇒ CLI 与插件一起 401。
   * 修法：resolvePlanCredential 在 config.json 的 key **验活失败**时，回退到凭据库候选。
   * 关键不变量：**必须验活才切换**（不验活可能选到同样失效的 key，比不切更糟）。 */

  // 构造一把合法形态的假 key（32 hex + "." + 16 alnum；必须真 hex，否则被形态校验滤掉）
  const mkKey = (h) => `${h.repeat(32).slice(0, 32)}.${'B'.repeat(16)}`;
  const storedKey = `${'a'.repeat(32)}.${'S'.repeat(16)}`; // 32 个 'a' 是合法 hex
  const enc = (() => {
    const { createCipheriv, createHash } = crypto;
    const secret = `zcode-credential-fallback:${process.platform}:${homedir()}:${userInfo().username}`;
    const key = createHash('sha256').update(secret).digest();
    const iv = Buffer.alloc(12, 7);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(storedKey, 'utf8'), c.final()]);
    return `enc:v1:${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
  })();

  check('凭据库: 解密 enc:v1（AES-256-GCM + sha256(secret)，与 zcode.cjs 同式）', (() => {
    const store = tmpFile('credstore.json', JSON.stringify({ 'account-provider:coding-plan:account:acct-x-plan:account:1:api-key': enc }));
    const list = credStore.readStoredApiKeys(store);
    return list.length === 1 && list[0].id === 'acct-x-plan' && list[0].apiKey === storedKey;
  })());
  check('凭据库: 非 enc 值/坏 JSON/缺文件 → 空数组（绝不抛）', (() => {
    const bad1 = tmpFile('credstore-bad1.json', JSON.stringify({ 'account-provider:coding-plan:account:a:api-key': 'plain-not-enc' }));
    const bad2 = tmpFile('credstore-bad2.json', 'not-json{{');
    return credStore.readStoredApiKeys(bad1).length === 0 && credStore.readStoredApiKeys(bad2).length === 0 && credStore.readStoredApiKeys(join(tmp, 'nope.json')).length === 0;
  })());
  check('凭据库: 只收 coding-plan 前缀 + 只收 api-key 形态', (() => {
    const store = tmpFile('credstore-filter.json', JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': enc,
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:other': enc,
      'oauth:bigmodel:access_token': enc,
      'account-provider:other:account:x:account:1:api-key': enc,
    }));
    const list = credStore.readStoredApiKeys(store);
    return list.length === 1 && list[0].id === 'bigmodel-individual-coding-plan';
  })());

  /* 形态校验是**静默过滤**：若 ZCode 换 key 形态，全部候选会被滤掉、调用方只看到"空数组"。
   * 故要求：形态不符/解密失败/库不可读 都要经 onDiagnostic 报出来（只报长度与原因，零明文）。 */
  check('凭据库诊断: 形态不符（非 32hex.16alnum）→ 报诊断且不含 key 内容', (() => {
    // 用一段合法加密、但明文形态不符的假值（长度 20）
    const wrongShapePlain = 'not-a-valid-zhipu-key'; // 21 字符，明显不符 32hex.16alnum
    const wrongShape = (() => {
      const { createCipheriv, createHash } = crypto;
      const secret = `zcode-credential-fallback:${process.platform}:${homedir()}:${userInfo().username}`;
      const key = createHash('sha256').update(secret).digest();
      const iv = Buffer.alloc(12, 9);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(wrongShapePlain, 'utf8'), c.final()]);
      return `enc:v1:${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
    })();
    const store = tmpFile('credstore-shape.json', JSON.stringify({ 'account-provider:coding-plan:account:p:account:1:api-key': wrongShape }));
    const msgs = [];
    const list = credStore.readStoredApiKeys(store, { onDiagnostic: (m) => msgs.push(m) });
    const joined = msgs.join(' ');
    return (
      list.length === 0 &&
      msgs.length > 0 &&
      joined.includes('形态校验未通过') &&
      joined.includes(`长度=${wrongShapePlain.length}`) &&
      !joined.includes(wrongShapePlain)
    );
  })());
  check('凭据库诊断: 解密失败 → 报诊断（secret 不匹配/格式变更）', (() => {
    const store = tmpFile('credstore-dec.json', JSON.stringify({ 'account-provider:coding-plan:account:p:account:1:api-key': 'enc:v1:AAAA.BBBB.CCCC' }));
    const msgs = [];
    const list = credStore.readStoredApiKeys(store, { onDiagnostic: (m) => msgs.push(m) });
    return list.length === 0 && msgs.some((m) => m.includes('解密失败'));
  })());
  check('凭据库诊断: 文件缺失/坏 JSON → 报诊断', (() => {
    const msgs1 = [];
    credStore.readStoredApiKeys(join(tmp, 'no-such-store.json'), { onDiagnostic: (m) => msgs1.push(m) });
    const msgs2 = [];
    credStore.readStoredApiKeys(tmpFile('credstore-badjson.json', 'not-json{{'), { onDiagnostic: (m) => msgs2.push(m) });
    return msgs1.some((m) => m.includes('不可读')) && msgs2.some((m) => m.includes('不可读'));
  })());
  check('凭据库诊断: 命中条目但全被过滤 → 汇总诊断给出分类计数', (() => {
    const store = tmpFile('credstore-allfiltered.json', JSON.stringify({
      'account-provider:coding-plan:account:p1:account:1:api-key': 'enc:v1:AAAA.BBBB.CCCC',
      'account-provider:coding-plan:account:p2:account:2:api-key': 'enc:v1:DDDD.EEEE.FFFF',
    }));
    const msgs = [];
    const list = credStore.readStoredApiKeys(store, { onDiagnostic: (m) => msgs.push(m) });
    return list.length === 0 && msgs.some((m) => m.includes('全部被过滤') && m.includes('解密失败 2'));
  })());
  check('凭据库: keyIdOf 段数不足 → unknown（不抛）', (() => {
    const store = tmpFile('credstore-shortkey.json', JSON.stringify({ 'account-provider:coding-plan:account:api-key': enc }));
    const list = credStore.readStoredApiKeys(store);
    return list.length === 1 && list[0].id === 'unknown';
  })());
  check('凭据库: keyFingerprint 不含完整 key', (() => {
    const k = mkKey('a');
    const fp = credStore.keyFingerprint(k);
    return !fp.includes(k) && fp.includes('***');
  })());

  /* 真实网关契约（2026-10-01 实测，**本组断言的核心**）：
   * 失效 key 也返回 HTTP 200，body = {"code":1000,"msg":"身份验证失败。","success":false}。
   * 有效 key 返回 HTTP 200 + {"data":[...非空...]}。
   * 故 validateApiKey 必须验体，不能只看 res.ok —— 假 fetch 也必须按此契约构造。 */
  const okModelsRes = () => ({ ok: true, json: async () => ({ data: [{ id: 'glm-5.3' }] }) });
  const authFailRes = () => ({ ok: true, json: async () => ({ code: 1000, msg: '身份验证失败。', success: false }) });
  const http401Res = () => ({ ok: false, status: 401, json: async () => ({ error: { type: '1000' } }) });

  check('验活: HTTP 200 + data 非空 → 有效', await credential.validateApiKey('x'.repeat(49), 'https://e.test', { fetchFn: async () => okModelsRes() }));
  check('验活: HTTP 200 但 body code:1000（认证失败）→ 无效（**防 200 假绿**）', (await credential.validateApiKey('x'.repeat(49), 'https://e.test', { fetchFn: async () => authFailRes() })) === false);
  check('验活: HTTP 401 → 无效', (await credential.validateApiKey('x'.repeat(49), 'https://e.test', { fetchFn: async () => http401Res() })) === false);
  check('验活: data 为空数组 → 无效', (await credential.validateApiKey('x'.repeat(49), 'https://e.test', { fetchFn: async () => ({ ok: true, json: async () => ({ data: [] }) }) })) === false);
  check('验活: 网络异常 → 无效（绝不抛）', (await credential.validateApiKey('x'.repeat(49), 'https://e.test', { fetchFn: async () => { throw new Error('boom'); } })) === false);

  // resolvePlanCredential 的验活回退（注入假 fetch，零网络）
  check('回退: config 验活通过 → source=config（不读凭据库）', await (async () => {
    const cfgPath = tmpFile('rb-cfg-ok.json', fixtureConfig());
    const calls = [];
    const r = await credential.resolvePlanCredential(cfgPath, undefined, {
      fetchFn: async (url) => { calls.push(url); return okModelsRes(); },
    });
    return r.source === 'config' && calls.length === 1;
  })());
  check('回退: config 验活失败 + 凭据库候选有效 → source=store', await (async () => {
    const cfgPath = tmpFile('rb-cfg-bad.json', fixtureConfig());
    const store = tmpFile('rb-store.json', JSON.stringify({ 'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': enc }));
    let n = 0;
    const r = await credential.resolvePlanCredential(cfgPath, undefined, {
      storePath: store,
      // 第 1 次(config) → 200 但认证失败；第 2 次(store) → 200 + data
      fetchFn: async () => { n += 1; return n === 1 ? authFailRes() : okModelsRes(); },
    });
    return r.source === 'store' && r.apiKey === storedKey && n === 2;
  })());
  check('回退: 凭据库 account id 解析（键为 7 段 ...:account:<planId>:account:<id>:api-key）', (() => {
    const store = tmpFile('rb-id.json', JSON.stringify({ 'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:12345678901234567:api-key': enc }));
    const list = credStore.readStoredApiKeys(store);
    return list.length === 1 && list[0].id === 'bigmodel-individual-coding-plan';
  })());
  check('回退: config 与凭据库都失败 → 沿用 config 原值（不抛、不引入新失败面）', await (async () => {
    const cfgPath = tmpFile('rb-cfg-bad2.json', fixtureConfig());
    const store = tmpFile('rb-store-bad.json', JSON.stringify({ 'account-provider:coding-plan:account:p:account:1:api-key': enc }));
    const r = await credential.resolvePlanCredential(cfgPath, undefined, {
      storePath: store,
      fetchFn: async () => http401Res(),
    });
    return r.source === 'config' && r.apiKey === fakeKey;
  })());
  check('回退: 凭据库为空 → 沿用 config 原值', await (async () => {
    const cfgPath = tmpFile('rb-cfg-bad3.json', fixtureConfig());
    const r = await credential.resolvePlanCredential(cfgPath, undefined, {
      storePath: join(tmp, 'no-store.json'),
      fetchFn: async () => http401Res(),
    });
    return r.source === 'config';
  })());
  check('回退: 诊断回调不泄漏 key 原文', await (async () => {
    const cfgPath = tmpFile('rb-cfg-bad4.json', fixtureConfig());
    const store = tmpFile('rb-store-ok2.json', JSON.stringify({ 'account-provider:coding-plan:account:p2:account:2:api-key': enc }));
    const msgs = [];
    let n = 0;
    await credential.resolvePlanCredential(cfgPath, undefined, {
      storePath: store,
      onDiagnostic: (m) => msgs.push(m),
      fetchFn: async () => { n += 1; return n === 1 ? authFailRes() : okModelsRes(); },
    });
    const joined = msgs.join(' ');
    return msgs.length > 0 && !joined.includes(fakeKey) && !joined.includes(storedKey);
  })());
  /* 逃生口：fallback:false 时**不读凭据库**（与 zcode-run.mjs 的 --no-cred-fallback 同义）。
   * 便于排查"到底是 config 还是库在起作用"，也供不愿读加密存储的部署选择。 */
  check('回退: fallback=false → 不读凭据库，直接用 config 原值', await (async () => {
    const cfgPath = tmpFile('rb-nofb-cfg.json', fixtureConfig());
    const store = tmpFile('rb-nofb-store.json', JSON.stringify({ 'account-provider:coding-plan:account:p3:account:3:api-key': enc }));
    let calls = 0;
    const r = await credential.resolvePlanCredential(cfgPath, undefined, {
      storePath: store,
      fallback: false,
      fetchFn: async () => { calls += 1; return authFailRes(); },
    });
    // 只验活 config 一次（不进入凭据库候选循环）
    return r.source === 'config' && r.apiKey === fakeKey && calls === 1;
  })());
}

// ─── 2. 开关（§3.2，三种态） ─────────────────────────────────────────────────
{
  const on = tmpFile('switch-on.json', JSON.stringify({ enabled: true }));
  const off = tmpFile('switch-off.json', JSON.stringify({ enabled: false, updatedBy: 'selfcheck' }));
  const missingPath = join(tmp, 'switch-missing.json');
  const corrupt = tmpFile('switch-corrupt.json', 'not-json{{');
  check('开关: enabled:true → 开', sw.readDispatchSwitch(on).enabled === true);
  check('开关: enabled:false → 关', sw.readDispatchSwitch(off).enabled === false);
  check('开关: 缺文件 → 开', sw.readDispatchSwitch(missingPath).enabled === true);
  check('开关: 损坏文件 → 开', sw.readDispatchSwitch(corrupt).enabled === true);
  let frozen = null;
  try {
    sw.assertSwitchEnabled(off);
  } catch (e) {
    frozen = e;
  }
  check('开关: 关闭时断言抛 SwitchFrozenError（规定文案）', frozen?.name === 'SwitchFrozenError' && frozen.message.includes('派发总开关已关闭：套餐冻结中（含 provider 通道）'));
  check('开关: 开启时断言放行', sw.assertSwitchEnabled(on).enabled === true);
}

// ─── 3. 台账（§3.3） ─────────────────────────────────────────────────────────
{
  const ledgerPath = join(tmp, 'zcode-runs.jsonl');
  writeFileSync(ledgerPath, '{"ts":"2026-10-01T00:00:00.000Z","tag":"T0","billing":"zcode-plan","channel":"dispatch"}\n', 'utf8');
  cleanupFiles.push(ledgerPath);
  ledger.appendProviderRun({ model: 'glm-5.3', endpoint: 'https://example.test/api/anthropic', input: 10, output: 3, exit: 0, elapsedMs: 5 }, ledgerPath);
  ledger.appendProviderRun({ model: 'glm-5.3', endpoint: 'https://example.test/api/anthropic', exit: `error: boom ${fakeKey}` }, ledgerPath);
  const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
  check('台账: 追加写不重写（3 行）', lines.length === 3, `lines=${lines.length}`);
  const row = JSON.parse(lines[1]);
  check(
    '台账: 字段齐且 channel=provider',
    row.billing === 'zcode-plan' && row.provider === 'zcode' && row.channel === 'provider' && row.endpoint === 'https://example.test/api/anthropic' &&
      row.model === 'glm-5.3' && row.input === 10 && row.output === 3 && row.exit === 0 && typeof row.ts === 'string',
    JSON.stringify(row)
  );
  const failRow = JSON.parse(lines[2]);
  check('台账: 失败行 exit=错误摘要且零明文', String(failRow.exit).startsWith('error: boom') && !JSON.stringify(failRow).includes(fakeKey) && failRow.exit.includes('<REDACTED>'), String(failRow.exit));
  check('台账: sanitizeErrorSummary 脱敏 zhipu 形态', ledger.sanitizeErrorSummary(`x ${fakeKey} y`) === 'x <REDACTED> y');
}

// ─── 4. 官方元数据层 + 5.3 系过滤 + 静态目录（T22 §1.5-1/2/3/5） ─────────────
{
  // ZCode config models 段 fixture（T22 §0.2 原样形态；key 大写与网关 id 不同）。
  const metaConfig = tmpFile(
    'zcode-meta.json',
    JSON.stringify({
      provider: {
        'builtin:bigmodel-coding-plan': {
          enabled: true,
          options: { apiKey: fakeKey, baseURL: 'https://example.test/api/anthropic' },
          models: {
            'GLM-5.3': {
              reasoning: { enabled: true, variants: ['low', 'max', 'high'], defaultVariant: 'max' },
              limit: { context: 1000000, output: 128000 },
              modalities: { input: ['text'], output: ['text'] },
            },
            'GLM-5.3-Flash': {
              reasoning: { enabled: true, variants: ['low', 'max', 'high'], defaultVariant: 'max' },
              limit: { context: 1000000, output: 128000 },
              modalities: { input: ['text', 'image', 'video'], output: ['text'] },
            },
          },
        },
      },
    })
  );
  const officialMeta = modelMeta.readOfficialMeta(metaConfig);
  check(
    '官方: readOfficialMeta 归一（key 小写 + context/output/variants/defaultVariant/input）',
    officialMeta['glm-5.3']?.context === 1000000 && officialMeta['glm-5.3']?.output === 128000 &&
      JSON.stringify(officialMeta['glm-5.3']?.reasoningVariants) === '["low","max","high"]' && officialMeta['glm-5.3']?.defaultVariant === 'max' &&
      JSON.stringify(officialMeta['glm-5.3-flash']?.input) === '["text","image","video"]',
    JSON.stringify(officialMeta)
  );
  check('官方: 零明文——返回值不含 key 也不含 options 段（只读 models）', !JSON.stringify(officialMeta).includes(fakeKey) && !JSON.stringify(officialMeta).includes('"options"'));
  check(
    '官方: 缺文件/坏 JSON/缺 models 段 → {}（绝不抛）',
    JSON.stringify(modelMeta.readOfficialMeta(join(tmp, 'nope.json'))) === '{}' &&
      JSON.stringify(modelMeta.readOfficialMeta(tmpFile('meta-bad.json', 'not-json{{'))) === '{}' &&
      JSON.stringify(modelMeta.readOfficialMeta(tmpFile('meta-nomodels.json', fixtureConfig({}, false)))) === '{}'
  );
  const noCtx = tmpFile(
    'meta-noctx.json',
    JSON.stringify({ provider: { 'builtin:bigmodel-coding-plan': { enabled: true, options: { apiKey: fakeKey, baseURL: 'https://x.test' }, models: { 'glm-x': { reasoning: { variants: ['low'] } } } } } })
  );
  check('官方: 缺正整数 context 的条目不收编（宁按无官方数据处理，不虚构数字）', JSON.stringify(modelMeta.readOfficialMeta(noCtx)) === '{}');

  check(
    '过滤: 5.3 系显式集合判定（大小写不敏感；不含 glm-5.2 / glm-5.3-pro / 非字符串）',
    modelMeta.isGlm53Family('GLM-5.3-FLASHX') === true && modelMeta.isGlm53Family('glm-5.2') === false &&
      modelMeta.isGlm53Family('glm-5.3-pro') === false && modelMeta.isGlm53Family(42) === false && modelMeta.isGlm53Family(undefined) === false
  );
  const gateway11 = ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-air'].map((id) => ({ id }));
  check(
    '过滤: 网关 11 → 5.3 系 3（显式集合；大小写不敏感放行 GLM-5.3-FlashX）',
    modelMeta.filterGlm53Family(gateway11).length === 3 &&
      modelMeta.filterGlm53Family([{ id: 'GLM-5.3-FlashX' }, { id: 'glm-5.2' }]).map((r) => r.id).join(',') === 'GLM-5.3-FlashX'
  );
  check('过滤: 非数组输入 → 空数组（防御）', modelMeta.filterGlm53Family(null).length === 0 && modelMeta.filterGlm53Family('glm-5.3').length === 0);

  check('目录: 静态表裁剪为 5.3 系 3 项（与 model-meta GLM53_FAMILY 同序）', discovery.STATIC_MODEL_IDS.length === 3 && JSON.stringify(discovery.STATIC_MODEL_IDS) === JSON.stringify(modelMeta.GLM53_FAMILY), discovery.STATIC_MODEL_IDS.join(','));
  const rows = discovery.staticCatalog(officialMeta, 200000);
  check(
    '目录: 静态事实行每行正整数 contextWindow/maxTokens + 官方徽标 2 枚',
    rows.length === 3 && rows.every((r) => Number.isInteger(r.contextWindow) && r.contextWindow > 0 && Number.isInteger(r.maxTokens) && r.maxTokens > 0 && r.id && r.name) &&
      rows.filter((r) => r.official === true).length === 2
  );
  /* 静态表必须带展示名（= 网关 display_name 实测值）：state.lastCatalog 初始化为静态表，
   * 而动态发现是懒加载 —— 若静态表只有裸 id，面板在首次发现前会显示 `glm-5.3` 而非 `GLM-5.3`。 */
  check(
    '目录: 静态行 name 为展示名（非裸 id），与网关 display_name 一致',
    rows.every((r) => typeof r.name === 'string' && r.name !== r.id) &&
      rows.find((r) => r.id === 'glm-5.3')?.name === 'GLM-5.3' &&
      rows.find((r) => r.id === 'glm-5.3-flash')?.name === 'GLM-5.3-Flash' &&
      rows.find((r) => r.id === 'glm-5.3-flashx')?.name === 'GLM-5.3-FlashX',
    rows.map((r) => `${r.id}=${r.name}`).join(', ')
  );

  const catalog = modelMeta.buildCatalog(
    [
      { id: 'glm-5.3' },
      { id: 'glm-5.3-flash', display_name: 'GLM-5.3-Flash' },
      { id: 'glm-5.3-flashx', display_name: 'GLM-5.3-FlashX' },
      { id: 'glm-5.2' },
    ],
    officialMeta,
    200000
  );
  const row53 = catalog.find((r) => r.id === 'glm-5.3');
  const rowFlash = catalog.find((r) => r.id === 'glm-5.3-flash');
  const rowFlashX = catalog.find((r) => r.id === 'glm-5.3-flashx');
  check(
    '合并: 官方命中 → official + 默认 200K + 官方 Max 档 1M + 推理档锁定（low/max/high）',
    row53?.official === true && row53?.contextWindow === 200000 && row53?.maxContextWindow === 1000000 &&
      JSON.stringify(row53?.reasoningEfforts) === '{"low":"light","max":"high","high":"high"}',
    JSON.stringify(row53)
  );
  check('合并: name ← 网关 display_name（缺失回退 id）', row53?.name === 'glm-5.3' && rowFlash?.name === 'GLM-5.3-Flash');
  check('合并: Flash 官方 input 含 image/video（锁定，原样保留官方声明）', JSON.stringify(rowFlash?.input) === '["text","image","video"]');
  check(
    '合并: FlashX 无官方 → 默认 200K/无 1M 档/无推理档/input 纯文本（T22 §1.5-3）',
    rowFlashX?.official === false && rowFlashX?.contextWindow === 200000 && rowFlashX?.maxContextWindow === undefined &&
      rowFlashX?.reasoningEfforts === undefined && JSON.stringify(rowFlashX?.input) === '["text"]',
    JSON.stringify(rowFlashX)
  );
  /* 5.3 系过滤的**真实契约**：过滤发生在目录层（discoverModels 的 filterGlm53Family /
   * 静态表 STATIC_MODEL_IDS = GLM53_FAMILY），buildCatalog 是纯合并（假定已过滤输入）。
   * 故此处断言过滤函数本身 + 经 discoverModels 的端到端行为，而非要求 buildCatalog 过滤。 */
  check(
    '过滤: filterGlm53Family 剔除非 5.3 系（glm-5.2 不出现），恰 3 行',
    (() => {
      const filtered = modelMeta.filterGlm53Family([
        { id: 'glm-5.3' },
        { id: 'GLM-5.3-Flash' }, // 大小写不敏感
        { id: 'glm-5.3-flashx' },
        { id: 'glm-5.2' },
        { id: 'glm-5.1' },
      ]);
      return filtered.length === 3 && filtered.some((r) => r.id === 'glm-5.2') === false;
    })()
  );
  check(
    '过滤: discoverModels 端到端只回 5.3 系（网关给 11 个含 glm-5.2/glm-5.1）',
    await (async () => {
      const gwBody = {
        data: [
          ...modelMeta.GLM53_FAMILY.map((id) => ({ id, display_name: id })),
          { id: 'glm-5.2' },
          { id: 'glm-5.1' },
          { id: 'glm-4.5' },
        ],
      };
      const rows = await discovery.discoverModels(
        { baseURL: 'https://example.test/api/anthropic', apiKey: fakeKey },
        {
          officialMeta: modelMeta.readOfficialMeta(tmpFile('meta-gw.json', fixtureConfig())),
          fetchFn: async () => ({ ok: true, json: async () => gwBody }),
        }
      );
      return rows.length === 3 && rows.some((r) => r.id === 'glm-5.2') === false && rows.every((r) => Number.isInteger(r.contextWindow));
    })()
  );
  check('红线: buildCatalog 每行必有正整数 contextWindow（INVALID_MODEL_CONTEXT）', catalog.every((r) => Number.isInteger(r.contextWindow) && r.contextWindow > 0));

  check('开关: 非官方行图片可开（override.image=true → 含 image）', JSON.stringify(modelMeta.applyImageSelection(catalog, { 'glm-5.3-flashx': { image: true } }).find((r) => r.id === 'glm-5.3-flashx')?.input) === '["text","image"]');
  check(
    '开关: 官方行忽略图片覆盖（GLM-5.3 强塞 image 不生效；Flash 官方模态剥不掉）',
    JSON.stringify(modelMeta.applyImageSelection(catalog, { 'glm-5.3': { image: true } }).find((r) => r.id === 'glm-5.3')?.input) === '["text"]' &&
      JSON.stringify(modelMeta.applyImageSelection(catalog, { 'glm-5.3-flash': {} }).find((r) => r.id === 'glm-5.3-flash')?.input) === '["text","image","video"]'
  );
  const onReasoning = modelMeta.applyReasoningSelection(catalog, { 'glm-5.3-flashx': { reasoning: true } });
  check(
    '开关: 非官方行推理开 → 单档 wire 枚举 high；官方行推理档不受覆盖影响',
    JSON.stringify(onReasoning.find((r) => r.id === 'glm-5.3-flashx')?.reasoningEfforts) === '{"high":"high"}' &&
      JSON.stringify(onReasoning.find((r) => r.id === 'glm-5.3')?.reasoningEfforts) === '{"low":"light","max":"high","high":"high"}'
  );
  check('开关: 推理默认关（无 override → 非官方行无 reasoningEfforts）', modelMeta.applyReasoningSelection(catalog, {}).find((r) => r.id === 'glm-5.3-flashx')?.reasoningEfforts === undefined);

  const budgeted = modelMeta.applyContextBudgets(
    modelMeta.applyReasoningSelection(modelMeta.applyImageSelection(catalog, {}), {}),
    { 'glm-5.3': 1000000, 'glm-5.3-flashx': 1000000, 'glm-5.3-flash': 999999 }
  );
  check('预算: 官方 Max 档勾选 1M 生效（GLM-5.3 → 1000000，T22 §1.5-4）', budgeted.find((r) => r.id === 'glm-5.3')?.contextWindow === 1000000);
  check('预算: 非官方 Max 档写入被忽略（FlashX 无档；Flash 非 Max 值 → 保持 200K）', budgeted.find((r) => r.id === 'glm-5.3-flashx')?.contextWindow === 200000 && budgeted.find((r) => r.id === 'glm-5.3-flash')?.contextWindow === 200000);
  check('红线: 预算管线末端每行仍正整数 contextWindow', budgeted.every((r) => Number.isInteger(r.contextWindow) && r.contextWindow > 0));

  check(
    '发现: extractModels 提取 display_name（三种形态兼容；缺失回退 id）',
    JSON.stringify(discovery.extractModels({ data: [{ id: 'a', display_name: 'A' }, { id: 'b' }] })) === '[{"id":"a","name":"A"},{"id":"b","name":"b"}]' &&
      JSON.stringify(discovery.extractModels(['c'])) === '[{"id":"c","name":"c"}]' &&
      JSON.stringify(discovery.extractModels({ models: ['d'] })) === '[{"id":"d","name":"d"}]'
  );
  /* S-05：extractModelIds 已作为死代码删除（生产零调用方），此处断言它确实不再导出 ——
   * 防止将来有人"顺手加回来"又变成没人用的 API。 */
  check('发现: 死代码 extractModelIds 已移除（S-05）', discovery.extractModelIds === undefined);
  const cred = { apiKey: fakeKey, baseURL: 'https://example.test/api/anthropic' };
  const rows2 = await discovery.discoverModels(cred, { officialMeta, baseContextWindow: 200000, fetchFn: async () => ({ ok: false }) });
  check('发现: HTTP 非 200 回退静态表（3 行 5.3 系）', rows2.length === 3 && rows2[0].contextWindow === 200000, `rows=${rows2.length}`);
  const rows3 = await discovery.discoverModels(cred, { officialMeta, fetchFn: async () => { throw new Error('NETWORK FORBIDDEN'); } });
  check('发现: 网络异常回退静态表', rows3.length === 3);
  const rows4 = await discovery.discoverModels(cred, {
    officialMeta,
    fetchFn: async (url, init) => {
      if (!init.headers['x-api-key'] || !init.headers['anthropic-version']) throw new Error('missing headers');
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'glm-5.2' }, { id: 'GLM-5.3-Flash', display_name: 'GLM-5.3-Flash' }, { id: 'glm-5.3-flashx' }, { id: 'glm-5.3-pro' }] }),
      };
    },
  });
  check(
    '发现: 200 时 5.3 系过滤（大小写不敏感合并官方）+ display_name',
    rows4.length === 2 && rows4[0].id === 'GLM-5.3-Flash' && rows4[0].name === 'GLM-5.3-Flash' && rows4[0].official === true && rows4[0].maxContextWindow === 1000000 && rows4[1].id === 'glm-5.3-flashx',
    JSON.stringify(rows4)
  );
  const rows5 = await discovery.discoverModels(cred, { officialMeta, fetchFn: async () => ({ ok: true, json: async () => ({ data: [{ id: 'glm-9.9' }] }) }) });
  check('发现: 目录无 5.3 系（过滤后为空）→ 回退静态表', rows5.length === 3);
}

// ─── 5. 并发预算与流拦截记账（§3.4 N=2） ─────────────────────────────────────
{
  const sem = new Semaphore(2);
  await sem.acquire();
  await sem.acquire();
  let thirdResolved = false;
  const third = sem.acquire().then(() => {
    thirdResolved = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  check('信号量: 上限 2，第 3 个 acquire 排队', thirdResolved === false);
  sem.release();
  await third;
  check('信号量: release 后放行', thirdResolved === true);
  sem.release();

  const taps = [];
  const rec = (info) => taps.push(info);
  // fixture 镜像真实 pi-ai 形态（T20 实证）：stream/streamSimple 是同步函数，返回事件流（trae 侧 for await 直接消费）。
  const rawApi = {
    stream(model) {
      return (async function* () {
        yield { type: 'message_start' };
        yield { type: 'usage', input_tokens: 11, output_tokens: 4 };
      })();
    },
    streamSimple(model) {
      throw new Error('wire failed');
    },
  };
  const wrapped = instrumentApi(rawApi, { semaphore: new Semaphore(2), record: rec });
  const seen = [];
  for await (const ev of wrapped.stream({ id: 'glm-5.3', baseUrl: 'https://example.test/api/anthropic' })) seen.push(ev.type);
  check('拦截: 流完成记一次账且 usage 提取', seen.length === 2 && taps.length === 1 && taps[0].exit === 0 && taps[0].input === 11 && taps[0].output === 4 && taps[0].model === 'glm-5.3', JSON.stringify(taps[0]));
  let threw = null;
  try {
    wrapped.streamSimple({ id: 'glm-5.3', baseUrl: 'https://example.test/api/anthropic' });
  } catch (e) {
    threw = e;
  }
  check('拦截: 同步失败路径记账错误摘要（不占预算）', threw?.message === 'wire failed' && taps.length === 2 && String(taps[1].exit).includes('wire failed'));

  taps.length = 0;
  const early = wrapped.stream({ id: 'glm-5.3', baseUrl: 'https://example.test/api/anthropic' });
  const it = early[Symbol.asyncIterator]();
  await it.next();
  await it.return();
  check('拦截: 提前 return 也记账（aborted）', taps.length === 1 && String(taps[0].exit).includes('aborted'), JSON.stringify(taps[0]));

  /* R-03：中止必须**向内层传播 return()**（迭代协议义务）。
   * 原实现只 finish() 不关内层 ⇒ 上游继续生成、额度继续消耗而台账只记 aborted(usage=null)。 */
  {
    let innerClosed = false;
    const innerStream = () => (async function* () {
      try {
        yield { type: 'text' };
        yield { type: 'text' };
      } finally {
        innerClosed = true;
      }
    })();
    const taps3 = [];
    const w3 = instrumentApi({ stream: () => innerStream(), streamSimple: () => innerStream() },
      { semaphore: new Semaphore(2), record: (r) => taps3.push(r) });
    for await (const _ of w3.stream({ id: 'glm-5.3', baseUrl: 'https://example.test/api/anthropic' })) {
      break; // 消费者提前退出
    }
    await new Promise((r) => setTimeout(r, 30));
    check('拦截: 消费者中止时内层流被关闭（R-03，防额度空烧）', innerClosed === true && taps3.length === 1 && String(taps3[0].exit).includes('aborted'), `innerClosed=${innerClosed} taps=${JSON.stringify(taps3.map((t) => t.exit))}`);
  }

  /* R-04：手动迭代（.next()）必须与 for await 同受预算与记账监管。
   * 原 Proxy 只拦 Symbol.asyncIterator ⇒ 直接 .next() 完全绕过（实测 records=0、active=0）。 */
  {
    const innerStream = () => (async function* () { yield { type: 'text' }; yield { type: 'text' }; })();
    const taps4 = [];
    const sem4 = new Semaphore(2);
    const w4 = instrumentApi({ stream: () => innerStream(), streamSimple: () => innerStream() },
      { semaphore: sem4, record: (r) => taps4.push(r) });
    const manual = w4.stream({ id: 'glm-5.3', baseUrl: 'https://example.test/api/anthropic' });
    let n = 0;
    while (true) {
      const { done } = await manual.next();
      if (done) break;
      n += 1;
    }
    check('拦截: 手动 .next() 迭代也纳入预算与记账（R-04）', n === 2 && taps4.length === 1 && taps4[0].exit === 0 && sem4.active === 0, `n=${n} taps=${taps4.length} active=${sem4.active}`);
  }

  /* R-10：Promise 防御分支显式断言（原为零测试的"防御分支"）。
   * 若 pi-ai 真形态从"同步返回流"变成"返回 Promise<流>"，此分支就是主路径 —— 必须有契约。 */
  {
    const innerStream = () => (async function* () { yield { type: 'usage', input_tokens: 3, output_tokens: 4 }; })();
    const taps5 = [];
    const sem5 = new Semaphore(2);
    const w5 = instrumentApi({ stream: () => Promise.resolve(innerStream()), streamSimple: () => Promise.resolve(innerStream()) },
      { semaphore: sem5, record: (r) => taps5.push(r) });
    const resolved = await w5.stream({ id: 'glm-5.3', baseUrl: 'https://example.test/api/anthropic' });
    check('拦截: promise 形态分支记账一次且预算归还（R-10 契约化）', taps5.length === 1 && sem5.active === 0 && typeof resolved?.[Symbol.asyncIterator] === 'function', `taps=${taps5.length} active=${sem5.active}`);
  }
}

// ─── 6. manifest / patch / 纪律（§6 验收） ───────────────────────────────────
{
  const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  check('manifest: 名字正确', pkg.name === 'dsh-connect-zcode');
  /* 市场合规（2026-10-10）：发布要求 manifest 自描述 —— name 不带本地私有 scope、
   * version/license/repository 在场、keywords 含 dsh-plugin（生态识别 topic）。 */
  check(
    'manifest: 市场合规字段（name 无 @local 前缀 + license/repository/keywords 标识）',
    !pkg.name.startsWith('@local/') && pkg.license === 'MIT' && typeof pkg.repository?.url === 'string' &&
      (pkg.keywords ?? []).includes('dsh-plugin') && (pkg.keywords ?? []).includes('deepseek-harness'),
    `name=${pkg.name} license=${pkg.license} keywords=${(pkg.keywords ?? []).join(',')}`
  );
  /* T21 防拒启核心断言：dsh.client 与 exports["./client"] 必须同时存在，且入口文件真实存在。
   * 声明了 dsh.client 却缺 lib/client.js（或加载失败）= DSH 拒绝启动（ClientPackageCompositionError，
   * 启动后几秒自行退出）——这对断言是本插件的生命线，任何一侧缺失即 FAIL。 */
  const clientRel = pkg.dsh?.client !== undefined ? pkg.exports?.['./client'] : undefined;
  const clientFile = typeof clientRel === 'string' ? join(PLUGIN_ROOT, clientRel) : undefined;
  check('manifest: dsh.client 与 exports["./client"] 成对存在（防拒启）', pkg.dsh?.client !== undefined && typeof clientRel === 'string', `dsh.client=${JSON.stringify(pkg.dsh?.client ?? null)}`);
  check('manifest: client 入口文件真实存在', !!clientFile && existsSync(clientFile), clientFile ?? '(未声明)');
  check('manifest: client 声明形状（platform web + 非空 inject 列表）', pkg.dsh?.client?.platform === 'web' && Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, JSON.stringify(pkg.dsh?.client?.inject ?? null));
  check('manifest: peerDependencies 声明宿主栈', !!pkg.peerDependencies?.['@earendil-works/pi-ai'] && !!pkg.peerDependencies?.['@deepseek-ai/dsh-llm-pi-ai']);
  const patch = readFileSync(join(PLUGIN_ROOT, 'cordis.patch.yml'), 'utf8');
  check('patch: 含 zcode-connect 与 dsh-connect-zcode', patch.includes('id: zcode-connect') && patch.includes("'dsh-connect-zcode'"));
  /* volatile 标记 tripwire：0.1.7 设置写入门禁要求条目含 volatile 字段，缺了它面板每次写入都被
   * 静默拒绝（trae lib/index.js :4086-4094 实证注释）。schemastery 在开发目录解析不到、无法运行时
   * 断言主路径，故以源码级 tripwire 兜底（防该标记被无意删除）。T22：三个面板写入字段全部要有。 */
  const indexSource = readFileSync(join(PLUGIN_ROOT, 'index.js'), 'utf8');
  check('纪律: enabledModelIds 带 volatile 标记（写入门禁硬前提）', indexSource.includes('enabledModelIds: asVolatile('));
  check('纪律: contextBudgets 带 volatile 标记（T22 写入门禁）', indexSource.includes('contextBudgets: asVolatile('));
  check('纪律: modelOverrides 带 volatile 标记（T22 写入门禁）', indexSource.includes('modelOverrides: asVolatile('));
  check('纪律: 1M 档语义 tripwire（applyContextBudgets 只认官方 Max 档）', indexSource.includes('applyContextBudgets') && indexSource.includes('readOfficialMeta'));

  const jsFiles = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(name) && !p.includes(join('test', ''))) jsFiles.push(p);
    }
  })(PLUGIN_ROOT);
  const staticHostImport = /^[ \t]*import\s[^\n]*['"]@(deepseek-ai|earendil-works)\//m;
  check('纪律: 产物无静态宿主包 import（Z13-1）', jsFiles.every((f) => !staticHostImport.test(readFileSync(f, 'utf8'))), jsFiles.length + ' 个 js 文件');
  /* README 安装告示断言：意图 = README 必须明确「安装会改动宿主配置、需使用者自行确认」，
   * 不得给人以"自动安装/无副作用"的误导。断言匹配多种自然措辞，避免为过测试而扭曲文案。 */
  const readmeText = existsSync(join(PLUGIN_ROOT, 'README.md')) ? readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8') : '';
  check(
    '纪律: README 存在且含安装告示（需使用者确认，非自动安装）',
    readmeText.length > 0 && /(用户批准|自行确认|安装.{0,12}(改动|修改)|需.{0,6}确认)/.test(readmeText),
  );
  check('纪律: README 含设置面板与 enabledModelIds 语义（空 = 全部显示）', readmeText.includes('设置面板') && readmeText.includes('enabledModelIds') && /空\s*=\s*全部显示/.test(readmeText));
  check(
    '纪律: README 含 T22 语义（5.3 系过滤 / max→high 映射 / 官方锁定判定来源 / 1M 实测差异）',
    /5\.3\s*系/.test(readmeText) && readmeText.includes('max→high') && readmeText.includes('ZCode config') && readmeText.includes('200k')
  );
}

// ─── 6.5 过滤语义 + 面板状态文档（T21/T22，纯静态零网络） ────────────────────
{
  const all = discovery.STATIC_MODEL_IDS.map((id) => ({ id }));
  check('过滤: 空集/未配置 = 全量显示（T21 §3.1 关键语义）', discovery.filterByEnabledModels(all, []).length === 3 && discovery.filterByEnabledModels(all, undefined).length === 3);
  const one = discovery.filterByEnabledModels(all, ['glm-5.3']);
  check('过滤: 单选只留 1 项', one.length === 1 && one[0].id === 'glm-5.3', JSON.stringify(one));
  const mixed = discovery.filterByEnabledModels(all, ['no-such-model', 'glm-5.3-flash']);
  check('过滤: 未知 id 静默忽略', mixed.length === 1 && mixed[0].id === 'glm-5.3-flash', JSON.stringify(mixed));
  check('过滤: 非数组输入 = 不过滤（防御）', discovery.filterByEnabledModels(all, 'glm-5.3').length === 3 && discovery.filterByEnabledModels(all, null).length === 3);

  check('回环: Origin 判定（空放行/localhost·127.0.0.1 放行/外域与垃圾拒）', webStatus.originIsLoopback(undefined) === true && webStatus.originIsLoopback('') === true && webStatus.originIsLoopback('http://localhost:5173') === true && webStatus.originIsLoopback('http://127.0.0.1') === true && webStatus.originIsLoopback('http://[::1]:8080') === true && webStatus.originIsLoopback('https://evil.example') === false && webStatus.originIsLoopback('not a url') === false);
  check('回环: Host 判定（含端口剥离）', webStatus.hostIsLoopback('localhost:5173') === true && webStatus.hostIsLoopback('127.0.0.1:3210') === true && webStatus.hostIsLoopback('[::1]:8080') === true && webStatus.hostIsLoopback('evil.example') === false && webStatus.hostIsLoopback(undefined) === false && webStatus.hostIsLoopback('') === false);

  const doc = webStatus.buildStatusDocument({
    registered: () => true,
    readSwitch: () => ({ enabled: false }),
    endpointHost: () => 'open.bigmodel.cn',
    catalog: () => [
      { id: 'glm-5.3', name: 'GLM-5.3', official: true, maxContextWindow: 1000000, input: ['text'], reasoningEfforts: { low: 'light', max: 'high', high: 'high' } },
      { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX', official: false, input: ['text'] },
    ],
    enabledModelIds: () => ['glm-5.3'],
    lastLedger: () => ({ ts: '2026-10-01T00:00:00.000Z', model: 'glm-5.3', exit: 0, input: 1, output: 2, elapsedMs: 3 }),
  });
  check(
    '状态: 文档字段齐且零凭据（端点只出 host，无 key 无 path）',
    doc.providerRegistered === true && doc.frozen === true && doc.endpointHost === 'open.bigmodel.cn' && doc.modelsTotal === 2 &&
      doc.enabledModelIds.join(',') === 'glm-5.3' && doc.enabledCount === 1 &&
      !JSON.stringify(doc).includes('apiKey') && !JSON.stringify(doc).includes('api/anthropic'),
    JSON.stringify(doc)
  );
  const m53 = doc.models.find((m) => m.id === 'glm-5.3');
  const mFlashX = doc.models.find((m) => m.id === 'glm-5.3-flashx');
  check(
    '状态: T22 能力事实（官方徽标/1M 显隐/图片支持/推理档键序）',
    m53?.official === true && m53?.has1m === true && m53?.imageSupported === false && JSON.stringify(m53?.reasoningVariants) === '["low","max","high"]' &&
      mFlashX?.official === false && mFlashX?.has1m === false && mFlashX?.imageSupported === false && mFlashX?.reasoningVariants === undefined,
    JSON.stringify(doc.models)
  );
  const docAll = webStatus.buildStatusDocument({ registered: () => false, readSwitch: () => ({ enabled: true }), endpointHost: () => null, catalog: () => all, enabledModelIds: () => [] });
  check('状态: 空勾选 = enabledCount 等于总数；开关未冻结', docAll.enabledCount === 3 && docAll.modelsTotal === 3 && docAll.frozen === false && docAll.providerRegistered === false && docAll.endpointHost === null);

  const statusLedgerPath = tmpFile(
    'status-ledger.jsonl',
    ['{"channel":"dispatch","model":"decoy"}', `{"ts":"2026-10-01T00:00:00.000Z","channel":"provider","model":"glm-5.3","exit":"error: boom ${fakeKey}","input":1,"output":2,"elapsedMs":5}`, ''].join('\n')
  );
  const row = webStatus.readLastLedgerRow(statusLedgerPath);
  check('状态: 台账摘要取最后 provider 行（跳过 dispatch/空行）且出站脱敏', row?.model === 'glm-5.3' && typeof row.exit === 'string' && row.exit.includes('<REDACTED>') && !row.exit.includes(fakeKey) && row.input === 1 && row.output === 2 && row.elapsedMs === 5, JSON.stringify(row));
  check('状态: 台账缺失/损坏 → null（尽力而为，不炸路由）', webStatus.readLastLedgerRow(join(tmp, 'no-such-ledger.jsonl')) === null && webStatus.readLastLedgerRow(tmpFile('status-ledger-bad.jsonl', 'not json{{')) === null);
}

// ─── 7. 全链路注册（stub 宿主栈 + 假 ctx） ───────────────────────────────────
{
  const stubRoot = join(tmp, 'stub-modules');
  tmpFile(join('stub-modules', '@earendil-works', 'pi-ai', 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', type: 'module', version: '0.0.0-stub' }));
  tmpFile(
    join('stub-modules', '@earendil-works', 'pi-ai', 'dist', 'index.js'),
    'export const createProvider = (input) => { (globalThis.__zcodeCreateProviderInputs ??= []).push(input); return { id: input.id, name: input.name, auth: input.auth, getModels: () => input.models, stream: (m, c, o) => input.api.stream(m, c, o), streamSimple: (m, c, o) => input.api.streamSimple(m, c, o) }; };\n'
  );
  tmpFile(
    join('stub-modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'anthropic-messages.lazy.js'),
    /* R-10：stub 形态必须与 **T20 实测的真实形态**一致 —— 同步函数返回事件流对象。
     * 原 stub 写成 `async stream(...)` ⇒ 返回 Promise<AsyncIterable> ⇒ 命中 instrumentApi 的
     * isPromise 防御分支，而注释声称"绝不能返回 Promise"。两种说法并存且 promise 分支零断言，
     * 若真形态随 pi-ai 升级变成 Promise，并发预算与记账会整体静默失效而无测试报警。
     * 现改为同步方法（与注释真实形态一致），promise 分支另由下面的显式断言覆盖。 */
    'export const anthropicMessagesApi = () => ({ stream() { return (async function* () { yield { type: "usage", input_tokens: 1, output_tokens: 1 }; })(); }, streamSimple() { return { type: "usage", input_tokens: 2, output_tokens: 2 }; } });\n'
  );
  tmpFile(join('stub-modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', type: 'module', version: '0.0.0-stub' }));
  tmpFile(
    join('stub-modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'),
    'export class PiAiAdapter { constructor(options) { this.options = options; } }\n'
  );
  tmpFile(join('stub-modules', '@deepseek-ai', 'dsh-llm', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', type: 'module', version: '0.0.0-stub' }));
  tmpFile(
    join('stub-modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'),
    /* `LlmAdapter` / `LlmError` 是 app-server 通道的接线契约（DSH `registerAdapter` 收的是
     * LlmAdapter 子类实例）；stub 必须同形，否则那条注册路径在自检里走不到（永久假绿）。 */
    'export const resolveRetryPolicy = () => ({ stub: true });\n' +
      'export class LlmAdapter {}\n' +
      'export class LlmError extends Error { constructor(message, code) { super(message); this.name = "LlmError"; this.code = code; } }\n'
  );

  const credPath = tmpFile('live-cred.json', fixtureConfig());
  const switchPath = tmpFile('live-switch.json', JSON.stringify({ enabled: true }));
  const ledgerPath = join(tmp, 'live-ledger.jsonl');
  cleanupFiles.push(ledgerPath);

  process.env.ZCODE_CONNECT_MODULES_ROOT = stubRoot;
  const index = await import('../index.js');

  /* Config schema 断言（迁移后修正）：
   * 插件设计是「首选 schemastery，解析不到时降级手写」（index.js:66-93，与 zcode-dispatch 同款）。
   * 因此本项**不能**无条件断言主路径 —— 它取决于 `@deepseek-ai/schemastery` 是否恰好可从
   * 本包所在目录解析到（link 插件在 profile 的 node_modules 内可解析；独立目录下不可）。
   * 正确断言：两条路径都必须产出合法 Standard Schema v1；**并如实报告走了哪条**，
   * 便于真实安装后核验主路径是否生效。 */
  const cfgVendor = index.Config?.['~standard']?.vendor;
  const cfgValid = typeof index.Config?.['~standard']?.validate === 'function';
  check(
    'Config: Standard Schema v1（schemastery 主路径或手写降级均可）',
    cfgValid && (cfgVendor === 'schemastery' || cfgVendor === 'dsh-connect-zcode-fallback'),
    `vendor=${cfgVendor}${cfgVendor === 'dsh-connect-zcode-fallback' ? '（本目录解析不到 schemastery，走降级；装进 profile 后应为 schemastery）' : ''}`,
  );

  /* ⚠️ 绊线：schemastery API 面必须真实存在（2026-10-01 真机事故）。
   * 事故链：写了 `z.enum([...])` → schemastery 3.18.4 **没有 Schema.enum** → 构造时抛
   * TypeError → 被 loadConfig 的 catch 吞掉 → 静默降级手写 schema → DSH 判
   * `!isNativeConfigSchema` → 入口 status=unsupported → **插件整体不激活**
   * （provider 消失、面板状态路由 404）。
   * 为何自检原本抓不到：本目录解析不到 schemastery → 走降级 → `.enum` 那行**根本不执行**。
   * 故这里做**静态 API 面断言**：index.js 里出现的每个 `z.<method>(` 都必须在实测白名单内。
   * 白名单来源：asar 抽取真实 schemastery 3.18.4 后逐个 `typeof Schema[m]` 实测。 */
  {
    /* 白名单 = 真实 schemastery 3.18.4 静态方法（asar 抽取后 Object.getOwnPropertyNames 实测）：
     * extend resolve from lazy natural percent date regExp arrayBuffer is any never const string
     * number boolean bitset function array dict tuple object union intersect transform
     * 事故里用的 `enum` **不在其中**。 */
    const REAL_SCHEMASTERY_API = ['extend', 'resolve', 'from', 'lazy', 'natural', 'percent', 'date', 'regExp', 'arrayBuffer', 'is', 'any', 'never', 'const', 'string', 'number', 'boolean', 'bitset', 'function', 'array', 'dict', 'tuple', 'object', 'union', 'intersect', 'transform'];
    const src = readFileSync(join(PLUGIN_ROOT, 'index.js'), 'utf8');
    /* 必须先剥注释：本文件的注释里就写着「写成 z.enum(...) 会抛」的说明文字，
     * 不剥会把注释当代码 → 误报。 */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\s+/g, ' ');
    /* 允许 `z .union(` 这种换行链式写法（源码里 z 与 .method 常分行）。 */
    const used = new Set([...code.matchAll(/\bz\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
    const bogus = [...used].filter((m) => !REAL_SCHEMASTERY_API.includes(m));
    check(
      'Config: 只用真实存在的 schemastery API（防 enum 类静默降级）',
      bogus.length === 0,
      bogus.length ? `不存在的方法: ${bogus.join(', ')}（会导致静默降级→DSH status=unsupported）` : `used=${[...used].join(',')}`
    );
    /* 默认推理档的**自动判定**必须真的接在 profile 构造与目录重导两处
     * （只写函数不接线 = 选择器里的 "Default" 项照旧）。 */
    check(
      '默认推理档: 自动判定接在 profile 构造 + 目录重导两处（panel 保存后即时重算）',
      (src.match(/resolveDefaultReasoningEffort\(cfg\.defaultReasoningEffort, models\)/g) ?? []).length === 2 &&
        /applyDefaultReasoningEffort\(profile,/.test(src) &&
        /delete profile\.reasoning/.test(src)
    );
  }

  const registrations = { adapters: [], discoveries: [], directories: [], createProviderInputs: (globalThis.__zcodeCreateProviderInputs = []) };
  const errors = [];
  const effects = [];
  /* 捕获插件全部 console.warn（DE-04 形状自检 / 各处诊断日志的断言依据）。
   * 常驻到本段结束——比逐点打桩更省，且不会漏掉异步激活期的日志。 */
  const warns = [];
  console.warn = (...args) => {
    warns.push(args.map(String).join(' '));
    REAL_WARN(...args); // 透传：诊断日志仍应可见（自检输出即证据）
  };
  /* 同时捕获 console.log（DE-04 的宿主栈版本行走 log，非 warn）。
   * ⚠️ 必须**透传**给真实 console.log：check() 自身就是用 console.log 打印 PASS/FAIL 的，
   * 若只入队不转发，本段约 47 条断言的结果行会整体消失（测试看似全绿但输出缺行）。 */
  const logs = [];
  console.log = (...args) => {
    logs.push(args.map(String).join(' '));
    REAL_LOG(...args);
  };
  const fakeCtx = () => ({
    fiber: { entry: { options: { id: 'zcode-connect-selfcheck' } } },
    llm: {
      registerAdapter: (ids, adapter) => {
        registrations.adapters.push({ ids, adapter });
        return () => registrations.adapters.pop();
      },
      registerModelDiscovery: (ns, fn) => {
        registrations.discoveries.push({ ns, fn });
        return () => registrations.discoveries.pop();
      },
      registerConfigurableProviders: (entries) => {
        registrations.directories.push(entries);
        return () => registrations.directories.pop();
      },
    },
    inject: () => {},
    effect: (fn) => {
      const off = fn();
      effects.push(off);
      return off;
    },
    logger: { error: (m) => errors.push(m) },
  });

  const ctx1 = fakeCtx();
  let applyThrew = false;
  try {
    /* credentialFallback: false —— 自检红线（R-01）：关掉凭据库回退，门禁验活失败后沿用
   * fixture 原值（lib/credential.js 的逃生口），**绝不按默认路径读真实 ~/.zcode/v2/credentials.json**。
   * 这不是可选项：默认 true 时 fixture key 验活失败（投毒 fetch 恒抛）会触发回退，
   * 逐把解密并验活真实用户凭据。 */
  index.apply(ctx1, { switchPath, credentialPath: credPath, ledgerPath, credentialFallback: false });
  } catch {
    applyThrew = true;
  }
  check('apply: 同步不抛（激活安全第一）', applyThrew === false);
  const registered = await waitFor(() => registrations.adapters.length === 1 && registrations.discoveries.length === 1 && registrations.directories.length === 1);
  check('注册: 三部曲齐（adapter+discovery+directory）', registered, `errors=${JSON.stringify(errors)}`);
  /* DE-04：C5 形状自检 + 宿主版本日志。
   * ⚠️ 断言必须**双向**：① 无 C5 告警（不误报）；② "自检通过"行在场（自检确实执行了）。
   * 只断言"没有告警"是假绿——那段代码没跑到时同样没有告警（本项目的头号失败模式）。 */
  check(
    'DE-04: C5 形状自检确实执行且健康态零告警（双向断言，防假绿）',
    logs.join(' ').includes('C5 形状自检通过') && !warns.join(' ').includes('C5 形状自检未通过'),
    `logs=${logs.join(' | ').slice(0, 200)}`
  );
  check(
    'DE-04: 启动日志输出宿主栈版本与来源',
    logs.join(' ').includes('宿主 LLM 栈：') && logs.join(' ').includes('pi-ai='),
    logs.join(' ').match(/宿主 LLM 栈：[^\n]{0,120}/)?.[0] ?? '(未见)'
  );
  check('注册: adapter 绑定 provider id zcode', registrations.adapters[0]?.ids?.join(',') === 'zcode');
  /* 附件解析（图片输入必需）：**必须挂在 adapter options 上**。
   * dsh-llm-pi-ai :1857 读 `this.config.resolveAttachments`，而 this.config = PiAiAdapter 的 options。
   * ⚠️ 2026-10-01 事故：曾把它挂到 createProvider 选项 → 静默无效 → 带图请求仍抛
   * 「pi-ai image input requires the durable attachment service」；而当时自检断言的正是
   * createProviderInputs（错位置）⇒ **断言放在错误的位置 = 假绿**。
   * 故此处只断言 adapter options（真实读取点），并顺带锁定 createProvider 侧不承担该职责。 */
  check(
    '适配器: resolveAttachments 挂在 adapter options（图片输入必需；挂 createProvider 会静默无效）',
    typeof registrations.adapters[0]?.adapter?.options?.resolveAttachments === 'function' &&
      registrations.createProviderInputs?.[0]?.resolveAttachments === undefined,
    `adapterOpts=${Object.keys(registrations.adapters[0]?.adapter?.options ?? {}).join(',')} providerKeys=${Object.keys(registrations.createProviderInputs?.[0] ?? {}).join(',')}`
  );
  /* 图片请求预算（2026-10-01 **第二个**真机故障）：profile 缺 requestImagePixelBudget /
   * requestImageMaxBytes 时，pi-ai 的 requestImagePolicy 变成 {maxPixels:undefined,maxBytes:undefined}
   * （`?? {默认}` 因对象本身存在而不生效）⇒ requestImageTarget 算不出目标宽高 ⇒
   * dsh-attachment-local 的 checkedInteger 抛「Image request width must be a positive integer.」。
   * 断言三个预算字段都在 profile（真实读取点）上且为正整数（trae REQUEST_IMAGE_BUDGETS 同款）。 */
  {
    /* 注意：opts 变量在下方才定义，这里用内联表达式取 adapter options（避免 TDZ）。 */
    const p0 = registrations.adapters[0]?.adapter?.options?.profiles?.()?.get('zcode');
    const budgetKeys = ['maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes'];
    const ok = budgetKeys.every((k) => Number.isSafeInteger(p0?.[k]) && p0[k] > 0);
    check(
      '适配器: profile 带图片请求预算（缺则带图请求抛 Image request width must be a positive integer）',
      ok,
      budgetKeys.map((k) => `${k}=${p0?.[k]}`).join(' ')
    );
  }
  check('注册: settingsNs 取 Loader entry id（坑规避）', registrations.discoveries[0]?.ns === 'zcode-connect-selfcheck', registrations.discoveries[0]?.ns);
  const dirEntry = registrations.directories[0]?.[0];
  check('注册: directory 条目形状（declared:false）', dirEntry?.provider === 'zcode' && dirEntry?.displayName === 'ZCode Coding Plan' && dirEntry?.settingsNs === 'zcode-connect-selfcheck' && Array.isArray(dirEntry?.settingsPath) && dirEntry.settingsPath.length === 0 && dirEntry.declared === false);

  const adapter = registrations.adapters[0]?.adapter;
  const opts = adapter?.options;
  check('适配器: profiles 单例 + INERT_AUTH + resolveApiKey', typeof opts?.profiles === 'function' && opts?.profiles() instanceof Map && typeof opts?.resolveApiKey === 'function' && typeof opts?.auth?.credentials?.read === 'function');
  /* 默认推理档（2026-10-01）：默认 'none' → profile 不带 reasoning 字段（零回归）。
   * profile.reasoning → dsh-llm-pi-ai :1820 catalog defaultEffort + :1852 实际请求兜底档；
   * 但 provider 级静态档对"不支持该档的模型"会在 :1848 无条件校验、:1705 throw ——
   * 因此默认必须不设（FlashX 等非推理模型无档位控件，无法自救）。 */
  check('注册: 默认不设 profile.reasoning（none，零回归）', opts?.profiles()?.get('zcode')?.reasoning === undefined, `reasoning=${opts?.profiles()?.get('zcode')?.reasoning}`);
  const resolvedKey = await opts.resolveApiKey('zcode', opts.profiles().get('zcode'));
  check('调用门: 开关开+凭据有效 → 返回 key', resolvedKey === fakeKey);
  writeFileSync(switchPath, JSON.stringify({ enabled: false }), 'utf8');
  const frozenRejected = await assertRejects(opts.resolveApiKey('zcode', {}), /派发总开关已关闭：套餐冻结中（含 provider 通道）/);
  check('调用门: 开关关 → resolveApiKey 抛规定文案（§7.1）', frozenRejected === true);
  check('调用门: key 不出现在任何错误消息', !errors.join(' ').includes(fakeKey));

  /* 网络投毒已在文件顶部（模块导入前）生效；此处只做**绊线断言**，证明投毒确实活着——
   * 否则将来有人误把投毒移除，本节会静默退回"打真实网络"，且测试照样全绿。 */
  check(
    '纪律: 全程 fetch 投毒有效（零真实网络；R-01 破口已封）',
    globalThis.fetch !== REAL_FETCH && (() => { try { globalThis.fetch('https://example.test'); return false; } catch { return true; } })()
  );
  let discoveryRows = null;
  try {
    discoveryRows = await registrations.discoveries[0].fn({}, undefined);
  } finally {
    /* 投毒常驻：不恢复 realFetch（本自检全程禁止真实网络）。 */
  }
  check('发现: 冻结期零网络直接回静态表', Array.isArray(discoveryRows) && discoveryRows.length === 3 && discoveryRows[0].contextWindow === 200000, `rows=${discoveryRows?.length}`);

  /* T22 host 管线：带预算/开关/勾选的第二次注册——校验 provider.models 的 trae 形状输出。
   * 凭据 fixture 无 models 段 → officialMeta = {} → 三行全按「无官方数据」处理，
   * 预算全部无效（无官方 Max 档）→ 这正是「无官方数据时 1M 不生效」的 host 侧实证。 */
  const ctx1b = fakeCtx();
  index.apply(ctx1b, {
    switchPath,
    credentialPath: credPath,
    ledgerPath,
    credentialFallback: false, // R-01 红线：不回退真实凭据库
    contextBudgets: { 'glm-5.3': 1000000, 'glm-5.3-flashx': 1000000 },
    modelOverrides: { 'glm-5.3-flashx': { reasoning: true, image: true }, 'glm-5.3': { image: true } },
    enabledModelIds: [],
  });
  const registered1b = await waitFor(() => registrations.adapters.length === 2 && registrations.discoveries.length === 2);
  const piModels = registered1b ? registrations.adapters[1]?.adapter?.options?.profiles().get('zcode')?.piProvider?.getModels() : null;
  const m53 = piModels?.find((m) => m.id === 'glm-5.3');
  const mFlash = piModels?.find((m) => m.id === 'glm-5.3-flash');
  const mFlashX = piModels?.find((m) => m.id === 'glm-5.3-flashx');
  check('T22 管线: 三行 5.3 系模型注册', Array.isArray(piModels) && piModels.length === 3, `models=${piModels?.length}`);
  /* GLM-5.3 有官方数据（fixture models 段）：官方锁定优先——用户 override 强塞 image
   * 必须被忽略（官方 modalities 声明 text-only），且 1M 预算合法生效（官方 Max 档）。
   * 注意：这与「无官方数据」的 FlashX 形成对照（见下一条断言）。 */
  check(
    'T22 管线: 官方数据锁定优先——GLM-5.3 override 强塞 image 被忽略、1M 预算合法生效',
    JSON.stringify(m53?.input) === '["text"]' &&
      m53?.contextWindow === 1000000 &&
      m53?.reasoning === true &&
      m53?.compat?.supportsReasoningEffort === true,
    JSON.stringify(m53)
  );
  check('T22 管线: FlashX 用户开关开（推理 + 图片）+ 预算无效 + thinkingLevelMap 仅 high 档', mFlashX?.reasoning === true && mFlashX?.compat?.supportsReasoningEffort === true && JSON.stringify(mFlashX?.input) === '["text","image"]' && mFlashX?.contextWindow === 200000 && JSON.stringify(mFlashX?.thinkingLevelMap) === '{"off":null,"minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null}', JSON.stringify(mFlashX));
  check('T22 管线: 每行正整数 contextWindow + api/provider/baseUrl（红线 + trae 形状）', (piModels ?? []).every((m) => Number.isInteger(m?.contextWindow) && m.contextWindow > 0 && m.api === 'anthropic-messages' && m.provider === 'zcode' && typeof m.baseUrl === 'string' && m.baseUrl !== ''));

  /* 默认推理档显式配置场景：defaultReasoningEffort='max' → profile.reasoning='max' 生效；
   * 同时守卫必须 warn 出"不支持该档"的模型（fixture 下 glm-5.3-flash / flashx 无推理元数据 → 受害者）。 */
  {
    const warnings = [];
    const origWarn = console.warn; // = 本段的 warns 收集器，finally 里必须还给它
    console.warn = (msg) => {
      warnings.push(String(msg));
      warns.push(String(msg)); // 同时并入全局收集，DE-04 等断言不受此临时替换影响
      REAL_WARN(msg); // 透传
    };
    try {
      /* 激活是异步的（waitFor 才见注册），桩必须活到 waitFor 之后 —— 守卫在插件激活期运行。 */
      const ctx1c = fakeCtx();
      index.apply(ctx1c, { switchPath, credentialPath: credPath, ledgerPath, credentialFallback: false, defaultReasoningEffort: 'max' });
      const registered1c = await waitFor(() => registrations.adapters.length === 3);
      const prof1c = registered1c ? registrations.adapters[2]?.adapter?.options?.profiles().get('zcode') : null;
      const warnText = warnings.join(' ');
      check(
        '推理档: 显式 max → profile.reasoning=max + 守卫 warn 列出不支持模型',
        prof1c?.reasoning === 'max' &&
          warnText.includes("defaultReasoningEffort='max'") &&
          warnText.includes('glm-5.3-flash'),
        `reasoning=${prof1c?.reasoning} warn=${warnText.slice(0, 120)}`
      );
      /* 自动判定（配置 'none' = 自动）：目标是不让选择器再补 "Default" 项，同时不让不支持该档
       * 的模型请求硬失败 ⇒ **只在"当前暴露模型全都支持"时才设**（从强到弱取第一个）。 */
      const effortModel = (reasoning, map) => ({ reasoning, thinkingLevelMap: map });
      const supportAll = [
        effortModel(true, { low: 'light', high: 'high', max: 'high' }),
        effortModel(true, { low: 'light', high: 'high', max: 'high' }),
      ];
      const withNonReasoning = [...supportAll, effortModel(false, {})];
      const highCeiling = [effortModel(true, { low: 'light', high: 'high', max: null })];
      check(
        '推理档: 自动档判定（全支持→最强；混入非推理/该档为空→不设；显式配置优先；空目录→不设）',
        JSON.stringify(index.resolveDefaultReasoningEffort('none', supportAll)) ===
          JSON.stringify({ level: 'max', reason: 'auto-all-support' }) &&
          JSON.stringify(index.resolveDefaultReasoningEffort('none', withNonReasoning)) ===
            JSON.stringify({ level: 'none', reason: 'auto-unsafe' }) &&
          JSON.stringify(index.resolveDefaultReasoningEffort('none', highCeiling)) ===
            JSON.stringify({ level: 'high', reason: 'auto-all-support' }) &&
          JSON.stringify(index.resolveDefaultReasoningEffort('none', [])) ===
            JSON.stringify({ level: 'none', reason: 'auto-no-models' }) &&
          JSON.stringify(index.resolveDefaultReasoningEffort('low', withNonReasoning)) ===
            JSON.stringify({ level: 'low', reason: 'configured' }),
        JSON.stringify([
          index.resolveDefaultReasoningEffort('none', supportAll),
          index.resolveDefaultReasoningEffort('none', withNonReasoning),
          index.resolveDefaultReasoningEffort('none', highCeiling),
        ])
      );
    } finally {
      console.warn = origWarn;
    }
  }

  /* ── app-server 通道注册（T23）：默认关零回归；开则第二 provider 正确接线 ── */
  {
    const before = registrations.adapters.length; // 前面已注册 3 次（ctx1/ctx1b/ctx1c）
    const ctxOff = fakeCtx();
    index.apply(ctxOff, { switchPath, credentialPath: credPath, ledgerPath, credentialFallback: false });
    await waitFor(() => registrations.adapters.length === before + 1);
    check(
      'appserver: 默认 appServer=false → 不注册第二 provider（零回归）',
      registrations.adapters.length === before + 1 && !registrations.adapters.some((a) => a.ids?.includes('zcode-appserver')),
      `adapters=${registrations.adapters.length}`
    );

    const before2 = registrations.adapters.length;
    const dirsBefore = registrations.directories.length;
    const ctxOn = fakeCtx();
    index.apply(ctxOn, {
      switchPath,
      credentialPath: credPath,
      ledgerPath,
      credentialFallback: false,
      appServer: true,
      zcodeCliPath: process.execPath, // 只为"探测到 CLI"这一步（本段不会真的 spawn）
      appServerModels: ['GLM-5.3-Flash', 'NOT_A_MODEL'],
    });
    const regOn = await waitFor(() => registrations.adapters.length === before2 + 2);
    const appEntry = registrations.adapters.find((a) => a.ids?.includes('zcode-appserver'));
    const appAdapter = appEntry?.adapter;
    check(
      'appserver: 开启后注册第二 provider zcode-appserver',
      regOn === true && appEntry?.ids?.join(',') === 'zcode-appserver',
      `adapters=${registrations.adapters.length} ids=${appEntry?.ids?.join(',')}`
    );
    /* BaseAdapter 接线：原型链上必须出现 LlmAdapter（stub 类名）。
     * 只断言"有 stream 方法"区分不了"填了基类"与"没填"（后者 stream 仍是自有实现）。 */
    const baseProto = Object.getPrototypeOf(Object.getPrototypeOf(appAdapter ?? {}));
    check(
      'appserver: 适配器继承宿主注入的 LlmAdapter 基类（registerAdapter 的契约）',
      appAdapter !== undefined && typeof appAdapter.stream === 'function' && baseProto?.constructor?.name === 'LlmAdapter',
      `proto=${baseProto?.constructor?.name}`
    );
    {
      const models = await appAdapter.listModels('zcode-appserver');
      const resolved = await appAdapter.resolveModel('zcode-appserver', 'GLM-5.3-Flash');
      const unknown = await appAdapter.resolveModel('zcode-appserver', 'NOT_A_MODEL');
      check(
        'appserver: providerInfo / listModels 形状（未知 id 已从目录剔除；inputModalities 只声明 text）',
        appAdapter.providerInfo('zcode-appserver')?.id === 'zcode-appserver' &&
          models.length === 1 && models[0].id === 'GLM-5.3-Flash' &&
          JSON.stringify(models[0].inputModalities) === JSON.stringify(['text'])
      );
      check(
        'appserver: resolveModel 返回正整数 context（不暴露 0/undefined 上下文）',
        Number.isSafeInteger(resolved.context.contextWindow) && resolved.context.contextWindow > 0 &&
          Number.isSafeInteger(resolved.defaultMaxTokens) && resolved.defaultMaxTokens > 0 &&
          JSON.stringify(resolved.inputModalities) === JSON.stringify(['text'])
      );
      check('appserver: resolveModel 对目录外模型也返回合法元数据（不抛）', Number.isSafeInteger(unknown.context.contextWindow) && unknown.id === 'NOT_A_MODEL');
    }
    {
      const dirs = registrations.directories[registrations.directories.length - 1];
      check(
        'appserver: 目录条目两条（zcode + zcode-appserver，同 settingsNs）',
        Array.isArray(dirs) && dirs.length === 2 && dirs[0].provider === 'zcode' &&
          dirs[1].provider === 'zcode-appserver' && dirs[1].settingsNs === 'zcode-connect-selfcheck' &&
          dirs[1].declared === false && dirs[1].settingsPath.length === 0,
        `dirs=${dirs?.map?.((d) => d.provider).join(',')}`
      );
      check('appserver: 目录注册次数与本次 apply 一致（+1）', registrations.directories.length === dirsBefore + 1);
    }

    /* 目录发现必须包含赠送额度行 —— 宿主的图片策略按目录行判能力（2026-10-10 实测：
     * 缺这些行时 attachmentCount=0，用户发的截图在适配器之前就被剥掉）。 */
    {
      writeFileSync(switchPath, JSON.stringify({ enabled: false }), 'utf8');
      const discover = registrations.discoveries[registrations.discoveries.length - 1];
      const rows = await discover.fn({}, undefined);
      const giftRow = rows.find((row) => row?.id === 'GLM-5.3-Flash');
      check(
        'appserver: 目录发现含赠送额度行（图片策略能力源；attachments 缺席 → 如实 text-only）',
        giftRow !== undefined && giftRow.inputModalities?.join(',') === 'text' &&
          rows.some((row) => row?.id === 'glm-5.3-flash') && rows.length === 4,
        `rows=${rows.length} gift=${JSON.stringify(giftRow ?? null)}`
      );
      writeFileSync(switchPath, JSON.stringify({ enabled: true }), 'utf8');
    }

    /* 冻结开关对 app-server 通道同样生效（PROTOCOL §7.1），且**在起子进程之前**拒绝。
     * 语义与既有 zcode 通道一致：抛 SwitchFrozenError（宿主会规范化成终态 error chunk），
     * 而不是自己吐一个 finish —— 两条通道的冻结表现必须一致，否则用户看到两种文案。 */
    writeFileSync(switchPath, JSON.stringify({ enabled: false }), 'utf8');
    const appChunks = [];
    let frozenMsg = '';
    try {
      for await (const chunk of appAdapter.stream({ provider: 'zcode-appserver', model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
        appChunks.push(chunk);
      }
    } catch (err) {
      frozenMsg = err?.message ?? String(err);
    }
    check('appserver: 冻结期 stream 抛 §7.1 文案（与既有 zcode 通道同语义）', /派发总开关已关闭/.test(frozenMsg), frozenMsg);
    check('appserver: 冻结期零产出 chunk', appChunks.length === 0, `chunks=${appChunks.length}`);
    check('appserver: 冻结期未起子进程（gate 在 spawn 之前）', appAdapter.client?.child === undefined);

    /* 服务端请求应答：运行时偏好 / 权限 / 浏览器（均不触发凭据读取）。 */
    const written = [];
    appAdapter.client.write = (msg) => written.push(msg);
    appAdapter._answerServerRequest({ id: 7, method: 'session/requestRuntimePreferences' });
    check(
      'appserver: 运行时偏好应答形状（不回则 agent 卡住）',
      written[0]?.id === 7 && written[0]?.result?.modelContextBudgetStrategy === 'preflight-v1' && written[0]?.result?.memoryEnabled === false
    );
    written.length = 0;
    appAdapter._answerServerRequest({ id: 8, method: 'interaction/requestPermission' });
    check('appserver: 工具策略 allow-all → decision=allow', written[0]?.result?.decision === 'allow');
    written.length = 0;
    appAdapter._answerServerRequest({ id: 9, method: 'interaction/browserList' });
    check('appserver: 浏览器能力缺席 → 空列表（不假装提供）', JSON.stringify(written[0]?.result) === JSON.stringify({ browsers: [] }));

    /* 鉴权应答：**不可解**的临时凭据库 → 必须明确拒绝（headersApplied:false）而不是挂死。
     * 红线：绝不读真实 ~/.zcode/v2/credentials.json（R-01），故这里把存储路径指向 tmp。 */
    written.length = 0;
    const realOptions = appAdapter.options;
    appAdapter.options = () => ({ ...realOptions(), appServerCredentialStorePath: join(tmp, 'nope.json') });
    appAdapter._answerServerRequest({ id: 10, method: 'interaction/requestProviderRuntimeHeaders' });
    appAdapter.options = realOptions;
    check(
      'appserver: 凭据不可用 → headersApplied:false（让 agent 走兜底，不挂死）',
      written[0]?.result?.headersApplied === false && typeof written[0]?.result?.errorMessage === 'string',
      JSON.stringify(written[0]?.result ?? null).slice(0, 100)
    );
    check('appserver: 鉴权失败路径零明文', !JSON.stringify(written[0]).includes(fakeKey));

    writeFileSync(switchPath, JSON.stringify({ enabled: true }), 'utf8');
  }

  for (const off of effects.splice(0)) off?.();
  check('卸载: 三部曲对称移除（两次注册一并卸载）', registrations.adapters.length === 0 && registrations.discoveries.length === 0 && registrations.directories.length === 0);

  writeFileSync(switchPath, JSON.stringify({ enabled: true }), 'utf8');
  const ctx2 = fakeCtx();
  index.apply(ctx2, { switchPath, credentialPath: join(tmp, 'no-such-cred.json'), ledgerPath, credentialFallback: false });
  const failed = await waitFor(() => errors.length >= 1 && registrations.adapters.length === 0);
  const credFailureLogged = errors.some((e) => String(e).includes('provider 注册失败'));
  check('失败面: 凭据缺失 → 只报错不注册不炸', failed === true && credFailureLogged, errors[errors.length - 1]?.slice(0, 80));

  delete process.env.ZCODE_CONNECT_MODULES_ROOT;
  const ctx3 = fakeCtx();
  index.apply(ctx3, { switchPath, credentialPath: credPath, ledgerPath, credentialFallback: false });
  const noModules = await waitFor(() => errors.some((e) => e.includes('宿主 LLM 栈不可用')));
  check('失败面: 宿主栈不可解析 → 可操作错误且不注册', noModules === true, errors.find((e) => e.includes('宿主 LLM 栈不可用'))?.slice(0, 80));
}

// ─── 7.4 app-server 通道（Start Plan 直连；T23，纯静态零网络零真实凭据） ──────
{
  const src = readFileSync(join(PLUGIN_ROOT, 'lib', 'app-server.js'), 'utf8');

  /* 纪律：link 插件**不能**裸 import 宿主包（TROUBLESHOOTING §2.4）——本模块靠调用方
   * 注入 LlmAdapter 基类，源码里出现裸宿主说明符就是接线回退到了不可靠路径。 */
  check(
    'appserver: 零静态宿主包 import（LlmAdapter 靠调用方注入，§2.4）',
    !/^\s*import\s[^;]*from\s+['"]@(?:deepseek-ai|earendil-works)\//m.test(src)
  );
  /* 凭据红线：token 只允许进鉴权应答；日志最多打长度。 */
  check(
    'appserver: 凭据不进日志（源码里未出现 `auth.token` 值插值）',
    !/console\.[a-z]+\([^)]*auth\.token\b(?!\.length)/.test(src)
  );

  // ── 账户条目与注入补丁 ──
  check(
    'appserver: startPlanProviderId 按账号家族选条目（bigmodel/zai，非法回 zai）',
    appServer.startPlanProviderId('bigmodel') === 'account:bigmodel-start-plan' &&
      appServer.startPlanProviderId('zai') === 'account:zai-start-plan' &&
      appServer.startPlanProviderId(undefined) === 'account:zai-start-plan' &&
      appServer.startPlanProviderId('nonsense') === 'account:zai-start-plan'
  );
  {
    const pid = appServer.startPlanProviderId('bigmodel');
    const patch = appServer.buildAccountConfigPatch('rev:1', pid, ['GLM-5.3-Flash'], 42);
    /* access 的 schema 严格：只接受 `{type:'zhipu-account', entitled}`；
     * states[s] 必须带 current —— 形状错了注入会被拒（或静默跳过）。 */
    check(
      'appserver: 注入补丁形状（access 两键 / states.current / basedOn 逐字符保留）',
      patch.basedOnZCodeBuiltinRevision === 'rev:1' &&
        JSON.stringify(patch.providers[pid].access) === JSON.stringify({ type: 'zhipu-account', entitled: true }) &&
        patch.states[pid].current === true &&
        patch.providers[pid].builtinModelIds.join(',') === 'GLM-5.3-Flash'
    );
  }

  // ── 子进程 env 白名单 ──
  {
    const env = appServer.buildChildEnv(
      { PATH: 'x', SECRET_TOKEN: 'leak-me', ZCODE_FOO: '1', ProgramFiles: 'C:\\PF' },
      { ZCODE_BASE_URL: 'https://zcode.z.ai' },
      ['my_var']
    );
    check(
      'appserver: 子进程 env 只透传白名单 + ZCODE_*（不泄漏宿主其他密钥）',
      env.SECRET_TOKEN === undefined && env.ZCODE_FOO === '1' && env.ZCODE_BASE_URL === 'https://zcode.z.ai' && env.PATH === 'x'
    );
  }

  // ── CLI 探测（ZCode 常装在非系统盘：只查 %ProgramFiles% 会漏）──
  check(
    'appserver: resolveZcodeCliPath 支持盘符扫描 + 显式配置优先',
    appServer.resolveZcodeCliPath('') === '' || appServer.resolveZcodeCliPath('').endsWith('zcode.cjs')
  );
  {
    const explicit = appServer.resolveZcodeCliPath(process.execPath);
    check('appserver: 显式配置的 CLI 路径被优先采用', explicit === process.execPath, explicit);
  }

  // ── builtin revision（注入是否被静默跳过的唯一判据）──
  {
    const b1 = tmpFile('as-builtin.json', JSON.stringify({ revision: 30 }));
    const b2 = tmpFile('as-builtin-other.json', JSON.stringify({ revision: 30 }));
    const r1 = appServer.computeBuiltinRevision(b1);
    check(
      'appserver: computeBuiltinRevision = zcode-builtin:<revision>:<sha256(path)>（路径敏感）',
      r1.startsWith('zcode-builtin:30:') && r1 === appServer.computeBuiltinRevision(b1) && r1 !== appServer.computeBuiltinRevision(b2)
    );
  }
  {
    /* resolveBuiltinRuntime 必须优先非 0.0.0-dev（CLI 裸跑的 fallback 目录）。 */
    const base = join(tmp, 'as-data');
    const root = join(base, '.zcode', 'v2', 'runtime', 'provider', 'windows-x86_64');
    const entries = {
      [root]: [
        { name: '0.0.0-dev', isDirectory: () => true },
        { name: '3.14.5', isDirectory: () => true },
      ],
      [join(root, '0.0.0-dev')]: [{ name: 'endpoint-a', isDirectory: () => true }],
      [join(root, '3.14.5')]: [{ name: 'endpoint-b', isDirectory: () => true }],
    };
    const fsImpl = {
      readdirSync: (p) => {
        if (entries[p]) return entries[p];
        throw new Error('ENOENT');
      },
      statSync: (p) => ({ mtimeMs: p.includes('3.14.5') ? 200 : 100 }),
    };
    const hit = appServer.resolveBuiltinRuntime(base, { platformDir: 'windows-x86_64', fsImpl });
    check(
      'appserver: builtin 运行时优先非 0.0.0-dev（版本目录选最新）',
      hit?.version === '3.14.5' && hit.activeFilePath.includes('endpoint-b'),
      `version=${hit?.version}`
    );
    check('appserver: 运行时目录缺失 → undefined（调用方告警而非抛）', appServer.resolveBuiltinRuntime(join(tmp, 'nope')) === undefined);
  }

  // ── 模型目录解析（未知 id 必丢弃：写错 id 会让 setModel 失败）──
  {
    const cat = appServer.resolveAppServerCatalog(['GLM-5.2', 'NOT_A_MODEL']);
    check('appserver: 目录只暴露内置真实模型（未知 id 丢弃）', cat.length === 1 && cat[0].id === 'GLM-5.2');
    const dflt = appServer.resolveAppServerCatalog([]);
    check('appserver: 空配置回默认单条（不会暴露 0 个模型）', dflt.length === 1 && dflt[0].id === 'GLM-5.3-Flash');
    check(
      'appserver: 内置目录不含 GLM-5.3（builtin 未给 start-plan 声明它）',
      !appServer.START_PLAN_CATALOG.some((m) => m.id === 'GLM-5.3')
    );
  }

  // ── 对话拍平 ──
  {
    const flat = appServer.flattenConversation(
      [
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
        { role: 'assistant', content: [{ type: 'text', text: '在' }, { type: 'tool-call', name: 'Bash', arguments: '{}' }] },
        { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
      ],
      'SYS'
    );
    check(
      'appserver: flattenConversation 保留 system/用户/助手/工具结果四段',
      flat.includes('# 系统提示') && flat.includes('# 用户') && flat.includes('[调用工具 Bash]') && flat.includes('# 工具结果')
    );
    check(
      'appserver: lastUserText 取末条用户消息（续轮只发它）',
      appServer.lastUserText([{ role: 'user', content: [{ type: 'text', text: 'A' }] }, { role: 'assistant', content: [{ type: 'text', text: 'B' }] }]) === 'A' &&
        appServer.lastUserText([{ role: 'assistant', content: [{ type: 'text', text: 'B' }] }]) === ''
    );
    check(
      'appserver: 历史里的伪工具调用标记被压成占位（防模型照抄）',
      appServer.sanitizeLeakedCalls('<antml:invoke name="pwsh">x</antml:invoke>ok').startsWith('（历史') &&
        appServer.sanitizeLeakedCalls('正常文本') === '正常文本'
    );
    const f1 = appServer.conversationFingerprint([{ role: 'user', content: 'a' }], 's');
    check(
      'appserver: 会话指纹对内容与 system 都敏感（历史分叉检测）',
      f1 !== appServer.conversationFingerprint([{ role: 'user', content: 'b' }], 's') &&
        f1 !== appServer.conversationFingerprint([{ role: 'user', content: 'a' }], 's2') &&
        f1 === appServer.conversationFingerprint([{ role: 'user', content: 'a' }], 's')
    );
  }

  // ── 事件信封：**type 在 params 顶层**（不是 payload.type）——搞错会静默收不到任何流 ──
  {
    const a = appServer.eventPayload({ params: { type: 'turn.completed', payload: { response: 'hi' } } });
    const b = appServer.eventPayload({ params: { payload: { type: 'inner.type' } } });
    const c = appServer.eventPayload({});
    check(
      'appserver: 事件信封按 params.type 取（顶层优先，回落 payload.type）',
      a.type === 'turn.completed' && a.payload.response === 'hi' && b.type === 'inner.type' && c.type === '' && JSON.stringify(c.payload) === '{}'
    );

    // ── 图片附件：DSH 图片块 → app-server 的 attachments（走 localPath）──
    {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '旧' }, { type: 'image', attachment: { attachmentId: 'old' } }] },
      { role: 'assistant', content: [{ type: 'text', text: '好' }] },
      { role: 'user', content: [{ type: 'text', text: '看这张' }, { type: 'image', attachment: { attachmentId: 'a1', name: 'shot.png' } }, { type: 'image', mimeType: 'image/jpeg' }] },
    ];
    const blocks = appServer.collectImageBlocks(messages);
    check(
      'appserver: 图片块只取最后一条用户消息（历史图由 agent 自己的会话历史承载）',
      blocks.length === 2 && blocks[0].ref.attachmentId === 'a1' && blocks[1].ref === null && blocks[1].mimeType === 'image/jpeg',
      JSON.stringify(blocks)
    );
    check(
      'appserver: 无用户消息 / 非数组输入 → 空数组（不抛）',
      appServer.collectImageBlocks([]).length === 0 && appServer.collectImageBlocks(undefined).length === 0 &&
        appServer.collectImageBlocks([{ role: 'assistant', content: [{ type: 'image' }] }]).length === 0
    );
    check(
      'appserver: 扩展名映射与 dsh-llm 同套（png/jpeg/webp/gif，未知 .bin）',
      appServer.imageExtension('image/png') === '.png' && appServer.imageExtension('image/jpeg') === '.jpg' &&
        appServer.imageExtension('image/webp') === '.webp' && appServer.imageExtension('image/gif') === '.gif' &&
        appServer.imageExtension('image/avif') === '.bin'
    );
    check('appserver: 转发图片时正文带附件说明（否则 agent 只看到路径、不知是本轮新图）', appServer.IMAGE_ATTACH_NOTE.includes('图片附件'));
    }
  }

  /* ── usage 口径折算（2026-10-10 真机事故）────────────────────────────────────────
   * CLI 的 `turn.completed.usage` 是**本回合全部模型调用之和**（zcode.cjs: ZO→Jgr 逐桶累加，
   * 带 modelRequestCount），而 DSH 的 usage 是单次请求口径 —— tokenMeter 直接拿它当
   * contextPressure 锚点（pressureFrom = input + cacheRead + cacheWrite）。
   * 照搬聚合值 = 上下文占用虚高 N 倍（实测 17 次调用 ⇒ 7.08M / 1M = 708%，原生弹窗
   * 顶部 100% 与同弹窗启发式明细 24.9K 自相矛盾，且连触发两次压缩）。 */
  {
    const j = (x) => JSON.stringify(x);
    /* ① 单调用回合：聚合值**就是**按次值 ⇒ 原样上报（含 cache 分桶）。 */
    const single = appServer.deriveReportedUsage(
      { inputTokens: 220089, outputTokens: 7604, cacheReadTokens: 12800, cacheWriteTokens: 0, modelRequestCount: 1 },
      undefined
    );
    check(
      'appserver: usage 口径=cli-single（单调用回合原样上报，含 cache 分桶）',
      single.basis === 'cli-single' &&
        j(single.usage) === j({ inputTokens: 220089, outputTokens: 7604, cacheReadTokens: 12800, cacheWriteTokens: 0 }),
      `${single.basis} ${j(single.usage)}`
    );
    /* ② 多调用回合 + 有 CLI 按次读数 ⇒ 用 contextUsed，output 记 0（已含在 contextUsed 里，防重复计）。 */
    const multi = appServer.deriveReportedUsage(
      { inputTokens: 3871622, outputTokens: 20391, cacheReadTokens: 3200000, cacheWriteTokens: 12, modelRequestCount: 17 },
      731402
    );
    check(
      'appserver: usage 口径=context-used（多调用回合改用 CLI 按次读数，不再上报 3.87M 聚合值）',
      multi.basis === 'context-used' && j(multi.usage) === j({ inputTokens: 731402, outputTokens: 0 }),
      `${multi.basis} ${j(multi.usage)}`
    );
    /* ③ 多调用但拿不到按次读数 ⇒ 按次数取均值（宁小不大，绝不虚高）。 */
    const divided = appServer.deriveReportedUsage(
      { inputTokens: 3400000, outputTokens: 17000, cacheReadTokens: 1700000, modelRequestCount: 17 },
      undefined
    );
    check(
      'appserver: usage 口径=divided-by-count（读不到按次读数时取均值，不虚高）',
      divided.basis === 'divided-by-count' && divided.usage.inputTokens === 200000 &&
        divided.usage.outputTokens === 1000 && divided.usage.cacheReadTokens === 100000,
      `${divided.basis} ${j(divided.usage)}`
    );
    /* ④ 口径漂移护栏：按次读数大于整回合聚合总量 ⇒ 不采信，退回均值。 */
    const drift = appServer.deriveReportedUsage(
      { inputTokens: 100000, outputTokens: 500, modelRequestCount: 4 },
      999999
    );
    check(
      'appserver: usage 口径漂移护栏（contextUsed 大于回合聚合 ⇒ 不采信，退回均值）',
      drift.basis === 'divided-by-count' && drift.usage.inputTokens === 25000,
      `${drift.basis} ${j(drift.usage)}`
    );
    /* ⑤ 老 CLI 不带 modelRequestCount 但有按次读数 ⇒ 仍按按次值用；两者都没有 ⇒ 不抛。
     * ⚠️ 聚合值必须 ≥ 按次读数（真实世界里回合聚合恒 ≥ 末次调用），否则先被漂移护栏拦下——
     * 这条护栏正是用来识别"contextUsed 语义变了"（比如某版把它换成会话累计值）。 */
    const legacy = appServer.deriveReportedUsage({ inputTokens: 900000, outputTokens: 90000 }, 5000);
    const empty = appServer.deriveReportedUsage(undefined, undefined);
    check(
      'appserver: usage 口径兜底（次数未知但可按次 / 全缺 → 零值，不抛）',
      legacy.basis === 'context-used' && legacy.usage.inputTokens === 5000 &&
        empty.basis === 'cli-raw' && empty.usage.inputTokens === 0 && empty.usage.outputTokens === 0,
      `${legacy.basis}/${empty.basis}`
    );

    /* ── 接线断言（源码级，防"折算了但没接上"）── */
    check(
      'appserver: 折算函数必须真接在回合结束路径上（多调用回合才读 session/read）',
      /derived = deriveReportedUsage\(turnUsage, probe\?\.contextUsed\)/.test(src) &&
        /const needProbe = !\(typeof turnCalls === 'number' && turnCalls <= 1\)/.test(src) &&
        /session\/read/.test(src) && /messageLimit: 1/.test(src)
    );
    check(
      'appserver: 不再把 CLI 聚合 usage 直接当作用量（turnUsage 只进折算与账本）',
      !/usage = \{\s*\n\s*inputTokens: payload\.usage\.inputTokens/.test(src) &&
        /turnUsage = \{/.test(src) && /deriveReportedUsage\(turnUsage/.test(src)
    );
    check(
      'appserver: 账本仍记回合聚合（真实消耗），不是上报给 DSH 的按次折算值',
      /input: turnUsage\?\.inputTokens \?\? 0/.test(src) && /output: turnUsage\?\.outputTokens \?\? 0/.test(src)
    );

    /* ── 端到端（假 transport 驱动**真实 stream()**，零 spawn 零额度）──────────────
     * 只有真的把折算接在回合结束路径上，这个断言才会过 —— 纯函数单测做不到这一点。 */
    const cfgLike = {
      zcodeCliPath: process.execPath, zcodeCliNode: 'node', appServerWorkspace: homedir(),
      zcodeDataBaseDir: '', appServerCredentialStorePath: '', appServerAccountProviderId: '',
      appServerModels: ['GLM-5.2'], appServerReasoningLevel: 'max', appServerToolPolicy: 'deny-all',
      appServerInjectAccount: false, appServerRpcTimeoutMs: 5000, appServerTurnTimeoutMs: 20000,
      childEnvAllow: [], contextWindow: 1000000,
    };
    const makeFakeClient = ({ turnUsage, contextUsed, readFails = false }) => {
      const listeners = new Set();
      const calls = [];
      return {
        disposed: false,
        calls,
        cliPath: '', cliNode: '', cwd: '', rpcTimeoutMs: 0, env: {}, lastChannel: null, onServerRequest: null,
        onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        write() {}, notify() {}, dispose() {},
        async ensureStarted() {},
        async request(method, params) {
          calls.push({ method, params });
          if (method === 'session/read') {
            if (readFails) throw new Error('session/read 故意失败');
            return { projection: { contextUsed, contextWindow: 1000000 } };
          }
          if (method === 'session/send') {
            /* 事件在 send 返回后到达（与真实时序一致：先 200 再流事件）。 */
            queueMicrotask(() => {
              for (const listener of listeners) {
                listener({ method: 'session/event', params: { type: 'turn.completed', payload: { response: 'ok', resultType: 'success', usage: turnUsage } } });
              }
            });
            return {};
          }
          return {};
        },
      };
    };
    /** 跑一轮：会话条目直接预置（跳过 ensureSession 的 3.5s 建会话等待，本测只验 usage 接线）。 */
    const runTurn = async (fake, ledger) => {
      const adapter = appServer.createAppServerAdapter({
        BaseAdapter: class {},
        LlmError: class LlmError extends Error {},
        options: () => cfgLike,
        logger: {},
        record: (info) => ledger.push(info),
        gate: () => {},
      });
      adapter.client = fake;
      adapter.sessions.set('s1', { sessionId: 'sess-fake', firstTurn: false, modelId: 'GLM-5.2', sentFingerprint: undefined });
      const chunks = [];
      for await (const chunk of adapter.stream({
        provider: 'zcode-appserver', model: 'GLM-5.2', sessionId: 's1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) chunks.push(chunk);
      adapter.dispose();
      return chunks;
    };

    const multiFake = makeFakeClient({
      turnUsage: { inputTokens: 3400000, outputTokens: 17000, cacheReadTokens: 1700000, cacheWriteTokens: 0, modelRequestCount: 17 },
      contextUsed: 731402,
    });
    const multiLedger = [];
    const multiChunks = await runTurn(multiFake, multiLedger);
    const multiUsage = multiChunks.find((c) => c.type === 'usage')?.usage;
    check(
      'appserver: 多调用回合上报的是按次读数（不是 3.4M 聚合值，output 记 0 防重复计）',
      j(multiUsage) === j({ inputTokens: 731402, outputTokens: 0 }),
      j(multiUsage)
    );
    check(
      'appserver: 多调用回合真的读了 session/read（带 sessionId 与 messageLimit:1，快照构建才便宜）',
      multiFake.calls.some((c) => c.method === 'session/read' && c.params.sessionId === 'sess-fake' && c.params.messageLimit === 1),
      JSON.stringify(multiFake.calls.map((c) => c.method))
    );
    check(
      'appserver: 账本记回合聚合 + 调用次数（真实消耗不被折算值污染）',
      multiLedger.length === 1 && multiLedger[0].input === 3400000 && multiLedger[0].output === 17000 && multiLedger[0].modelRequestCount === 17,
      j(multiLedger)
    );

    const singleFake = makeFakeClient({
      turnUsage: { inputTokens: 220089, outputTokens: 7604, cacheReadTokens: 12800, cacheWriteTokens: 0, modelRequestCount: 1 },
      contextUsed: 999999,
    });
    const singleChunks = await runTurn(singleFake, []);
    const singleUsage = singleChunks.find((c) => c.type === 'usage')?.usage;
    check(
      'appserver: 单调用回合原样上报且**不**多打 session/read（占多数路径零额外 RPC）',
      j(singleUsage) === j({ inputTokens: 220089, outputTokens: 7604, cacheReadTokens: 12800, cacheWriteTokens: 0 }) &&
        !singleFake.calls.some((c) => c.method === 'session/read'),
      `${j(singleUsage)} calls=${JSON.stringify(singleFake.calls.map((c) => c.method))}`
    );

    const failFake = makeFakeClient({
      turnUsage: { inputTokens: 3400000, outputTokens: 17000, modelRequestCount: 17 },
      contextUsed: undefined,
      readFails: true,
    });
    const failChunks = await runTurn(failFake, []);
    const failUsage = failChunks.find((c) => c.type === 'usage')?.usage;
    check(
      'appserver: session/read 失败不打断回合（退回均值折算，仍不虚高）',
      failUsage?.inputTokens === 200000 && failUsage?.outputTokens === 1000 && failChunks.some((c) => c.type === 'finish'),
      j(failUsage)
    );
  }

  /* ── 流式分块 + 思考档（2026-10-10 用户实测"面板内容一直覆盖"；赠送 5.3-Flash 补思考档）──
   * 分块事故的机制（宿主源码取证）：`BlockAssembler` 与 GUI `updateChunk` 都以 **index 为键** ——
   * GUI 端 `blocks[i] = { kind, text: (previous?.kind === <同类> ? previous.text : "") + delta }`
   * ⇒ 同一 index 上 text / reasoning 交替时**每次换类都丢弃上一块**；汇编器 `ensure(index,type)`
   * 只在 index 不存在时定类型，两类 delta 会拼进同一块，最后被 `block-end` 的负载整体替换。
   * 故这里断言的是**块序列不变量**：换类即换 index、显式 block-start、收尾负载 == 该块累计文本。 */
  {
    /* ① 纯函数：官方档位 → DSH `reasoning` 元数据（契约：efforts 非空、id 唯一、defaultEffort 命中） */
    const meta = appServer.buildReasoningMeta(['low', 'high', 'max'], 'high');
    check(
      'appserver: buildReasoningMeta 形状（id/name + defaultEffort 命中集合）',
      JSON.stringify(meta) ===
        JSON.stringify({
          efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
          defaultEffort: 'high',
        }),
      JSON.stringify(meta)
    );
    check(
      'appserver: buildReasoningMeta 兜底（空档位→undefined；默认档不在集合→取集合内；未知 id 原样显示）',
      appServer.buildReasoningMeta([], 'max') === undefined &&
        appServer.buildReasoningMeta(null, undefined) === undefined &&
        appServer.buildReasoningMeta(['weird'], 'nope').defaultEffort === 'weird' &&
        appServer.buildReasoningMeta(['weird'], 'nope').efforts[0].name === 'weird' &&
        appServer.buildReasoningMeta(['low', 'max'], 'high').defaultEffort === 'max'
    );
    /* ② 事实源（面板与适配器同一函数，防两处漂移）：官方 variants 优先、配置默认优先于官方默认 */
    const facts = appServer.reasoningFacts({ 'glm-5.3-flash': { variants: ['low', 'max'], defaultVariant: 'max' } }, 'GLM-5.3-Flash', 'low');
    const noOfficial = appServer.reasoningFacts({}, 'GLM-5.3-Flash', 'high');
    const badCfg = appServer.reasoningFacts({ 'glm-5.3-flash': { variants: ['low', 'max'], defaultVariant: 'max' } }, 'GLM-5.3-Flash', 'nonsense');
    check(
      'appserver: reasoningFacts（官方档位 + 配置默认优先；配置非法→官方默认；无官方→回退常量档位）',
      JSON.stringify(facts) === JSON.stringify({ levels: ['low', 'max'], defaultLevel: 'low' }) &&
        JSON.stringify(noOfficial.levels) === JSON.stringify(appServer.START_PLAN_REASONING_LEVELS) &&
        noOfficial.defaultLevel === 'high' &&
        badCfg.defaultLevel === 'max',
      `${JSON.stringify(facts)} / ${JSON.stringify(noOfficial)} / ${JSON.stringify(badCfg)}`
    );
    /* 展示顺序 = 强度序，与官方 variants 的**书写顺序**无关（2026-10-10 用户对比截图：
     * config 写作 ["low","max","high"]，照抄会让选择器显示 low/max/high，与
     * DeepSeek 内建 Off/Low/High/Max 及 Coding Plan 通道的升序不一致）。 */
    const scrambled = appServer.reasoningFacts(
      { 'glm-5.3-flash': { variants: ['low', 'max', 'high'], defaultVariant: 'max' } },
      'GLM-5.3-Flash',
      undefined
    );
    const reversed = appServer.reasoningFacts({ m: { variants: ['max', 'high', 'low'] } }, 'm', undefined);
    check(
      'appserver: 档位按强度序展示（官方书写顺序不影响选择器/面板顺序；未知档位排最后）',
      JSON.stringify(scrambled.levels) === JSON.stringify(['low', 'high', 'max']) &&
        scrambled.defaultLevel === 'max' &&
        JSON.stringify(reversed.levels) === JSON.stringify(['low', 'high', 'max']) &&
        JSON.stringify(appServer.reasoningFacts({ m: { variants: ['custom', 'low'] } }, 'm', undefined).levels) ===
          JSON.stringify(['low', 'custom']),
      `${JSON.stringify(scrambled.levels)} / ${JSON.stringify(reversed.levels)}`
    );
    /* ③ 官方档位读取（夹具 config.json 的 start-plan 段；family→套餐键；读不到 → {}） */
    const cfgFixture = tmpFile(
      'zcode-config-reasoning.json',
      JSON.stringify({
        provider: {
          'builtin:bigmodel-start-plan': {
            models: {
              'GLM-5.3-Flash': {
                limit: { context: 1000000, output: 128000 },
                reasoning: { enabled: true, variants: ['low', 'max', 'high'], defaultVariant: 'max' },
                modalities: { input: ['text', 'image'] },
              },
            },
          },
        },
      })
    );
    const readMeta = appServer.readStartPlanReasoningMeta('account:bigmodel-start-plan', cfgFixture);
    check(
      'appserver: readStartPlanReasoningMeta 读官方 variants（family→套餐键；读不到→{}）',
      JSON.stringify(readMeta) === JSON.stringify({ 'glm-5.3-flash': { variants: ['low', 'max', 'high'], defaultVariant: 'max' } }) &&
        JSON.stringify(appServer.readStartPlanReasoningMeta('account:bigmodel-start-plan', join(tmp, 'nope.json'))) === '{}' &&
        appServer.startPlanConfigKey('account:zai-start-plan') === 'builtin:zai-start-plan' &&
        appServer.startPlanConfigKey('nonsense') === '',
      JSON.stringify(readMeta)
    );

    /* ④ 端到端（假 transport 驱动**真实 stream()**）：块序列不变量 */
    const cfgBlock = {
      zcodeCliPath: process.execPath, zcodeCliNode: 'node', appServerWorkspace: homedir(),
      zcodeDataBaseDir: '', appServerCredentialStorePath: '', appServerAccountProviderId: '',
      appServerModels: ['GLM-5.2'], appServerReasoningLevel: 'max', appServerToolPolicy: 'deny-all',
      appServerInjectAccount: false, appServerRpcTimeoutMs: 5000, appServerTurnTimeoutMs: 20000,
      childEnvAllow: [], contextWindow: 1000000,
    };
    const makeScriptClient = (script, { contextUsed = 1234, readFails = false } = {}) => {
      const listeners = new Set();
      const calls = [];
      return {
        disposed: false, calls, cliPath: '', cliNode: '', cwd: '', rpcTimeoutMs: 0, env: {}, lastChannel: null, onServerRequest: null,
        onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        write() {}, notify() {}, dispose() {}, async ensureStarted() {},
        async request(method, params) {
          calls.push({ method, params });
          if (method === 'session/create') return { session: { sessionId: 'sess-block' } };
          if (method === 'session/read') {
            if (readFails) throw new Error('session/read 故意失败');
            return { projection: { contextUsed, contextWindow: 1000000 } };
          }
          if (method === 'session/send') {
            queueMicrotask(() => {
              for (const event of script) for (const listener of listeners) listener({ method: 'session/event', params: event });
            });
            return {};
          }
          return {};
        },
      };
    };
    const runScript = async (fake, cfg, opts = {}) => {
      const adapter = appServer.createAppServerAdapter({
        BaseAdapter: class {}, LlmError: class LlmError extends Error {}, options: () => cfg,
        logger: opts.logger ?? {}, gate: () => {},
      });
      adapter.client = fake;
      if (opts.seed !== false) {
        adapter.sessions.set('s1', { sessionId: 'sess-block', firstTurn: false, modelId: 'GLM-5.2', reasoningLevel: 'max', sentFingerprint: undefined });
      }
      const chunks = [];
      for await (const chunk of adapter.stream({
        provider: 'zcode-appserver', model: 'GLM-5.2', sessionId: opts.sessionId ?? 's1',
        ...(opts.effort === undefined ? {} : { reasoningEffort: opts.effort }),
        ...(opts.purpose === undefined ? {} : { purpose: opts.purpose }),
        messages: opts.messages ?? [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) chunks.push(chunk);
      adapter.dispose();
      return chunks;
    };

    const done = (response) => ({ type: 'turn.completed', payload: { response, resultType: 'success', usage: { inputTokens: 100, outputTokens: 10, modelRequestCount: 1 } } });
    const blockChunks = await runScript(
      makeScriptClient([
        { type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: '想一下' } },
        { type: 'model.streaming', payload: { kind: 'text_delta', delta: '先看文件' } },
        { type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: '再看看' } },
        { type: 'model.streaming', payload: { kind: 'text_delta', delta: '结论 X' } },
        done('结论 X'),
      ]),
      cfgBlock
    );
    const starts = blockChunks.filter((c) => c.type === 'block-start');
    const ends = blockChunks.filter((c) => c.type === 'block-end');
    const deltasAt = (index) =>
      blockChunks
        .filter((c) => (c.type === 'text-delta' || c.type === 'reasoning-delta') && c.index === index)
        .map((c) => c.text)
        .join('');
    check(
      'appserver: 推理/正文各自独立 index + 显式 block-start（同 index 混发会被宿主与 GUI 互相覆盖）',
      JSON.stringify(starts.map((c) => [c.index, c.blockType])) ===
        JSON.stringify([[0, 'reasoning'], [1, 'text'], [2, 'reasoning'], [3, 'text']]) &&
        JSON.stringify(ends.map((c) => c.index)) === JSON.stringify([0, 1, 2, 3]) &&
        ends.every((c) => c.block.text === deltasAt(c.index)),
      JSON.stringify(starts.map((c) => [c.index, c.blockType])) + ' / ' + JSON.stringify(ends.map((c) => c.block.text))
    );
    check(
      'appserver: 收尾不再用最终文本覆盖（每块收尾 == 已流出文本，块数不增不减）',
      JSON.stringify(ends.map((c) => [c.block.type, c.block.text])) ===
        JSON.stringify([['reasoning', '想一下'], ['text', '先看文件'], ['reasoning', '再看看'], ['text', '结论 X']]),
      JSON.stringify(ends.map((c) => [c.block.type, c.block.text]))
    );
    const appendEnds = (
      await runScript(
        makeScriptClient([
          { type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: '只有思考' } },
          done('最终答案'),
        ]),
        cfgBlock
      )
    ).filter((c) => c.type === 'block-end');
    check(
      'appserver: 正文未流出时把最终答案**追加**为块（不覆盖已流出的思考，也不丢答案）',
      JSON.stringify(appendEnds.map((c) => [c.block.type, c.block.text])) ===
        JSON.stringify([['reasoning', '只有思考'], ['text', '最终答案']]),
      JSON.stringify(appendEnds.map((c) => [c.block.type, c.block.text]))
    );

    /* ⑥ usage 只在**可信**时下发（2026-10-11 真机事故：一次 561 秒未落定的回合让弹窗从 40%
     *   掉到 0% —— 宿主 tokenMeter 把 usage 当 contextPressure 锚点，报 0 等于清零占用）。
     *   中止回合的正确做法：改用 CLI 的**按次上下文**当锚点（真实读数，能自愈）；读不到则不发。 */
    const cancelledChunks = await runScript(
      makeScriptClient([
        { type: 'model.streaming', payload: { kind: 'text_delta', delta: '半截' } },
        { type: 'turn.completed', payload: { response: '半截', resultType: 'cancelled', usage: { inputTokens: 700, outputTokens: 3, modelRequestCount: 2 } } },
      ]),
      cfgBlock
    );
    const cancelledUsage = cancelledChunks.find((c) => c.type === 'usage')?.usage;
    check(
      'appserver: 回合未落定 ⇒ 用 CLI 按次上下文当锚点（不报 0；能把被清零的占用自愈回来）',
      JSON.stringify(cancelledUsage) === JSON.stringify({ inputTokens: 1234, outputTokens: 0 }) &&
        cancelledChunks.some((c) => c.type === 'finish'),
      JSON.stringify(cancelledUsage)
    );
    const cancelledNoProbe = await runScript(
      makeScriptClient(
        [{ type: 'turn.completed', payload: { response: '', resultType: 'failed' } }],
        { readFails: true }
      ),
      cfgBlock
    );
    check(
      'appserver: 回合未落定且读不到按次上下文 ⇒ 一个 usage 块都不发（宁缺勿错）',
      !cancelledNoProbe.some((c) => c.type === 'usage'),
      JSON.stringify(cancelledNoProbe.filter((c) => c.type === 'usage'))
    );
    const zeroChunks = await runScript(
      makeScriptClient([
        { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'ok' } },
        { type: 'turn.completed', payload: { response: 'ok', resultType: 'success', usage: { inputTokens: 0, outputTokens: 0, modelRequestCount: 1 } } },
      ]),
      cfgBlock
    );
    check(
      'appserver: 全零 usage ⇒ 不发 usage 块（零值会把上下文压力锚点清零）',
      !zeroChunks.some((c) => c.type === 'usage'),
      JSON.stringify(zeroChunks.filter((c) => c.type === 'usage'))
    );
    const titleChunks = await runScript(
      makeScriptClient([done('unused')]),
      cfgBlock,
      { purpose: 'session-title' }
    );
    check(
      'appserver: 本地生成的会话标题不发 usage 块（无真实上游用量，报 0 会清零锚点）',
      !titleChunks.some((c) => c.type === 'usage') && titleChunks.some((c) => c.type === 'finish'),
      JSON.stringify(titleChunks.filter((c) => c.type === 'usage'))
    );

    /* ⑦ 图片链路接线（2026-10-11 真机事故：物化函数被放进 options()，适配器只读顶层
     *    ⇒ 恒 undefined ⇒ 有图也按纯文本发且**零告警**；CLI 侧 attachmentCount=0、
     *    模型请求 0 个 image 块）。这里两件事都断言：物化成功要真的下发附件；
     *    有图却物化不出东西必须**出声**。 */
    const imageMessages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png' } },
        ],
      },
    ];
    const imageFake = makeScriptClient([done('ok')]);
    await runScript(
      imageFake,
      {
        ...cfgBlock,
        materializeImages: async () => [
          { kind: 'image', filename: 'dsh-image-1.png', mimeType: 'image/png', localPath: 'C:\\tmp\\dsh-image-1.png' },
        ],
      },
      { messages: imageMessages }
    );
    const imageSend = imageFake.calls.find((c) => c.method === 'session/send')?.params;
    check(
      'appserver: 物化函数放在 options() 里也被认（顶层缺席时回退 options().materializeImages）→ 附件真的随 send 下发',
      JSON.stringify(imageSend?.attachments) ===
        JSON.stringify([{ kind: 'image', filename: 'dsh-image-1.png', mimeType: 'image/png', localPath: 'C:\\tmp\\dsh-image-1.png' }]) &&
        String(imageSend?.content ?? '').includes('图片附件'),
      JSON.stringify(imageSend?.attachments)
    );
    const imageWarns = [];
    const emptyImageFake = makeScriptClient([done('ok')]);
    await runScript(
      emptyImageFake,
      { ...cfgBlock, materializeImages: async () => [] },
      { messages: imageMessages, logger: { warn: (m) => imageWarns.push(String(m)), info: () => {} } }
    );
    check(
      'appserver: 有图却没物化出附件 ⇒ 告警 + 按纯文本发送（这类静默失败必须出声）',
      imageWarns.some((m) => m.includes('一张都没能物化成附件')) &&
        emptyImageFake.calls.find((c) => c.method === 'session/send')?.params.attachments === undefined,
      JSON.stringify(imageWarns)
    );

    /* ⑧ 卡死恢复阶梯（2026-10-11 事故：900s 超时后 DSH 重试撞上
     *   `A prompt is already running for this session`，旧实现只等 1.5s 就放弃 ⇒ 用户这一轮判死）。
     *   期望：stop×2（1.5s/6s）→ 硬重启 CLI → 重建会话 → 第 4 次送信成功。 */
    {
      const calls = [];
      const listeners = new Set();
      const stops = [];
      let sends = 0;
      let restarts = 0;
      const stuckFake = {
        disposed: false, calls, cliPath: '', cliNode: '', cwd: '', rpcTimeoutMs: 0, env: {}, lastChannel: null, onServerRequest: null,
        onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        write() {},
        notify(method) { if (method === 'session/stop') stops.push(method); },
        async ensureStarted() {},
        dispose() { this.disposed = true; },
        restart() { restarts += 1; this.disposed = false; },
        async request(method, params) {
          calls.push({ method, params });
          if (method === 'session/create') return { session: { sessionId: `sess-stuck-${restarts}` } };
          if (method === 'session/read') return { projection: { contextUsed: 999, contextWindow: 1000000 } };
          if (method === 'session/send') {
            sends += 1;
            if (sends <= 3) throw new Error('A prompt is already running for this session');
            for (const listener of listeners) listener({ method: 'session/event', params: done('ok') });
            return {};
          }
          return {};
        },
      };
      const stuckChunks = await runScript(
        stuckFake,
        { ...cfgBlock, appServerCredentialStorePath: join(tmp, 'no-creds.json') },
        { seed: false, sessionId: 's3' }
      );
      check(
        'appserver: 卡死恢复阶梯（stop×2 → 硬重启 CLI → 重建会话 → 第 4 次送信成功，不再把这一轮判死）',
        sends === 4 && stops.length === 2 && restarts === 1 &&
          calls.filter((c) => c.method === 'session/create').length === 2 &&
          stuckChunks.some((c) => c.type === 'finish' && c.reason?.kind === 'stop'),
        `sends=${sends} stops=${stops.length} restarts=${restarts} creates=${calls.filter((c) => c.method === 'session/create').length}`
      );
    }

    /* ⑤ 思考档真的下发给了 CLI：同一会话内换档 ⇒ 重发 session/setModel
     *   （旧实现只在建会话时设一次 ⇒ 用户在输入框换档位完全不生效）。 */
    {
      const fake = makeScriptClient([done('ok')]);
      const adapter = appServer.createAppServerAdapter({
        BaseAdapter: class {}, LlmError: class LlmError extends Error {},
        options: () => ({ ...cfgBlock, appServerCredentialStorePath: join(tmp, 'no-creds.json') }),
        logger: {}, gate: () => {},
      });
      adapter.client = fake;
      const consume = async (effort) => {
        for await (const _chunk of adapter.stream({
          provider: 'zcode-appserver', model: 'GLM-5.2', sessionId: 's2', reasoningEffort: effort,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) void _chunk;
      };
      await consume('low');
      await consume('max');
      adapter.dispose();
      const setModels = fake.calls.filter((c) => c.method === 'session/setModel').map((c) => c.params.model.options.reasoningLevel);
      check('appserver: 同一会话内换档 ⇒ 重发 session/setModel（low→max 各一次）', JSON.stringify(setModels) === JSON.stringify(['low', 'max']), JSON.stringify(setModels));
    }
  }

  // ── 凭据读取（只读 tmp fixture，零真实凭据）──
  {
    const secret = `zcode-credential-fallback:${process.platform}:${homedir()}:${(() => { try { return userInfo().username; } catch { return 'unknown'; } })()}`;
    const key2 = crypto.createHash('sha256').update(secret).digest();
    const encrypt = (plain) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key2, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
    };
    /* ⚠️ fixture 里 `oauth:active_provider` **必须也加密**（2026-10-10 真机踩到的坑）：
     * 真实凭据库里它同样是 `enc:v1:` 密文。若 fixture 用明文，`readStartPlanAuth` 就算
     * 忘了解密也照样通过 —— 于是"注入错家族"（静默回落 zai）在自检里永久假绿。
     * 这正是 §3.3「过紧/过松的断言会保护 bug」的同构案例。 */
    const good = tmpFile(
      'as-creds.json',
      JSON.stringify({ zcodejwttoken: encrypt('FAKE.JWT.TOKEN'), 'oauth:active_provider': encrypt('bigmodel') })
    );
    const auth = appServer.readStartPlanAuth(good);
    check(
      'appserver: 凭据库解密出 token + activeProvider（**两者都是密文**，决定注入哪个家族）',
      auth.token === 'FAKE.JWT.TOKEN' && auth.activeProvider === 'bigmodel',
      `activeProvider=${auth.activeProvider}`
    );

    const bad = tmpFile('as-creds-bad.json', JSON.stringify({ zcodejwttoken: 'enc:v1:AAAA.BBBB.CCCC' }));
    const badRejected = await assertRejects(Promise.resolve().then(() => appServer.readStartPlanAuth(bad)), /zcodejwttoken/);
    check('appserver: 凭据不可解 → 可操作错误（文案不含明文）', badRejected === true);

    const missing = await assertRejects(Promise.resolve().then(() => appServer.readStartPlanAuth(join(tmp, 'no-creds.json'))), /共享凭证库/);
    check('appserver: 凭据库缺失 → 可操作错误', missing === true);

    check('appserver: resolveAccountProviderId 依 activeProvider 自动选家族', appServer.resolveAccountProviderId({ appServerCredentialStorePath: good }) === 'account:bigmodel-start-plan');
    check('appserver: resolveAccountProviderId 显式配置优先', appServer.resolveAccountProviderId({ appServerCredentialStorePath: good, appServerAccountProviderId: 'account:zai-start-plan' }) === 'account:zai-start-plan');
    check('appserver: resolveAccountProviderId 读不到凭据也不抛（回 zai）', appServer.resolveAccountProviderId({ appServerCredentialStorePath: join(tmp, 'nope.json') }) === 'account:zai-start-plan');
  }

  // ── JSON-RPC 客户端：帧形状 / 应答 / 匹配 / 不悬挂 ──
  {
    const { EventEmitter } = await import('node:events');
    const { Readable, Writable } = await import('node:stream');
    const written = [];
    const fakeChild = new EventEmitter();
    fakeChild.pid = 4242;
    fakeChild.stdout = new Readable({ read() {} });
    fakeChild.stderr = new Readable({ read() {} });
    fakeChild.stdin = new Writable({ write(chunk, _e, cb) { written.push(String(chunk)); cb(); } });
    fakeChild.kill = () => {};

    const client = new appServer.AppServerClient({
      spawnImpl: () => fakeChild,
      cliPath: process.execPath, // 只为 existsSync 判定
      cliNode: 'node',
      env: {},
      cwd: tmp,
      rpcTimeoutMs: 2000,
      logger: {},
    });
    await client.ensureStarted();

    const pending = client.request('session/create', { a: 1 });
    check(
      'appserver: 请求帧 = 裸 {id, method, params}（带 jsonrpc 会被 -32600 拒）',
      JSON.stringify(JSON.parse(written[0])) === JSON.stringify({ id: 1, method: 'session/create', params: { a: 1 } })
    );

    let answered = null;
    client.onServerRequest = (msg) => {
      answered = msg;
      client.write({ id: msg.id, result: { ok: true } });
    };
    fakeChild.stdout.push(`${JSON.stringify({ id: 99, method: 'session/requestRuntimePreferences', params: { scope: 'x' } })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    check('appserver: 服务端请求被派发到 onServerRequest（必须应答，否则 agent 卡住）', answered?.method === 'session/requestRuntimePreferences');

    fakeChild.stdout.push(`${JSON.stringify({ id: 1, result: { session: { sessionId: 'sess_x' } } })}\n`);
    const res = await pending;
    check('appserver: 响应按 id 匹配并 resolve', res.session.sessionId === 'sess_x');

    const failing = client.request('session/send', {});
    const failId = JSON.parse(written[written.length - 1]).id;
    fakeChild.stdout.push(`${JSON.stringify({ id: failId, error: { message: 'boom' } })}\n`);
    let rejectedMsg = '';
    try {
      await failing;
    } catch (err) {
      rejectedMsg = err.message;
    }
    check('appserver: error 响应 → reject（上游文案透传）', rejectedMsg === 'boom');

    const split = client.request('x', {});
    const splitId = JSON.parse(written[written.length - 1]).id;
    fakeChild.stdout.push('not-json\n{"id":');
    fakeChild.stdout.push(`${splitId},"result":{"ok":1}}\n`);
    const okLine = await split;
    check('appserver: 坏行忽略 + NDJSON 分片重组', okLine.ok === 1);

    const seen = [];
    client.onNotification((msg) => seen.push(msg.method));
    fakeChild.stdout.push(`${JSON.stringify({ method: 'session/event', params: { type: 'turn.started' } })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    check('appserver: 通知派发到监听器', seen.join(',') === 'session/event');

    const hanging = client.request('never/answers', {});
    fakeChild.emit('exit', 1);
    let exitErr = '';
    try {
      await hanging;
    } catch (err) {
      exitErr = err.message;
    }
    check('appserver: 子进程退出 → 挂起请求 reject（绝不悬挂）', /已退出/.test(exitErr), exitErr);
    client.dispose();
  }
}


// ─── 7.5 client 半行为（stub 宿主 + stub react；T21 §3.5 + T22 §1.5-6） ──────
{
  const clientFile = join(PLUGIN_ROOT, 'lib', 'client.js');
  const clientSource = readFileSync(clientFile, 'utf8');
  let parsed = null;
  try {
    new Function(clientSource); // 仅解析不执行
    parsed = true;
  } catch (err) {
    parsed = err;
  }
  check('client: 语法合法（new Function 解析）', parsed === true, parsed instanceof Error ? parsed.message : '');
  check('client: 信封自足（零静态 import；require 仅限宿主提供的 react）', !/\bimport\s/.test(clientSource) && !/require\("(?!react")/.test(clientSource));

  const hadWindow = typeof globalThis.window !== 'undefined';
  const realWindow = globalThis.window;
  let loaded = null;
  globalThis.window = { __ModuleLoader__: { load: (def) => { loaded = def; } } };
  /** 元素树工具（stub createElement 产物 {type, props, children}）。 */
  const findAllEls = (root, pred) => {
    const out = [];
    const walkFn = (node) => {
      if (!node || typeof node !== 'object') return;
      if (pred(node)) out.push(node);
      for (const child of node.children ?? []) walkFn(child);
    };
    walkFn(root);
    return out;
  };
  const byDataRole = (root, role) => findAllEls(root, (n) => n.type === 'input' && n.props?.['data-role'] === role);
  try {
    new Function(clientSource)(); // 执行信封 → load 被捕获（factory 不在此刻求值）
    check('client: ModuleLoader 信封执行即交付 factory（id=包名）', !!loaded && typeof loaded.factory === 'function' && loaded.id === 'dsh-connect-zcode', `id=${loaded?.id ?? 'null'}`);
    const reactStub = {
      createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {},
    };
    const clientExports = loaded.factory((spec) => (spec === 'react' ? reactStub : {}));
    /* inject 断言（2026-10-01 真机实证后修正）：
     * 原断言要求「只声明 slots」——那是 T21 过度优化的产物，且**直接导致了面板永久只读**
     * （configForms 由 ui-settings 的 client 半提供，而它需要组合里先有 remote 服务）。
     * 正确契约：必须声明 slots + locale + remote（两个已证可用的参照取并集），
     * 且 manifest 的 dsh.client.inject 必须含提供 remote 的 @deepseek-ai/dsh-api-remotes。
     * 见 lib/client.js 的 inject 注释与 pitfalls §10.7。 */
    check(
      'client: 导出 apply/inject/name 且 inject 含 slots+locale+remote（面板可写前提）',
      typeof clientExports?.apply === 'function' &&
        Array.isArray(clientExports?.inject) &&
        ['slots', 'locale', 'remote'].every((s) => clientExports.inject.includes(s)) &&
        typeof clientExports?.name === 'string',
      JSON.stringify(clientExports?.inject)
    );
    check(
      'client: manifest dsh.client.inject 含 api-remotes（提供 remote，configForms 前置）',
      (() => {
        const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
        const list = pkg?.dsh?.client?.inject ?? [];
        return list.includes('@deepseek-ai/dsh-api-remotes') && list.includes('@deepseek-ai/dsh-client-ui-settings');
      })(),
      JSON.stringify(JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))?.dsh?.client?.inject)
    );
    check(
      'client: manifest 有顶层 description/displayName（插件列表显示描述行）',
      (() => {
        const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
        return typeof pkg.description === 'string' && pkg.description.length > 0 && typeof pkg.displayName === 'string' && pkg.displayName.length > 0;
      })()
    );

    const slotInjects = [];
    const slotRegisters = [];
    const stubCtx = () => ({
      get: () => undefined, // configForms 缺席 → 软探测降级（只读），绝不抛
      slots: {
        inject: (slotName, registrar) => slotInjects.push({ slotName, registrar }),
        register: (desc, component) => slotRegisters.push({ desc, component }),
      },
    });
    let applyThrew = null;
    try {
      clientExports.apply(stubCtx());
    } catch (err) {
      applyThrew = err;
    }
    check(
      'client: apply 在服务缺失 stub ctx 下不抛且注册两个槽位（设置卡 + composer 进度条）',
      applyThrew === null &&
        slotInjects.length === 2 &&
        slotInjects[0].slotName === 'plugins.bundle.config' &&
        slotInjects[1].slotName === 'conversation.composer.dock',
      `injects=${slotInjects.map((s) => s.slotName).join(',')} ${applyThrew?.message ?? ''}`
    );
    slotInjects[0]?.registrar?.();
    slotInjects[1]?.registrar?.();
    const card = slotRegisters[0];
    check('client: 卡 key = bundle 包名 + priority 30（slot 契约）', card?.desc?.key === 'dsh-connect-zcode' && card?.desc?.priority === 30 && card?.desc?.name === 'plugins.bundle.config', JSON.stringify(card?.desc ?? null));
    check('client: 卡组件为函数（React 函数组件，无构建链）', typeof card?.component === 'function');
    /* list 型槽位（composer.dock）的注册契约与 single 不同：必须带 `id`（同 priority 下唯一），
     * `order` 参与同槽位排序。官方先例：chat 注册 { id: "stats", order: 0 }。 */
    const dock = slotRegisters.find((entry) => entry.desc?.id === 'zcode-quota-bar');
    check(
      'client: composer dock 注册描述符符合 list 型契约（name + id + order）',
      dock !== undefined &&
        dock.desc.name === 'conversation.composer.dock' &&
        typeof dock.desc.id === 'string' && dock.desc.id.length > 0 &&
        Number.isInteger(dock.desc.order),
      JSON.stringify(dock?.desc ?? null)
    );
    /* 刷新机制：面板与输入框进度条必须**共用**一个轮询器（单定时器 + 单 fetch 源）。
     * 各自 setInterval 有两个后果：① 双份请求；② 两处 `useState` 副本各自演进
     * ⇒ 同一个额度在两处显示成不同时刻的值，用户看到"两个数对不上"。 */
    const clientSrcForPoll = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8');
    const countOf = (re) => (clientSrcForPoll.match(re) ?? []).length;
    check(
      'client: 状态文档共享轮询 —— 单一定时器 + 单一 fetch 源（面板与进度条不各自轮询）',
      countOf(/setInterval\(/g) === 1 && /STATUS_POLL_MS\s*=\s*60000/.test(clientSrcForPoll) && countOf(/fetch\(STATUS_PATH/g) === 1,
      `setInterval=${countOf(/setInterval\(/g)} fetch=${countOf(/fetch\(STATUS_PATH/g)}`
    );
    check(
      'client: 两个消费者都走 subscribeStatusDoc（面板 + composer 进度条）',
      countOf(/subscribeStatusDoc\(\{/g) === 2,
      `sites=${countOf(/subscribeStatusDoc\(\{/g)}`
    );
    check(
      'client: 定时器随订阅者增减（最后一个消费者卸载即撤销，不留后台空转）',
      /listeners\.size === 0[\s\S]{0,120}clearInterval\(STATUS_STORE\.timer\)/.test(clientSrcForPoll)
    );
    check(
      'client: 面板刷新受 view 门禁（summary 视图不订阅、不拉状态）',
      /if \(view !== "page"\) return void 0;[\s\S]{0,400}subscribeStatusDoc\(\{/.test(clientSrcForPoll)
    );

    const scope = { getSnapshot: () => ({ status: 'unavailable', value: void 0, writable: false }), subscribe: () => () => {}, set: async () => false };
    let summaryEl = null;
    let pageEl = null;
    try {
      summaryEl = card.component({ settingsScope: scope, statusRef: { current: null }, view: 'summary' });
    } catch (err) {
      summaryEl = err;
    }
    try {
      pageEl = card.component({ settingsScope: scope, statusRef: { current: null }, view: 'page' });
    } catch (err) {
      pageEl = err;
    }
    check(
      'client: summary/page 双视图渲染不抛且产出元素',
      !(summaryEl instanceof Error) && !(pageEl instanceof Error) && !!summaryEl && !!pageEl,
      `${summaryEl?.message ?? ''} ${pageEl?.message ?? ''}`
    );
    check('client: page 视图在状态路由缺席时回退静态表（3 个显隐勾选行，T22 裁剪）', byDataRole(pageEl, 'enable').length === 3, `enable=${byDataRole(pageEl, 'enable').length}`);
    check('client: 勾选语义文案在场（全部不勾 = 全部显示）', JSON.stringify(pageEl).includes('全部不勾 = 全部显示'));

    /* T22 §1.5-6：带权威事实目录 + 可写配置的面板行控件断言。
     * 配置：GLM-5.3 已勾 1M；FlashX 推理开；目录：GLM-5.3/Flash 官方（Flash 含图）。 */
    const factsScope = {
      getSnapshot: () => ({
        status: 'ready',
        writable: true,
        value: { enabledModelIds: [], contextBudgets: { 'glm-5.3': 1000000 }, modelOverrides: { 'glm-5.3-flashx': { reasoning: true } } },
      }),
      subscribe: () => () => {},
      set: async () => true,
    };
    const statusDoc = {
      frozen: false,
      modelsTotal: 3,
      models: [
        { id: 'glm-5.3', name: 'GLM-5.3', official: true, has1m: true, imageSupported: false, reasoningVariants: ['low', 'max', 'high'] },
        { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', official: true, has1m: true, imageSupported: true, reasoningVariants: ['low', 'max', 'high'] },
        { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX', official: false, has1m: false, imageSupported: false, reasoningVariants: [] },
      ],
    };
    let factsPage = null;
    try {
      factsPage = card.component({ settingsScope: factsScope, statusRef: { current: statusDoc }, view: 'page' });
    } catch (err) {
      factsPage = err;
    }
    check('client: 事实目录 + 可写配置 page 渲染不抛', !(factsPage instanceof Error) && !!factsPage, factsPage?.message);
    const rows = findAllEls(factsPage, (n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('dzc-model'));
    const rowById = (id) => rows.find((r) => r.props?.key === id);
    const rowBox = (id, role) => byDataRole(rowById(id), role)[0];
    check('client: 行布局 3 行（一行一模型）', rows.length === 3, `rows=${rows.length}`);
    check('client: 官方徽标 2 枚（·官方）', findAllEls(factsPage, (n) => n.props?.className === 'dzc-badge').length === 2);
    check('client: 1M 单选只在官方 Max 档模型出现（2 枚；FlashX 无 1M）', byDataRole(factsPage, 'ctx-1m').length === 2 && byDataRole(factsPage, 'ctx-base').length === 3 && byDataRole(rowById('glm-5.3-flashx'), 'ctx-1m').length === 0);
    check('client: 已配预算模型 1M 选中、未配模型 200K 选中', rowBox('glm-5.3', 'ctx-1m')?.props.checked === true && rowBox('glm-5.3-flash', 'ctx-1m')?.props.checked === false && rowBox('glm-5.3-flashx', 'ctx-base')?.props.checked === true);
    check('client: 官方行图片锁定（GLM-5.3 关+disabled / Flash 开+disabled）', rowBox('glm-5.3', 'image')?.props.disabled === true && rowBox('glm-5.3', 'image')?.props.checked === false && rowBox('glm-5.3-flash', 'image')?.props.disabled === true && rowBox('glm-5.3-flash', 'image')?.props.checked === true);
    check('client: FlashX 图片/推理开关可用（推理开反映配置）', rowBox('glm-5.3-flashx', 'image')?.props.disabled === false && rowBox('glm-5.3-flashx', 'image')?.props.checked === false && rowBox('glm-5.3-flashx', 'reasoning')?.props.checked === true && rowBox('glm-5.3-flashx', 'reasoning')?.props.disabled === false);
    check('client: 官方行无推理开关（只展示锁定档位）', byDataRole(rowById('glm-5.3'), 'reasoning').length === 0 && byDataRole(rowById('glm-5.3-flash'), 'reasoning').length === 0);
    check('client: 官方推理档锁定文案在场（low / max / high）', JSON.stringify(factsPage).includes('推理档：low / max / high（官方，锁定）'));
    check('client: FlashX 无官方数据提示在场', JSON.stringify(factsPage).includes('未提供官方数据'));
    check('client: 概览含上下文预算行（1 个模型已切 1M）', JSON.stringify(factsPage).includes('上下文预算') && JSON.stringify(factsPage).includes('1 个模型已切 1M'));
    check('client: 1M 实测差异提示在场（CLI 实测 200k）', JSON.stringify(factsPage).includes('CLI 实测有效窗口 200k'));

    /* ── 赠送额度进度条（composer dock）：**行为**断言而非源码正则 ──
     * 三种 state 的语义差异是本功能的红线：
     *   active  → 填充 = 剩余/总量，悬浮「剩余 X / 总量 Y」；
     *   pending → 余额桶还没建，剩余**不可知** ⇒ 绝不能用总量冒充剩余（那会显示成"一分没用"）；
     *   其余    → 整块不渲染（宁可不显示，也不给误导数字）。 */
    const dockComp = dock?.component;
    const activeQuota = {
      ok: true, state: 'active', totalUnits: 300000000, remainingUnits: 30000000, usedUnits: 270000000,
      model: 'GLM-5.3-Flash', planName: 'ZCode Weekend Build', effectiveAt: 0, observedAt: '2026-10-10T12:12:30.119Z',
    };
    const pendingQuota = {
      ok: true, state: 'pending', totalUnits: 300000000, remainingUnits: null, usedUnits: null,
      model: 'GLM-5.3-Flash', planName: 'ZCode Weekend Build', effectiveAt: 1791644400, observedAt: null,
    };
    const pickBar = (node, cls) =>
      findAllEls(node, (n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls))[0];
    /* 门禁所需的 `modelSelection` 投影桩（宿主真实形状：{next|pending|lastUsed:{provider,model}}）。
     * 默认选中赠送额度那条 provider —— 否则按新门禁**整块不渲染**（这正是本轮新增的行为）。 */
    const projectionFor = (provider, model = 'GLM-5.3-Flash') => () => ({ next: { provider, model } });
    const ownedProjection = projectionFor('zcode-appserver');
    const barActive = dockComp({ statusRef: { current: { planQuota: activeQuota } }, useProjection: ownedProjection });
    const barPending = dockComp({ statusRef: { current: { planQuota: pendingQuota } }, useProjection: ownedProjection });
    const barNone = dockComp({ statusRef: { current: {} }, useProjection: ownedProjection });
    const rootActive = pickBar(barActive, 'dzc-quota');
    const rootPending = pickBar(barPending, 'dzc-quota');
    check(
      'client: 进度条 active — 悬浮提示为「剩余/总量」（用户要求的确切形状）',
      typeof rootActive?.props?.title === 'string' && rootActive.props.title.includes('剩余 30,000,000 / 总量 300,000,000'),
      rootActive?.props?.title
    );
    check(
      'client: 进度条 active — 填充比例 = 剩余/总量（10%）',
      pickBar(barActive, 'dzc-quota-fill')?.props?.style?.width === '10.00%' &&
        JSON.stringify(barActive).includes('赠送额度 剩余') && JSON.stringify(barActive).includes('10%'),
      JSON.stringify(pickBar(barActive, 'dzc-quota-fill')?.props?.style)
    );
    check(
      'client: 进度条 pending — 不把总量冒充剩余（提示「剩余 —（未生效）」+ 满格）',
      typeof rootPending?.props?.title === 'string' &&
        rootPending.props.title.includes('剩余 —（未生效） / 总量 300,000,000') &&
        pickBar(barPending, 'dzc-quota-fill-idle')?.props?.style?.width === '100.00%' &&
        JSON.stringify(barPending).includes('待生效'),
      rootPending?.props?.title
    );
    check('client: 进度条 — 无额度数据/不可用时整块不渲染（不给误导数字）', barNone === null && findAllEls(barActive, (n) => n.type === 'div').length > 0, String(barNone));

    /* ── 显示门禁：**只有选中赠送额度那条 provider 的模型才显示** ──
     * 依据是宿主自己的 modelSelection 投影（模型选择器写什么、下一次请求用什么就是它），
     * 所以不会出现"显示着赠送额度、实际烧的却是 Coding Plan"的错配。 */
    {
      const atProvider = (provider) => dockComp({ statusRef: { current: { planQuota: activeQuota } }, useProjection: projectionFor(provider) });
      check(
        'client: 门禁 — 选中 Coding Plan（zcode）时进度条不显示',
        atProvider('zcode') === null,
        String(atProvider('zcode'))
      );
      check(
        'client: 门禁 — 选中赠送额度（zcode-appserver）时才显示',
        pickBar(atProvider('zcode-appserver'), 'dzc-quota') !== undefined
      );
      /* 投影缺席/形状未知 → 不渲染（且 warn 一次，让"凭空消失"可排查）。 */
      check('client: 门禁 — useProjection 缺席时整块不渲染（不猜）', dockComp({ statusRef: { current: { planQuota: activeQuota } } }) === null);
      check(
        'client: 门禁 — 投影形状不认识时也不渲染（含 next/pending/lastUsed 三种候选）',
        dockComp({ statusRef: { current: { planQuota: activeQuota } }, useProjection: () => ({ lastUsed: null }) }) === null &&
          dockComp({ statusRef: { current: { planQuota: activeQuota } }, useProjection: () => ({ pending: { provider: 'zcode-appserver', model: 'GLM-5.3-Flash' } }) }) !== null &&
          dockComp({ statusRef: { current: { planQuota: activeQuota } }, useProjection: () => ({ lastUsed: { provider: 'zcode-appserver', model: 'GLM-5.3-Flash' } }) }) !== null
      );
      check(
        'client: 门禁 — 投影抛异常被吞（不让输入框崩）',
        dockComp({ statusRef: { current: { planQuota: activeQuota } }, useProjection: () => { throw new Error('boom'); } }) === null
      );
    }
    check(
      'client: 面板含「赠送额度」行且与进度条同源',
      (() => {
        const page = card.component({ settingsScope: scope, statusRef: { current: { planQuota: activeQuota } }, view: 'page' });
        return JSON.stringify(page).includes('赠送额度') && JSON.stringify(page).includes('剩余 30,000,000 / 总量 300,000,000');
      })()
    );

    /* ── 面板「赠送额度通道」区块（用户要求：把 GLM-5.3-Flash（赠送额度）也做进面板） ──
     * 它是**独立区块**，事实来源 = 状态文档的 appServer 段；未就绪时必须给出可操作原因。 */
    {
      const giftStatus = {
        enabled: true,
        registered: true,
        cliPath: 'F:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs',
        toolPolicy: 'allow-all',
        reasoningLevel: 'max',
        models: [{ id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash（赠送额度）', contextWindow: 200000 }],
      };
      const giftPage = card.component({ settingsScope: scope, statusRef: { current: { appServer: giftStatus } }, view: 'page' });
      const giftBoxes = byDataRole(giftPage, 'gift-enable');
      check(
        'client: 面板含「赠送额度通道」独立区块 + 该通道模型行（勾选与 200K/1M 单选在场）',
        JSON.stringify(giftPage).includes('赠送额度通道') &&
          giftBoxes.length === 1 &&
          giftBoxes[0]?.props?.['data-model'] === 'GLM-5.3-Flash' &&
          byDataRole(giftPage, 'gift-ctx-1m').length === 1 &&
          byDataRole(giftPage, 'gift-ctx-base').length === 1,
        `giftRows=${giftBoxes.length}`
      );
      check(
        'client: 赠送额度行标注「赠送额度」徽标 + 图片能力如实反映（未接 attachments → 未启用）',
        JSON.stringify(giftPage).includes('赠送额度') &&
          JSON.stringify(giftPage).includes('图片：未启用') &&
          /* 思考档由「锁定文案」升级为**官方事实 + 可切换**（2026-10-10 用户要求补思考模式）：
           * 行内标注官方档位，切换入口是输入框的模型选择器。 */
          JSON.stringify(giftPage).includes('思考档：low / high / max（官方；默认 max')
      );
      check(
        'client: 赠送额度区块含「默认思考档」单选（data-role=gift-reasoning，档位来自状态文档）',
        byDataRole(giftPage, 'gift-reasoning').length === 3 &&
          JSON.stringify(byDataRole(giftPage, 'gift-reasoning').map((r) => r.props['data-level'])) ===
            JSON.stringify(['low', 'high', 'max']) &&
          JSON.stringify(giftPage).includes('默认思考档'),
        `reasoningRadios=${byDataRole(giftPage, 'gift-reasoning').length}`
      );
      check(
        'client: 通道已注册时显示 CLI 与工具策略（可核对真实注册结果）',
        JSON.stringify(giftPage).includes('已注册') && JSON.stringify(giftPage).includes('allow-all')
      );
      check(
        'client: 图片能力就绪时该行显示"支持"（与 host 的 canImages 活判一致，不写死）',
        JSON.stringify(card.component({
          settingsScope: scope,
          statusRef: { current: { appServer: { ...giftStatus, imagesSupported: true } } },
          view: 'page',
        })).includes('图片：支持')
      );
      const offPage = card.component({
        settingsScope: scope,
        statusRef: { current: { appServer: { enabled: false, registered: false, models: [] } } },
        view: 'page',
      });
      check(
        'client: 通道未启用 → 区块给可操作提示而非空列表（不显示不存在的模型）',
        JSON.stringify(offPage).includes('通道未就绪') && byDataRole(offPage, 'gift-enable').length === 0
      );
      const failPage = card.component({
        settingsScope: scope,
        statusRef: { current: { appServer: { enabled: true, registered: false, reason: '没探测到 ZCode CLI（zcode.cjs）', models: [] } } },
        view: 'page',
      });
      check(
        'client: 启用但注册失败 → 区块显示具体原因（"模型不见了"要能自查）',
        JSON.stringify(failPage).includes('已启用但未注册') && JSON.stringify(failPage).includes('没探测到 ZCode CLI')
      );
      check('client: 面板保存路径包含 appServerModels（赠送额度显隐写回配置）', /writeField\(settingsScope, "appServerModels"/.test(clientSrcForPoll));
      /* 默认思考档（2026-10-10 用户要求"给赠送的 5.3-Flash 加上思考模式"）：
       * 面板单选写 appServerReasoningLevel，档位候选来自状态文档（官方 variants），不硬编码。 */
      check(
        'client: 面板写回默认思考档（appServerReasoningLevel），单选档位来自状态文档',
        /writeField\(\s*settingsScope,\s*"appServerReasoningLevel"/.test(clientSrcForPoll) &&
          /"data-role": "gift-reasoning"/.test(clientSrcForPoll) &&
          /giftReasoningLevels/.test(clientSrcForPoll) &&
          /storedGiftReasoning/.test(clientSrcForPoll)
      );
    }
  } finally {
    if (hadWindow) globalThis.window = realWindow;
    else delete globalThis.window;
  }
}

/* 归还 console（本段开头替换过；DE-04 断言已在上面消费完 warns/logs）。 */
console.warn = REAL_WARN;
console.log = REAL_LOG;

/* client 半是 ModuleLoader 信封 bundle，**零静态 import** 是防拒启红线（T21），
 * 因此 STATUS_PATH / STATIC_MODEL_IDS / CONTEXT_1M 只能以字面量副本存在。
 * 但"不能共享"不等于"不能守卫"：在此之前三个副本**没有任何一致性断言**，
 * 漂移即静默失效，且三种后果都不报错：
 *   - STATUS_PATH 改一边 → 面板 fetch 404（有降级提示，尚可排查）；
 *   - STATIC_MODEL_IDS 改一边 → 降级视图与实际目录不一致；
 *   - CONTEXT_1M 最危险 → 面板写入值 ≠ host 比对的官方 maxContextWindow
 *     ⇒ 用户勾了 1M 但 contextWindow 仍是 200000，**无任何提示**。
 * 故此处用源码级字符串断言把三处钉死（client.js 无法 import，只能读源码比对）。 */
{
  const clientSrc = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8');
  const norm = (s) => s.replace(/["'\s]/g, '');

  // ① STATUS_PATH 与 host 半 ZCODE_STATUS_PATH 一致
  const hostStatusPath = webStatus.ZCODE_STATUS_PATH;
  check(
    'DE-10 守卫: client STATUS_PATH 与 host ZCODE_STATUS_PATH 同值',
    norm(clientSrc).includes(`STATUS_PATH=${hostStatusPath}`),
    `host=${hostStatusPath}`
  );

  // ② client 的 STATIC_MODEL_IDS 与 host GLM53_FAMILY 深比对（逐项 + 顺序）
  const m = clientSrc.match(/STATIC_MODEL_IDS\s*=\s*(\[[^\]]*\])/);
  let clientIds = null;
  try {
    clientIds = m ? JSON.parse(m[1]) : null;
  } catch {
    clientIds = null;
  }
  check(
    'DE-10 守卫: client STATIC_MODEL_IDS 与 host GLM53_FAMILY 逐项同值同序',
    Array.isArray(clientIds) && JSON.stringify(clientIds) === JSON.stringify(modelMeta.GLM53_FAMILY),
    `client=${JSON.stringify(clientIds)} host=${JSON.stringify(modelMeta.GLM53_FAMILY)}`
  );

  // ③ CONTEXT_1M 与官方 meta 声明的 Max 档一致（官方值一变，面板写入就静默失效）
  const officialContext = fixtureModels()['GLM-5.3']?.limit?.context;
  check(
    'DE-10 守卫: client CONTEXT_1M 等于官方 limit.context（否则 1M 勾选静默失效）',
    norm(clientSrc).includes(`CONTEXT_1M=${officialContext}`) && officialContext === 1000000,
    `client 声明 1000000 / 官方 fixture ${officialContext}`
  );

  // ④ 跨半命名空间常量：client 的精确分支必须等于 patch 里的 entry id（R-17）
  const patchSrc = readFileSync(join(PLUGIN_ROOT, 'cordis.patch.yml'), 'utf8');
  const patchId = patchSrc.match(/^\s*-?\s*id:\s*(\S+)/m)?.[1];
  check(
    'DE-10 守卫: client NS_EXACT 等于 cordis.patch.yml 的 entry id（R-17 精确命中）',
    typeof patchId === 'string' && norm(clientSrc).includes(`NS_EXACT=${patchId}`),
    `patch id=${patchId}`
  );

  // ⑤ 赠送额度通道的 provider id：client 的门禁常量必须等于 host 注册的 provider id。
  // 漂移的后果是**静默**的：进度条永远不显示（选中了也不显示），且没有任何报错。
  check(
    'DE-10 守卫: client QUOTA_PROVIDER_ID 等于 host APPSERVER_PROVIDER_ID（漂移=进度条永不显示）',
    norm(clientSrc).includes(`QUOTA_PROVIDER_ID=${appServer.APPSERVER_PROVIDER_ID}`),
    `host=${appServer.APPSERVER_PROVIDER_ID}`
  );
}

// ─── 7.6 赠送额度读取（lib/plan-quota.js；纯静态 + 临时日志 fixture） ──────────
{
  const NOW = 1791634348 * 1000; // 2026-10-10 20:12:28 CST 附近
  const ENDS = 1791766800;       // 10-12 09:00
  const EFFECTIVE = 1791644400;  // 10-10 23:00
  const START_PLAN_ID = 'zcode-v3-start-plan-1010';

  const payloadOf = ({ planId = START_PLAN_ID, total = 300000000, remaining = 30000000, effectiveAt = 0, endsAt = ENDS, withBucket = true } = {}) => ({
    payload: {
      data: {
        server_time: Math.floor(NOW / 1000),
        plans: [{
          plan_id: planId, name: 'ZCode Weekend Build', status: 'active',
          starts_at: 1791634329, ends_at: endsAt,
          entitlements: [{ entitlement_id: 'ent-1', show_name: 'GLM-5.3-Flash', meter: 'model_usage', unit_type: 'token', grant_units: total, period: 'one_time', effective_at: effectiveAt }],
        }],
        balances: withBucket
          ? [{ entitlement_id: 'ent-1', plan_id: planId, show_name: 'GLM-5.3-Flash', total_units: total, used_units: total - remaining, remaining_units: remaining, available_units: remaining, expires_at: endsAt }]
          : [],
      },
    },
  });

  const active = planQuota.normalizeQuota(payloadOf(), NOW);
  check(
    'plan-quota: active 直接取余额桶的 remaining/total（不自算 total-used，避免口径漂移）',
    active.ok === true && active.state === 'active' && active.totalUnits === 300000000 &&
      active.remainingUnits === 30000000 && active.usedUnits === 270000000 &&
      active.planName === 'ZCode Weekend Build' && active.model === 'GLM-5.3-Flash',
    JSON.stringify({ state: active.state, total: active.totalUnits, remaining: active.remainingUnits })
  );
  check('plan-quota: active 带上窗口时间供面板显示生效/过期', active.effectiveAt === 0 && active.endsAt === ENDS);

  const pending = planQuota.normalizeQuota(payloadOf({ effectiveAt: EFFECTIVE, withBucket: false }), NOW);
  check(
    'plan-quota: 权益未生效（无余额桶）→ pending，且**不拿 grant_units 冒充 remaining**',
    pending.ok === true && pending.state === 'pending' && pending.totalUnits === 300000000 &&
      pending.remainingUnits === null && pending.effectiveAt === EFFECTIVE,
    JSON.stringify({ state: pending.state, remaining: pending.remainingUnits })
  );
  const pendingNoEffective = planQuota.normalizeQuota(payloadOf({ withBucket: false }), NOW);
  check('plan-quota: 无桶且无 effective_at 也判 pending（不猜"剩余=总量"）', pendingNoEffective.state === 'pending' && pendingNoEffective.remainingUnits === null);

  const expired = planQuota.normalizeQuota(payloadOf({ endsAt: 1791000000 }), NOW);
  check('plan-quota: 窗口结束 → expired（面板据此不显示进度条）', expired.state === 'expired');

  const codingOnly = planQuota.normalizeQuota(payloadOf({ planId: 'zcode-v3-coding-plan' }), NOW);
  check('plan-quota: 非 start-plan 计划 → ok:false no-start-plan（本功能只服务赠送额度）', codingOnly.ok === false && codingOnly.reason === 'no-start-plan');
  check('plan-quota: 坏负载不抛（null / 缺 data / 空对象）',
    planQuota.normalizeQuota(null, NOW).reason === 'no-payload' &&
    planQuota.normalizeQuota({}, NOW).reason === 'no-payload' &&
    planQuota.normalizeQuota({ payload: {} }, NOW).reason === 'no-payload');

  /* 多份 start-plan 叠加时取结束最晚的那份（避免拿一份已过期的当当前档）。 */
  {
    const two = payloadOf();
    two.payload.data.plans.push({
      plan_id: 'zcode-v3-start-plan-older', name: 'Older', status: 'active', starts_at: 1, ends_at: 100,
      entitlements: [{ entitlement_id: 'ent-old', show_name: 'GLM-5.3-Flash', grant_units: 1, effective_at: 0 }],
    });
    const picked = planQuota.normalizeQuota(two, NOW);
    check('plan-quota: 多份 start-plan → 取 ends_at 最晚者', picked.planId === START_PLAN_ID, picked.planId);
  }

  /* 端到端：从 fixture 日志尾部倒读，必须命中**最后一条** billing/balance（而不是第一条）。 */
  {
    const logLine = (ts, payload) => `[${ts}] [info] [pid:1] [main] [host-log] (local-1) [host] [usage-stats] billing/balance 请求完成 ${JSON.stringify(payload)}`;
    const logDir = join(tmp, 'zq-logs');
    tmpFile(
      join('zq-logs', '2026-10-10.log'),
      [
        logLine('2026-10-10 20:12:30.119', payloadOf({ remaining: 111111111 })),
        '中间夹杂无关行，不应干扰解析',
        logLine('2026-10-10 21:30:00.000', payloadOf({ remaining: 222222222 })),
      ].join('\n') + '\n'
    );
    const real = planQuota.readPlanQuota({ logDir, nowMs: NOW });
    check(
      'plan-quota: 尾部倒读命中最后一条 billing/balance（不是第一条）',
      real.ok === true && real.remainingUnits === 222222222 && real.logFile === '2026-10-10.log',
      JSON.stringify({ remaining: real.remainingUnits, file: real.logFile })
    );
    check('plan-quota: 解析出行首时刻（供面板显示"数据时间"）', typeof real.observedAt === 'string' && /^2026-10-10T/.test(real.observedAt), String(real.observedAt));
    check('plan-quota: 目录不存在 → no-log（不抛、不猜）', planQuota.readPlanQuota({ logDir: join(tmp, 'no-such-logdir'), nowMs: NOW }).reason === 'no-log');
  }
  {
    tmpFile(join('zq-empty2', '2026-10-10.log'), 'nothing here\n');
    check('plan-quota: 有日志文件但无目标行 → no-balance-line', planQuota.readPlanQuota({ logDir: join(tmp, 'zq-empty2'), nowMs: NOW }).reason === 'no-balance-line');
  }

  /* 出站脱敏与状态文档：只出数值与短字符串，绝不夹带原始负载。 */
  {
    const summary = webStatus.toQuotaSummary(active);
    check(
      'plan-quota: 状态文档摘要只含数值与短字符串（无原始负载字段）',
      summary.ok === true && summary.source === 'zcode-log' &&
        !('payload' in summary) && !('balances' in summary) && !('entitlements' in summary) &&
        summary.totalUnits === 300000000,
      JSON.stringify(summary)
    );
    const failed = webStatus.toQuotaSummary({ ok: false, reason: 'no-log' });
    check('plan-quota: 失败摘要保留可诊断 reason', failed.ok === false && failed.reason === 'no-log');
    const docWith = webStatus.buildStatusDocument({
      registered: () => true, readSwitch: () => ({ enabled: true }), endpointHost: () => 'x',
      catalog: () => [], enabledModelIds: () => [], planQuota: () => active,
    });
    const docWithout = webStatus.buildStatusDocument({
      registered: () => true, readSwitch: () => ({ enabled: true }), endpointHost: () => 'x',
      catalog: () => [], enabledModelIds: () => [],
    });
    check('plan-quota: 状态文档带 planQuota 字段（缺 provider 时不硬塞）', docWith.planQuota?.ok === true && docWithout.planQuota === undefined);
    const docThrows = webStatus.buildStatusDocument({
      registered: () => true, readSwitch: () => ({ enabled: true }), endpointHost: () => 'x',
      catalog: () => [], enabledModelIds: () => [],
      planQuota: () => { throw new Error('boom'); },
    });
    check('plan-quota: 读取抛错不打挂状态文档（降级为 reason）', docThrows.planQuota?.ok === false && /read-failed/.test(docThrows.planQuota.reason));

    /* ── 状态文档的 appServer 段（面板「赠送额度通道」区块的数据源）── */
    {
      const summary = webStatus.toAppServerSummary({
        enabled: true,
        registered: true,
        reason: null,
        cliPath: 'F:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs',
        toolPolicy: 'allow-all',
        reasoningLevel: 'max',
        providerId: 'zcode-appserver',
        imagesSupported: true,
        models: [
          { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash（赠送额度）', contextWindow: 200000, reasoningLevels: ['low', 'high', 'max'], defaultReasoningLevel: 'high' },
          { bad: true },
          null,
        ],
      });
      check(
        'appserver: 状态摘要只出布尔/短串/模型列表（坏行被剔）',
        summary.enabled === true && summary.registered === true && summary.models.length === 1 &&
          summary.models[0].id === 'GLM-5.3-Flash' && summary.providerId === 'zcode-appserver' &&
          summary.imagesSupported === true
      );
      /* 面板的「默认思考档」单选只能靠这份事实渲染（不硬编码档位）⇒ 必须随模型行下发。 */
      check(
        'appserver: 状态摘要带每模型思考档事实（面板单选的数据源；非法项被剔）',
        JSON.stringify(summary.models[0].reasoningLevels) === JSON.stringify(['low', 'high', 'max']) &&
          summary.models[0].defaultReasoningLevel === 'high' &&
          JSON.stringify(webStatus.toAppServerSummary({ models: [{ id: 'm', reasoningLevels: ['ok', 42, ''] }] }).models[0].reasoningLevels) === JSON.stringify(['ok']) &&
          webStatus.toAppServerSummary({ models: [{ id: 'm' }] }).models[0].defaultReasoningLevel === null
      );
      check('appserver: 缺字段时安全兜底（不抛、不假报启用）', (() => {
        const s = webStatus.toAppServerSummary(undefined);
        return s.enabled === false && s.registered === false && Array.isArray(s.models) && s.models.length === 0;
      })());
      const doc = webStatus.buildStatusDocument({
        registered: () => true, readSwitch: () => ({ enabled: true }), endpointHost: () => 'x',
        catalog: () => [], enabledModelIds: () => [],
        appServer: () => ({ enabled: false, registered: false, reason: 'x', models: [] }),
      });
      check('appserver: 状态文档带 appServer 段（未启用时面板据此显示提示）', doc.appServer?.enabled === false && doc.appServer.reason === 'x');
      const docThrows2 = webStatus.buildStatusDocument({
        registered: () => true, readSwitch: () => ({ enabled: true }), endpointHost: () => 'x',
        catalog: () => [], enabledModelIds: () => [],
        appServer: () => { throw new Error('boom'); },
      });
      check('appserver: 读取抛错不打挂状态文档', docThrows2.appServer?.registered === false && /read-failed/.test(docThrows2.appServer.reason));
    }

    /* ── 适配器：contextBudgets 覆盖上下文窗口（面板 200K/1M 单选真的生效）── */
    {
      const mk = (contextBudgets, supportsImages) => appServer.createAppServerAdapter({
        BaseAdapter: class {},
        LlmError: class LlmError extends Error {},
        options: () => ({
          zcodeCliPath: process.execPath, zcodeCliNode: 'node', appServerWorkspace: homedir(),
          zcodeDataBaseDir: '', appServerCredentialStorePath: '', appServerAccountProviderId: '',
          appServerModels: ['GLM-5.2'], appServerReasoningLevel: 'max', appServerToolPolicy: 'deny-all',
          appServerInjectAccount: false, appServerRpcTimeoutMs: 5000, appServerTurnTimeoutMs: 30000,
          childEnvAllow: [], contextWindow: 200000, contextBudgets, supportsImages,
        }),
        logger: {},
      });
      const base = mk({});
      const bumped = mk({ 'GLM-5.2': 1000000 });
      const huge = mk({ 'GLM-5.2': 99999999 });
      const zero = mk({ 'GLM-5.2': 0 });
      const a = await base.resolveModel('zcode-appserver', 'GLM-5.2');
      const b = await bumped.resolveModel('zcode-appserver', 'GLM-5.2');
      const c = await huge.resolveModel('zcode-appserver', 'GLM-5.2');
      const d = await zero.resolveModel('zcode-appserver', 'GLM-5.2');
      check(
        'appserver: contextBudgets 覆盖上下文档（1M 生效 / 非法值忽略 / 上界夹到 1M）',
        a.context.contextWindow === 200000 && b.context.contextWindow === 1000000 &&
          c.context.contextWindow === 1000000 && d.context.contextWindow === 200000,
        `base=${a.context.contextWindow} b=${b.context.contextWindow} c=${c.context.contextWindow} d=${d.context.contextWindow}`
      );
      check('appserver: 预算覆盖后仍返回该模型自身元数据', b.id === 'GLM-5.2' && b.defaultMaxTokens > 0);
      /* 能力声明必须跟着真实接线走 —— 声明了 image 却拿不到图正是 §2.7 的坑。 */
      const noImg = mk({}, false);
      const yesImg = mk({ 'GLM-5.2': 1000000 }, true);
      const noImgModels = await noImg.listModels('zcode-appserver');
      const yesImgModels = await yesImg.listModels('zcode-appserver');
      const yesImgResolved = await yesImg.resolveModel('zcode-appserver', 'GLM-5.2');
      check(
        'appserver: 只有真接了 attachments 才声明 image（否则一律 text，防 §2.7）',
        JSON.stringify(noImgModels[0].inputModalities) === JSON.stringify(['text']) &&
          JSON.stringify(yesImgModels[0].inputModalities) === JSON.stringify(['text', 'image']) &&
          JSON.stringify(yesImgResolved.inputModalities) === JSON.stringify(['text', 'image']),
        'no=' + JSON.stringify(noImgModels[0].inputModalities) + ' yes=' + JSON.stringify(yesImgModels[0].inputModalities)
      );
      noImg.dispose();
      yesImg.dispose();
      for (const adapter of [base, bumped, huge, zero]) adapter.dispose();
    }
  }
}

// ─── 8. 零明文终扫（§3.5-4） ─────────────────────────────────────────────────
{
  const zhipuKey = /[0-9a-f]{32}\.[A-Za-z0-9]{16}/;
  const offenders = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|mjs|json|md|yml|yaml)$/.test(name)) {
        const text = readFileSync(p, 'utf8');
        if (zhipuKey.test(text)) offenders.push(p);
      }
    }
  })(PLUGIN_ROOT);
  check('零明文: 产物全目录 zhipu key 正则 0 命中', offenders.length === 0, offenders.join(';'));

  /* 文档断言数漂移守卫（2026-10-06）：README 曾写 113/113、TROUBLESHOOTING 曾写 140 断言，
   * 而实际是 146 —— 三处三个值且无人发现。现在文档改为"不要写死"，本条守卫**禁止**再出现
   * 写死的 `SELFCHECK PASS：N/N` 字样（除非与当前断言数一致）。 */
  {
    const docHardcoded = [];
    for (const rel of ['README.md', 'TROUBLESHOOTING.md']) {
      const text = readFileSync(join(PLUGIN_ROOT, rel), 'utf8');
      for (const m of text.matchAll(/SELFCHECK PASS[：:]\s*(\d+)\/(\d+)/g)) {
        if (m[1] !== m[2] || Number(m[1]) !== results.length) docHardcoded.push(`${rel}: ${m[0]}`);
      }
      // 形如 "N 断言" / "N/M，exit 0" 的写死计数
      for (const m of text.matchAll(/(\d{2,4})\s*断言/g)) docHardcoded.push(`${rel}: ${m[0]}`);
    }
    check('文档: 不写死自检断言数（防与实现漂移）', docHardcoded.length === 0, docHardcoded.join('; '));
  }

  /* 主题安全（2026-10-01 真机实证修复，pitfalls §10.8）：
   * 深色主题下曾出现"白底卡片 + 低对比正文"——根因是 CSS 用了**不存在的 token 名**
   * （text-primary / border / fill-primary / state-error-secondary），使**浅色回退值**
   * （#fafafa / #fff / #e5e7eb 等）在深色下生效。
   * 不变量：① 回退值必须主题无关（transparent / rgba(...) / currentColor / inherit）；
   *         ② 只引用本机 Inspect 实测存在的 token 名。本断言防回归。 */
  const clientSrc = readFileSync(join(PLUGIN_ROOT, 'lib', 'client.js'), 'utf8');
  const cssBlock = clientSrc.slice(clientSrc.indexOf('const ZCODE_PANEL_CSS'), clientSrc.indexOf('].join('));
  const lightOnlyFallback = cssBlock.match(/#(?:ffffff|fff|fafafa|f3f4f6|f7f8fa|e5e7eb|f0f1f3|d0d5dd|6b7280|1f2329|4f46e5|d92d20|fef3f2|22a06b)\b/gi) ?? [];
  const ghostTokens = ['--dsw-alias-text-primary', '--dsw-alias-border,', '--dsw-alias-fill-primary', '--dsw-alias-fill-secondary', '--dsw-alias-state-error-secondary'];
  const ghostHits = ghostTokens.filter((t) => cssBlock.includes(t));
  check(
    '主题: CSS 无浅色硬编码回退、无虚构 token 名（深色主题安全）',
    lightOnlyFallback.length === 0 && ghostHits.length === 0,
    `浅色回退=${lightOnlyFallback.join(',') || '无'} 虚构token=${ghostHits.join(',') || '无'}`
  );
  check(
    '主题: CSS 回退值主题无关（transparent/rgba/currentColor）',
    /var\(--dsw-alias-label-primary,currentColor\)/.test(cssBlock) &&
      /var\(--dsw-alias-bg-layer-1,transparent\)/.test(cssBlock) &&
      /rgba\(128,128,128,/.test(cssBlock)
  );
  check(
    '主题: 仅引用实测存在的 token 名（label/border-l1/bg-layer/brand/state-*）',
    ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-brand-primary', '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary', '--dsw-alias-state-idle-primary'].every((t) => cssBlock.includes(t))
  );
}

// ─── 收尾 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\nSELFCHECK ${failed.length === 0 ? 'PASS' : 'FAIL'}：${results.length - failed.length}/${results.length}`);
try {
  rmSync(tmp, { recursive: true, force: true });
  console.log(`tmp 已删除：${tmp}（残留 ${existsSync(tmp) ? '是' : '否'}）`);
} catch (err) {
  console.error(`tmp 删除失败（需人工清理）：${tmp} → ${err?.message ?? err}`);
  process.exitCode = 1;
}
if (failed.length > 0) process.exitCode = 1;
