#!/usr/bin/env node
/**
 * verify-appserver-channel.mjs —— app-server 通道的**真机验证**（驱动的是生产模块本身）。
 *
 * 与自检的分工：
 *   - `test/selfcheck.mjs`  纯静态 / 单元：零网络、零真实凭据、不 spawn；
 *   - **本脚本**           真机：真的 spawn `zcode.cjs app-server`、真的注入账户、
 *                          真的发一轮、真的把 StreamingChunk 打出来。
 *
 * 为什么必须用**生产模块**而不是另写一份探针：注入补丁的 basedOn 串、spawn 的 env 四件套、
 * 事件信封（type 在 params 顶层）、鉴权应答形状 —— 这些一旦写两份就会漂移，而漂移的表现是
 * "探针绿、插件红"。故本脚本只做 IO 与打印，协议逻辑一律走 `lib/app-server.js`。
 *
 * 用法：
 *   node scripts/verify-appserver-channel.mjs
 *   node scripts/verify-appserver-channel.mjs --model GLM-5.2 --prompt "只回复：就绪"
 *   node scripts/verify-appserver-channel.mjs --tools deny-all
 *
 * 判定：末行 `VERIFY PASS/FAIL`；exit 0 = 拿到正常结束的回合（`finish:stop`）。
 * ⚠️ 会消耗真实套餐额度（一轮对话）。Start Plan 的「已领取」≠「已生效」：
 *    若权益窗口未开始，上游回 `1005 exceed quota limit` —— 那是**额度时序**，不是通道故障，
 *    判据看 `providerId` / `baseURL` 是否命中 `zcode.z.ai/.../zcode-plan/anthropic`。
 */
import { homedir } from 'node:os';
import { createAppServerAdapter, resolveZcodeCliPath, START_PLAN_CATALOG, DEFAULT_REASONING_LEVEL } from '../lib/app-server.js';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : dflt;
};
const MODEL = flag('model', START_PLAN_CATALOG[0].id);
const PROMPT = flag('prompt', '只回复两个字：就绪');
const TOOLS = flag('tools', 'deny-all'); // 验证脚本默认不放行工具（最小权限）
const TIMEOUT_MS = Number(flag('timeout-ms', '180000'));

/** 最小 logger（生产里是 ctx.logger；这里只要 info/warn/error 三个方法）。 */
const seen = [];
const logger = {
  info: (m) => {
    seen.push(String(m));
    console.log('[info]', m);
  },
  warn: (m) => {
    seen.push(String(m));
    console.log('[warn]', m);
  },
  error: (m) => console.log('[error]', m),
  debug: () => {},
};

const cliPath = resolveZcodeCliPath('');
if (cliPath === '') {
  console.error('✗ 找不到 ZCode CLI（zcode.cjs）。可用 ZCODE_CLI_PATH 指定绝对路径。');
  process.exitCode = 1;
} else {
  console.log(`ZCode CLI = ${cliPath}`);
  console.log(`模型 = ${MODEL}    工具策略 = ${TOOLS}`);

  // 与 index.js 的 normalizeConfig 同形的运行期配置（只列本通道用到的键）。
  const cfg = {
    zcodeCliPath: cliPath,
    zcodeCliNode: process.execPath,
    zcodeDataBaseDir: '',
    appServerCredentialStorePath: '',
    appServerAccountProviderId: '', // 留空 = 按 oauth:active_provider 自动选
    appServerModels: START_PLAN_CATALOG.map((m) => m.id),
    appServerReasoningLevel: DEFAULT_REASONING_LEVEL,
    appServerToolPolicy: TOOLS,
    appServerInjectAccount: true,
    appServerWorkspace: homedir(),
    appServerRpcTimeoutMs: 120000,
    appServerTurnTimeoutMs: TIMEOUT_MS,
    childEnvAllow: [],
    contextWindow: 200000,
  };

  const adapter = createAppServerAdapter({
    // 宿主契约只要求 stream()；真机验证不需要 LlmAdapter 基类的其余默认实现。
    BaseAdapter: class {},
    LlmError: class LlmError extends Error {
      constructor(message, code) {
        super(message);
        this.code = code;
      }
    },
    options: () => cfg,
    logger,
    gate: () => {}, // 真机验证不受派发开关约束（开关语义已由自检覆盖）
  });

  let text = '';
  const kinds = {};
  let finish;
  let usage;
  const t0 = Date.now();
  try {
    for await (const chunk of adapter.stream({
      provider: 'zcode-appserver',
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
      sessionId: `verify-${Date.now()}`,
    })) {
      kinds[chunk.type] = (kinds[chunk.type] ?? 0) + 1;
      if (chunk.type === 'text-delta') {
        text += chunk.text;
        process.stdout.write(chunk.text);
      }
      if (chunk.type === 'usage') usage = chunk.usage;
      if (chunk.type === 'finish') finish = chunk.reason;
    }
  } catch (error) {
    console.error('\n✗ stream 抛错：', error?.message ?? error);
    finish = { kind: 'threw', failure: { message: String(error?.message ?? error) } };
  } finally {
    adapter.dispose();
  }

  console.log('\n\n================ 结果 ================');
  console.log('chunk 统计 :', JSON.stringify(kinds));
  console.log('回复正文   :', JSON.stringify(text.slice(0, 200)));
  console.log('usage      :', JSON.stringify(usage ?? null));
  console.log('finish     :', JSON.stringify(finish ?? null));
  const channelLine = seen.find((m) => m.includes('本轮执行渠道'));
  console.log('执行渠道   :', channelLine ?? '(未观测到 —— 回合未走到模型请求)');
  console.log('耗时       :', `${Date.now() - t0}ms`);

  const onPlanChannel = /zcode-plan/.test(channelLine ?? '');
  const ok = finish?.kind === 'stop';
  if (ok) console.log('\n✅ 通道打通：拿到正常结束的回合（finish:stop）');
  else if (onPlanChannel) {
    console.log('\n⚠ 通道打通但回合未成功（已确证打到 Start Plan 端点）。');
    console.log('   若 failure.code=1005 / message 含 quota → 权益**窗口未生效**（已领取 ≠ 已生效），不是通道故障。');
  } else console.log('\n✗ 未确证打到 Start Plan 端点，请检查上面的 [warn]/[error] 行');
  console.log(`\nVERIFY ${ok ? 'PASS' : 'FAIL'}`);
  process.exitCode = ok ? 0 : 1;
}
