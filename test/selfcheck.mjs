#!/usr/bin/env node
/**
 * selfcheck.mjs —— dsh-connect-zcode 自检（T20 §3.5）。
 *
 * 纪律：不产生任何网络请求（fetch 全程投毒）；不读真实 ~/.zcode/v2/config.json 内容
 * （凭据用 tmp fixture）；tmp 用后即删；零明文（假 key 现场构造，不落字面量）。
 * 退出码：0=全绿；1=存在 FAIL。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const sw = await import('../lib/switch.js');
const ledger = await import('../lib/ledger.js');
const discovery = await import('../lib/discovery.js');
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
const fixtureConfig = (over = {}) =>
  JSON.stringify({
    provider: {
      'builtin:bigmodel-coding-plan': {
        enabled: true,
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

// ─── 4. 静态目录与发现回退（§3.4） ───────────────────────────────────────────
{
  check('目录: 静态表 11 项且含 glm-5.3', discovery.STATIC_MODEL_IDS.length === 11 && discovery.STATIC_MODEL_IDS.includes('glm-5.3'), discovery.STATIC_MODEL_IDS.join(','));
  const rows = discovery.staticDiscoveredModels(200000);
  check(
    '目录: 每行 contextWindow/maxTokens 为正整数',
    rows.every((r) => Number.isInteger(r.contextWindow) && r.contextWindow > 0 && Number.isInteger(r.maxTokens) && r.maxTokens > 0 && r.id && r.name)
  );
  check('发现: extractModelIds 兼容三种形态', JSON.stringify(discovery.extractModelIds({ data: [{ id: 'a' }, { id: 'b' }] })) === '["a","b"]' && JSON.stringify(discovery.extractModelIds({ models: ['c'] })) === '["c"]' && JSON.stringify(discovery.extractModelIds(['d'])) === '["d"]');
  const rows2 = await discovery.discoverModels({ apiKey: fakeKey, baseURL: 'https://example.test/api/anthropic' }, 200000, { fetchFn: async () => ({ ok: false }) });
  check('发现: HTTP 非 200 回退静态表', rows2.length === 11 && rows2[0].contextWindow === 200000);
  const rows3 = await discovery.discoverModels({ apiKey: fakeKey, baseURL: 'https://example.test/api/anthropic' }, 200000, { fetchFn: async () => { throw new Error('NETWORK FORBIDDEN'); } });
  check('发现: 网络异常回退静态表', rows3.length === 11);
  const rows4 = await discovery.discoverModels({ apiKey: fakeKey, baseURL: 'https://example.test/api/anthropic' }, 200000, {
    fetchFn: async (url, init) => {
      if (!init.headers['x-api-key'] || !init.headers['anthropic-version']) throw new Error('missing headers');
      return { ok: true, json: async () => ({ data: [{ id: 'glm-9.9' }] }) };
    },
  });
  check('发现: 200 时用端点目录', rows4.length === 1 && rows4[0].id === 'glm-9.9' && rows4[0].contextWindow === 200000, JSON.stringify(rows4[0]));
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
  check('manifest: 无 dsh.client（防 DSH 拒启）', pkg.dsh?.client === undefined && Object.keys(pkg.dsh ?? {}).join(',') === 'bundle');
  check('manifest: peerDependencies 声明宿主栈', !!pkg.peerDependencies?.['@earendil-works/pi-ai'] && !!pkg.peerDependencies?.['@deepseek-ai/dsh-llm-pi-ai']);
  const patch = readFileSync(join(PLUGIN_ROOT, 'cordis.patch.yml'), 'utf8');
  check('patch: 含 zcode-connect 与 @local/dsh-connect-zcode', patch.includes('id: zcode-connect') && patch.includes("'@local/dsh-connect-zcode'"));

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
  check('发现: 冻结期零网络直接回静态表', Array.isArray(discoveryRows) && discoveryRows.length === 11 && discoveryRows[0].contextWindow === 200000, `rows=${discoveryRows?.length}`);

  for (const off of effects.splice(0)) off?.();
  check('卸载: 三部曲对称移除', registrations.adapters.length === 0 && registrations.discoveries.length === 0 && registrations.directories.length === 0);

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
