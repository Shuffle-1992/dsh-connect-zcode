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

// ─── 模块导入（被测物） ───────────────────────────────────────────────────────
const credential = await import('../lib/credential.js');
const credStore = await import('../lib/credential-store.js');
const sw = await import('../lib/switch.js');
const ledger = await import('../lib/ledger.js');
const discovery = await import('../lib/discovery.js');
const modelMeta = await import('../lib/model-meta.js');
const webStatus = await import('../lib/web-status.js');
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
      JSON.stringify(discovery.extractModelIds({ models: ['d'] })) === '["d"]'
  );
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
}

// ─── 6. manifest / patch / 纪律（§6 验收） ───────────────────────────────────
{
  const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  check('manifest: 名字正确', pkg.name === '@local/dsh-connect-zcode');
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
  check('patch: 含 zcode-connect 与 @local/dsh-connect-zcode', patch.includes('id: zcode-connect') && patch.includes("'@local/dsh-connect-zcode'"));
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
    'export const createProvider = (input) => ({ id: input.id, name: input.name, auth: input.auth, getModels: () => input.models, stream: (m, c, o) => input.api.stream(m, c, o), streamSimple: (m, c, o) => input.api.streamSimple(m, c, o) });\n'
  );
  tmpFile(
    join('stub-modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'anthropic-messages.lazy.js'),
    'export const anthropicMessagesApi = () => ({ async stream(model) { return (async function* () { yield { type: "usage", input_tokens: 1, output_tokens: 1 }; })(); }, async streamSimple() {} });\n'
  );
  tmpFile(join('stub-modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', type: 'module', version: '0.0.0-stub' }));
  tmpFile(
    join('stub-modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'),
    'export class PiAiAdapter { constructor(options) { this.options = options; } }\n'
  );
  tmpFile(join('stub-modules', '@deepseek-ai', 'dsh-llm', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', type: 'module', version: '0.0.0-stub' }));
  tmpFile(join('stub-modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'), 'export const resolveRetryPolicy = () => ({ stub: true });\n');

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

  const registrations = { adapters: [], discoveries: [], directories: [] };
  const errors = [];
  const effects = [];
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
    index.apply(ctx1, { switchPath, credentialPath: credPath, ledgerPath });
  } catch {
    applyThrew = true;
  }
  check('apply: 同步不抛（激活安全第一）', applyThrew === false);
  const registered = await waitFor(() => registrations.adapters.length === 1 && registrations.discoveries.length === 1 && registrations.directories.length === 1);
  check('注册: 三部曲齐（adapter+discovery+directory）', registered, `errors=${JSON.stringify(errors)}`);
  check('注册: adapter 绑定 provider id zcode', registrations.adapters[0]?.ids?.join(',') === 'zcode');
  check('注册: settingsNs 取 Loader entry id（坑规避）', registrations.discoveries[0]?.ns === 'zcode-connect-selfcheck', registrations.discoveries[0]?.ns);
  const dirEntry = registrations.directories[0]?.[0];
  check('注册: directory 条目形状（declared:false）', dirEntry?.provider === 'zcode' && dirEntry?.displayName === 'ZCode Coding Plan' && dirEntry?.settingsNs === 'zcode-connect-selfcheck' && Array.isArray(dirEntry?.settingsPath) && dirEntry.settingsPath.length === 0 && dirEntry.declared === false);

  const adapter = registrations.adapters[0]?.adapter;
  const opts = adapter?.options;
  check('适配器: profiles 单例 + INERT_AUTH + resolveApiKey', typeof opts?.profiles === 'function' && opts?.profiles() instanceof Map && typeof opts?.resolveApiKey === 'function' && typeof opts?.auth?.credentials?.read === 'function');
  const resolvedKey = await opts.resolveApiKey('zcode', opts.profiles().get('zcode'));
  check('调用门: 开关开+凭据有效 → 返回 key', resolvedKey === fakeKey);
  writeFileSync(switchPath, JSON.stringify({ enabled: false }), 'utf8');
  const frozenRejected = await assertRejects(opts.resolveApiKey('zcode', {}), /派发总开关已关闭：套餐冻结中（含 provider 通道）/);
  check('调用门: 开关关 → resolveApiKey 抛规定文案（§7.1）', frozenRejected === true);
  check('调用门: key 不出现在任何错误消息', !errors.join(' ').includes(fakeKey));

  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('NETWORK FORBIDDEN BY SELFCHECK');
  };
  let discoveryRows = null;
  try {
    discoveryRows = await registrations.discoveries[0].fn({}, undefined);
  } finally {
    globalThis.fetch = realFetch;
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

  for (const off of effects.splice(0)) off?.();
  check('卸载: 三部曲对称移除（两次注册一并卸载）', registrations.adapters.length === 0 && registrations.discoveries.length === 0 && registrations.directories.length === 0);

  writeFileSync(switchPath, JSON.stringify({ enabled: true }), 'utf8');
  const ctx2 = fakeCtx();
  index.apply(ctx2, { switchPath, credentialPath: join(tmp, 'no-such-cred.json'), ledgerPath });
  const failed = await waitFor(() => errors.length >= 1 && registrations.adapters.length === 0);
  const credFailureLogged = errors.some((e) => String(e).includes('provider 注册失败'));
  check('失败面: 凭据缺失 → 只报错不注册不炸', failed === true && credFailureLogged, errors[errors.length - 1]?.slice(0, 80));

  delete process.env.ZCODE_CONNECT_MODULES_ROOT;
  const ctx3 = fakeCtx();
  index.apply(ctx3, { switchPath, credentialPath: credPath, ledgerPath });
  const noModules = await waitFor(() => errors.some((e) => e.includes('宿主 LLM 栈不可用')));
  check('失败面: 宿主栈不可解析 → 可操作错误且不注册', noModules === true, errors.find((e) => e.includes('宿主 LLM 栈不可用'))?.slice(0, 80));
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
    check('client: ModuleLoader 信封执行即交付 factory（id=包名）', !!loaded && typeof loaded.factory === 'function' && loaded.id === '@local/dsh-connect-zcode', `id=${loaded?.id ?? 'null'}`);
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
    check('client: apply 在服务缺失 stub ctx 下不抛且注册 bundle.config 卡（§0.3）', applyThrew === null && slotInjects.length === 1 && slotInjects[0].slotName === 'plugins.bundle.config', applyThrew?.message);
    slotInjects[0]?.registrar?.();
    const card = slotRegisters[0];
    check('client: 卡 key = bundle 包名 + priority 30（slot 契约）', card?.desc?.key === '@local/dsh-connect-zcode' && card?.desc?.priority === 30 && card?.desc?.name === 'plugins.bundle.config', JSON.stringify(card?.desc ?? null));
    check('client: 卡组件为函数（React 函数组件，无构建链）', typeof card?.component === 'function');

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
  } finally {
    if (hadWindow) globalThis.window = realWindow;
    else delete globalThis.window;
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
