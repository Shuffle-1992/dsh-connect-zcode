#!/usr/bin/env node
/**
 * probe-session-read.mjs —— **零额度**探针：确认 CLI 的按次上下文读数还在。
 *
 * 为什么需要它：DSH 的 usage 是"单次请求"口径，而 app-server 通道拿到的
 * `turn.completed.usage` 是**本回合 N 次模型调用之和**（`zcode.cjs` 的 `ZO`/`Jgr`），
 * 必须折算后才能上报（见 `lib/app-server.js` 的 `deriveReportedUsage` 与
 * TROUBLESHOOTING §2.10）。折算的数据源是 `session/read` 返回的
 * `projection.contextUsed`（CLI 在每条 `ModelComplete` 上把它覆写为该次调用的
 * `input+output`）。**ZCode 升版若改协议，这条读数最可能先消失** —— 本探针就是它的哨兵。
 *
 * 只走 `session/create` + `session/read`（+`session/usage` 对照），**不发消息**
 * ⇒ 不消耗任何额度；spawn/env/注入账户全部复用生产模块。
 *
 * 用法：
 *   node scripts/probe-session-read.mjs
 * 判定：末行 `PROBE PASS/FAIL`；exit 0 = `projection.contextUsed` 是有限数值。
 * ⚠️ 新会话的 `contextUsed` 就是 **0**（还没跑过模型调用）—— 那是正常值，不是失败；
 *    判据是"字段存在且为有限数"，本脚本已按此实现。
 */
import { homedir } from 'node:os';
import { createAppServerAdapter, resolveZcodeCliPath, START_PLAN_CATALOG, DEFAULT_REASONING_LEVEL } from '../lib/app-server.js';

const logger = {
  info: (m) => console.log('[info]', m),
  warn: (m) => console.log('[warn]', m),
  error: (m) => console.log('[error]', m),
  debug: () => {},
};

const cliPath = resolveZcodeCliPath('');
if (cliPath === '') {
  console.error('✗ 找不到 ZCode CLI（zcode.cjs）。可用 ZCODE_CLI_PATH 指定绝对路径。');
  process.exit(1);
}
console.log(`ZCode CLI = ${cliPath}`);

const adapter = createAppServerAdapter({
  BaseAdapter: class {},
  LlmError: class LlmError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
    }
  },
  options: () => ({
    zcodeCliPath: cliPath,
    zcodeCliNode: process.execPath,
    zcodeDataBaseDir: '',
    appServerCredentialStorePath: '',
    appServerAccountProviderId: '', // 留空 = 按 oauth:active_provider 自动选
    appServerModels: START_PLAN_CATALOG.map((m) => m.id),
    appServerReasoningLevel: DEFAULT_REASONING_LEVEL,
    appServerToolPolicy: 'deny-all', // 本探针不跑工具
    appServerInjectAccount: true,
    appServerWorkspace: homedir(),
    appServerRpcTimeoutMs: 60000,
    appServerTurnTimeoutMs: 60000,
    childEnvAllow: [],
    contextWindow: 200000,
  }),
  logger,
  gate: () => {},
});

let exitCode = 1;
try {
  const session = await adapter.ensureSession('probe-session-read', START_PLAN_CATALOG[0].id);
  console.log(`✓ session/create → ${session.sessionId}`);

  const read = await adapter.client.request(
    'session/read',
    { sessionId: session.sessionId, messageLimit: 1 },
    15000
  );
  const projection = read?.projection ?? null;
  console.log('session/read 顶层键 :', Object.keys(read ?? {}).join(','));
  console.log('projection 键       :', projection === null ? '(缺)' : Object.keys(projection).join(','));
  console.log('contextUsed         :', projection?.contextUsed, projection?.contextUsed === 0 ? '（新会话，尚未跑过模型调用 → 正常）' : '');
  console.log('contextWindow       :', projection?.contextWindow);
  console.log('totalTokenCount     :', projection?.totalTokenCount);
  console.log('status / turnCount  :', projection?.status, '/', projection?.turnCount);

  /* 对照：会话级累计用量（含 modelRequestCount —— 折算表里"单调用回合"的判据）。 */
  const usage = await adapter.client.request('session/usage', { sessionId: session.sessionId }, 15000);
  console.log('session/usage       :', JSON.stringify(usage));

  const ok = typeof projection?.contextUsed === 'number' && Number.isFinite(projection.contextUsed);
  console.log(
    ok
      ? '\n✅ PROBE PASS：projection.contextUsed 可用（usage 口径折算的数据源成立）'
      : '\n✗ PROBE FAIL：拿不到投影 contextUsed —— 通道会自动退回"按调用次数取均值"，不虚高但更粗'
  );
  exitCode = ok ? 0 : 1;
} catch (error) {
  console.error('✗ 探针抛错：', error?.message ?? error);
} finally {
  adapter.dispose();
}
process.exit(exitCode);
