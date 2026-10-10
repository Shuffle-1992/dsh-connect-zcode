/**
 * dsh-connect-zcode —— Host 半边：把 ZCode Coding Plan 注册为 DSH 的 LLM provider。
 *
 * 形状完全对齐本机 dsh-connect-trae@2.4.0 的注册三部曲（T18 §3.1 / T19 §5 实证，不发明 API）：
 *   :4016  const inject = ["llm"]
 *   :402-420  createProvider({ id, name, auth:{apiKey:{name, resolve}}, models, api })
 *   :434-439  new PiAiAdapter({ profiles, auth: INERT_AUTH, resolveApiKey })
 *   :4429     ctx.llm.registerAdapter([providerId], adapter)
 *   :4431     ctx.llm.registerModelDiscovery(settingsNs, discover)
 *   :4444     ctx.llm.registerConfigurableProviders([{provider, displayName, settingsNs, settingsPath:[], declared:false}])
 *   :4459     ctx.effect(() => () => registration.*?.())   // 卸载对称
 *
 * 纪律红线（T20 任务包）：
 * - 凭据零落盘、零缓存、每次调用现读 ~/.zcode/v2/config.json（lib/credential.js）；
 * - PROTOCOL §7.1：resolveApiKey 前先查派发总开关，关闭即抛可操作错误（套餐整体冻结）；
 * - PROTOCOL §5.2：每次请求（含失败）向 collab/logs/zcode-runs.jsonl 追加 channel=provider 行；
 * - 并发预算 N=2（config.maxConcurrent 上限 2，不自动升限）；
 * - 静态 import 只用 node: 内建与 ./lib/*（宿主包一律动态解析，Z13-1/ZB-01 坑）；
 * - client 半（T21）：面板勾选 enabledModelIds 控制模型显隐（空 = 全部显示），
 *   字段必须带 volatile 标记（0.1.7 设置写入门禁要求，否则面板写入被静默拒绝——
 *   trae lib/index.js :4077-4094 实证注释）；client 声明与 lib/client.js 同一次交付。
 * - 模型元数据（T22）：网关 /v1/models 零元数据 ⇒ 一律由 lib/model-meta.js 从
 *   ZCode config.json 官方 models 段合并；目录先按 5.3 系显式集合过滤（用户需求）；
 *   contextBudgets/modelOverrides 为面板写入的每模型能力配置（volatile），
 *   官方数据锁定的行（推理档/输入模态）不消费覆盖（applyXxx 跳过 official 行）。
 */
import { homedir } from 'node:os';
import { DEFAULT_PLAN_KEY, readPlanCredential, resolvePlanCredential } from './lib/credential.js';
import { defaultCredentialStorePath } from './lib/credential-store.js';
import { DEFAULT_SWITCH_PATH, assertSwitchEnabled, readDispatchSwitch } from './lib/switch.js';
import { DEFAULT_LEDGER_PATH, appendProviderRun } from './lib/ledger.js';
import { resolveHostLlmModules, resolveSchemastery } from './lib/host-modules.js';
import { readPlanQuota } from './lib/plan-quota.js';
import {
  APPSERVER_PROVIDER_ID,
  APPSERVER_DISPLAY_NAME,
  START_PLAN_CATALOG,
  START_PLAN_REASONING_LEVELS,
  DEFAULT_REASONING_LEVEL,
  createAppServerAdapter,
  resolveZcodeCliPath,
  imageExtension,
} from './lib/app-server.js';
import { staticCatalog, discoverModels, filterByEnabledModels } from './lib/discovery.js';
import {
  BASE_CONTEXT_WINDOW,
  FALLBACK_MAX_TOKENS,
  readOfficialMeta,
  applyImageSelection,
  applyReasoningSelection,
  applyContextBudgets,
} from './lib/model-meta.js';
import { ZCODE_STATUS_PATH, originIsLoopback, hostIsLoopback, readLastLedgerRow, buildStatusDocument, writeJson } from './lib/web-status.js';
import { Semaphore, instrumentApi } from './lib/api-instrument.js';

const NS = 'zcode';
const PROVIDER_ID = 'zcode';
const DISPLAY_NAME = 'ZCode Coding Plan';
const STREAM_IDLE_TIMEOUT_MS = 300000;
/* FALLBACK_MAX_TOKENS 由 lib/model-meta.js 统一导出（S-03：消除三处同值字面量），见上方 import。 */

/** 依赖的宿主服务：llm（注册三部曲的落点；trae :4016 同款）。 */
export const inject = ['llm'];

/**
 * trae :4091-4094 同款：给 schema 字段打 volatile 标记。
 * 0.1.7 的设置写入门禁要求条目里存在 volatile 字段，否则 client 的每次写入都被拒
 * （`Plugin entry "x" has no volatile fields`）且 set() 照样 resolve——面板会"看起来存了"却
 * 静默回弹。探测保留为安全网（老 schemastery 降级为不打标）。
 */
function asVolatile(schema) {
  if (typeof schema?.volatile === 'function') return schema.volatile();
  return schema;
}

/**
 * 剥一层 volatile 活引用（trae unwrapVolatile 同款）：volatile 字段经 settings 写入后
 * 以 `{ get(): T }` 活引用形态到达 host，直接当数组用会处处 undefined。
 */
function unwrapLive(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/**
 * 图片请求预算（**必须放进 profile**；trae `REQUEST_IMAGE_BUDGETS` 同款同值）。
 *
 * 为什么必需：dsh-llm-pi-ai 组装图片请求时读
 *   `profile.requestImagePixelBudget` / `profile.requestImageMaxBytes`
 * 组成 `requestImagePolicy`，再经 `requestImageTarget` 算目标宽高，交给
 * `attachments.readImageRequest`；`dsh-attachment-local` 用 `checkedInteger` 校验
 * width/height/maxBytes 为正整数。
 *
 * ⚠️ 缺字段的后果（2026-10-01 真机）：`requestImagePolicy` 变成
 * `{maxPixels: undefined, maxBytes: undefined}`（**注意 `?? {}` 默认值因此不生效**），
 * 目标宽高算不出来 ⇒ 抛 `Image request width must be a positive integer.`
 * 表现为"图片能力声明了、attachment 服务也接上了，但一发图就失败"。
 *
 * 数值取 DSH 自身默认（pi-ai 内 `requestImagePolicy ?? {maxPixels: 4194304, maxBytes: 1048576}`）
 * 与 trae 的 `maxRequestImageBytes`（20MB base64 上界）保持一致，不自创阈值。
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};

/**
 * 活读面板勾选（T21 §3.1）：enabledModelIds 必须每次现读原始 config（可能是活引用），
 * 不能在 apply 时归一成快照——否则面板保存后 host 永远看不到新值。
 * 空/缺失/形状不对一律 = [] = 全部显示。
 */
function enabledModelIdsOf(rawConfig) {
  const raw = unwrapLive(rawConfig?.enabledModelIds);
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id) => typeof id === 'string' && id.length > 0))];
}

/**
 * 活读上下文预算（T22 §1.2）：模型 id → 正整数（用户勾了官方 Max 档即 1000000）；
 * 缺省/非法条目一律剥掉（语义有效性——是否等于该模型官方 Max 档——由
 * applyContextBudgets 判定，非官方 Max 档的写入不生效）。
 */
function contextBudgetsOf(rawConfig) {
  const raw = unwrapLive(rawConfig?.contextBudgets);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, budget] of Object.entries(raw)) {
    if (typeof id === 'string' && id !== '' && Number.isInteger(budget) && budget > 0) out[id] = budget;
  }
  return out;
}

/**
 * 活读模型覆盖（T22 §1.2）：仅非官方模型消费 {reasoning, image} 布尔开关；
 * 只保留显式 true 的键（缺省 = 关），官方模型即使配置里有也被 applyXxx 忽略。
 */
function modelOverridesOf(rawConfig) {
  const raw = unwrapLive(rawConfig?.modelOverrides);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof id !== 'string' || id === '' || value === null || typeof value !== 'object') continue;
    const entry = {};
    if (value?.reasoning === true) entry.reasoning = true;
    if (value?.image === true) entry.image = true;
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return out;
}

/** config 归一（schemastery 主路径与手写降级共用一份逻辑，Z10-3：区分主/降级但不重复规则）。 */
function normalizeConfig(config) {
  /* R-11：非法值（非有限数 / ≤0）必须回 dflt，只有**合法范围内的越界**才钳制。
   * 原实现 `Math.min(hi, Math.max(lo, trunc(v)))` 把 contextWindow:-5 归成 1 ——
   * 与 schemastery 主路径 `z.number().min(1)`（对 -5 校验失败）行为不一致，
   * 且后果是"全部模型声明 contextWindow=1"，DSH 上下文管理立即异常。 */
  const clampInt = (v, lo, hi, dflt) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
    const n = Math.trunc(v);
    if (n < lo) return dflt;
    return Math.min(hi, n);
  };
  const nonEmptyStr = (v, dflt) => (typeof v === 'string' && v !== '' ? v : dflt);
  const v = config ?? {};
  return {
    planKey: nonEmptyStr(v.planKey, DEFAULT_PLAN_KEY),
    contextWindow: clampInt(v.contextWindow, 1, 1000000, 200000),
    maxConcurrent: clampInt(v.maxConcurrent, 1, 2, 2),
    credentialPath: typeof v.credentialPath === 'string' ? v.credentialPath : '',
    switchPath: nonEmptyStr(v.switchPath, DEFAULT_SWITCH_PATH),
    ledgerPath: nonEmptyStr(v.ledgerPath, DEFAULT_LEDGER_PATH),
    // 回退开关：仅显式 false 时关闭（缺省/非布尔 = 开启，保持既有行为）。
    credentialFallback: v.credentialFallback !== false,
    // 默认推理档：'none' = 不设（零回归）；非法值一律回 'none'。
    defaultReasoningEffort: ['low', 'high', 'max'].includes(v.defaultReasoningEffort) ? v.defaultReasoningEffort : 'none',
    // 降级路径也要保真这些字段（活读，剥 volatile 引用），否则 validate 会把面板写入剥掉。
    enabledModelIds: enabledModelIdsOf(v),
    contextBudgets: contextBudgetsOf(v),
    modelOverrides: modelOverridesOf(v),
    // ── app-server 通道（第二 provider；默认关 = 对既有行为零回归） ──
    appServer: v.appServer === true,
    zcodeCliPath: typeof v.zcodeCliPath === 'string' ? v.zcodeCliPath : '',
    zcodeCliNode: nonEmptyStr(v.zcodeCliNode, 'node'),
    zcodeDataBaseDir: typeof v.zcodeDataBaseDir === 'string' ? v.zcodeDataBaseDir : '',
    appServerCredentialStorePath: nonEmptyStr(v.appServerCredentialStorePath, defaultCredentialStorePath()),
    // 留空 = 按 oauth:active_provider 自动选 account:{bigmodel|zai}-start-plan
    appServerAccountProviderId: typeof v.appServerAccountProviderId === 'string' ? v.appServerAccountProviderId : '',
    // 只保留内置目录里真实存在的 id（未知 id 会被 setModel 拒绝，宁可丢弃也不透传）
    appServerModels: (() => {
      const raw = Array.isArray(v.appServerModels) ? v.appServerModels : [];
      const ids = [...new Set(raw.filter((id) => typeof id === 'string' && START_PLAN_CATALOG.some((m) => m.id === id)))];
      return ids.length > 0 ? ids : [START_PLAN_CATALOG[0].id];
    })(),
    appServerReasoningLevel: START_PLAN_REASONING_LEVELS.includes(v.appServerReasoningLevel)
      ? v.appServerReasoningLevel
      : DEFAULT_REASONING_LEVEL,
    appServerToolPolicy: v.appServerToolPolicy === 'deny-all' ? 'deny-all' : 'allow-all',
    appServerInjectAccount: v.appServerInjectAccount !== false,
    // 留空 = 用户主目录（DSH 进程 cwd 可能是巨大目录树，让 agent 扫它会把回合拖死）
    appServerWorkspace: nonEmptyStr(v.appServerWorkspace, homedir()),
    appServerRpcTimeoutMs: clampInt(v.appServerRpcTimeoutMs, 5000, 600000, 120000),
    appServerTurnTimeoutMs: clampInt(v.appServerTurnTimeoutMs, 30000, 3600000, 900000),
    childEnvAllow: Array.isArray(v.childEnvAllow) ? v.childEnvAllow.filter((k) => typeof k === 'string' && k.trim() !== '') : [],
  };
}

/** 手写 Standard Schema v1 降级（Z10-1：cordis 只认 ~standard.validate；只归一不抛，激活永不被配置打崩）。 */
function fallbackConfigSchema() {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-connect-zcode-fallback',
      async validate(value) {
        return { value: normalizeConfig(value) };
      },
    },
  };
}

/** 插件 config schema：首选宿主随包出货的 schemastery（官方插件同款），缺包降级手写。
 *  ⚠️ schemastery 必须经 host-modules 候选链解析，**不能裸 import**：本包是 link 插件，
 *  裸说明符在 DSH 进程内解析不到（它在 app.asar 内嵌 node_modules，profile 树里没有）。
 *  解析失败会降级手写 schema → enabledModelIds 无法打 volatile → 面板每次保存被 DSH
 *  写入门禁静默拒绝（`has no volatile fields`，且 set() 照样 resolve）。
 *  ⚠️ resolveSchemastery 现按 **抛错** 语义（R-08：失败时带出 tried 候选点列表）；
 *  旧版返回 null 会把诊断线索整个丢弃。此处 catch 文案已拼接 err.message。 */
async function loadConfig() {
  try {
    const z = await resolveSchemastery();
    if (!z) throw new Error('宿主内未解析到 @deepseek-ai/schemastery');    return z.object({
      planKey: z.string().default(DEFAULT_PLAN_KEY).description('只接的套餐条目（api-key 形态；start-plan 的 JWT 形态显式拒绝）'),
      contextWindow: z
        .number()
        .step(1)
        .min(1)
        .max(1000000)
        .default(200000)
        .description('保守上下文窗口：CLI 实测有效 200k，config 名义 1M 不采信（T19 §4）'),
      maxConcurrent: z
        .number()
        .step(1)
        .min(1)
        .max(2)
        .default(2)
        .description('并发预算上界（PROTOCOL §5.2 N=2）；升限须 Lead 批准并同步协议，本插件不自动升限'),
      credentialPath: z.string().default('').description('ZCode config.json 路径；留空 = ~/.zcode/v2/config.json'),
      switchPath: z.string().default(DEFAULT_SWITCH_PATH).description('派发总开关真值文件（PROTOCOL §7.1）；缺文件/损坏视为开启'),
      ledgerPath: z.string().default(DEFAULT_LEDGER_PATH).description('额度台账 zcode-runs.jsonl（PROTOCOL §5.2，channel=provider 追加行）'),
      credentialFallback: z
        .boolean()
        .default(true)
        .description('凭据库回退：config.json 的 Key 验活失败时，自动回退到 ZCode 加密凭据库（credentials.json）；置 false 则只用 config.json（便于排查 / 不愿读加密存储时使用）'),
      defaultReasoningEffort: z
        /* ⚠️ 必须用 z.union([...])：schemastery 3.18.4 **没有 Schema.enum**
         * （2026-10-01 实测 `typeof Schema.enum === 'undefined'`）。写成 z.enum(...) 会抛
         * TypeError → 被 loadConfig 的 catch 吞掉 → 静默降级手写 schema → DSH 判定
         * `!isNativeConfigSchema` → 入口 status=unsupported → **插件整体不激活**
         * （provider 消失、状态路由 404）。见 TROUBLESHOOTING §2.8。 */
        .union(['none', 'low', 'high', 'max'])
        .default('none')
        .description('默认推理档（profile.reasoning）：设为 low/high/max 后，模型切换后选择器初始显示该档、未手动选档时按该档发送。' +
          '⚠️ 只在"本 provider 全部启用模型都支持该档"时才能开：不支持该档的模型（如未开推理开关的 FlashX）会直接请求失败' +
          '（dsh-llm-pi-ai :1848 无条件校验、:1705 throw，且无档位控件可救）。none = 不设（现状，最安全）。手动选档始终优先。'),
      // 面板写入目标字段，必须 volatile（见 asVolatile 注释）；空 = 全部显示。
      enabledModelIds: asVolatile(
        z.array(z.string()).default([]).description('模型显隐勾选（设置面板写入）；空 = 全部显示')
      ),
      // T22：每模型上下文预算，id → 官方 Max 档值（1000000）；缺省 = 200k 基础档。
      // 只有官方 context 高于基础档的模型才出现 1M 选项（applyContextBudgets 只认官方 Max 档）。
      contextBudgets: asVolatile(
        z.dict(z.number().step(1).min(1)).default({}).description('上下文预算（设置面板写入）：模型 id → 官方 Max 档值；缺省 = 200k')
      ),
      // T22：非官方模型的用户开关 {reasoning, image}（默认关，用户自担）；官方模型忽略。
      modelOverrides: asVolatile(
        z
          .dict(z.object({ reasoning: z.boolean().default(false), image: z.boolean().default(false) }))
          .default({})
          .description('无官方数据模型的推理/图片开关（设置面板写入）；官方数据锁定的模型忽略此项')
      ),
      // ── app-server 通道（第二 provider：Start Plan / 账号型额度） ──
      appServer: z
        .boolean()
        .default(false)
        .description(
          '启用 app-server 通道（provider `zcode-appserver`）：托管 ZCode 自带的 agent 进程，' +
            '由**官方 agent 自己发模型请求**，从而能消费 Start Plan / 活动赠送额度。' +
            '关闭（默认）时只注册既有的 Coding Plan 通道，行为零变化。'
        ),
      zcodeCliPath: z
        .string()
        .default('')
        .description('ZCode 自带 zcode.cjs 路径；留空 = 自动探测（含盘符扫描，ZCode 常装在非系统盘）'),
      zcodeCliNode: z.string().default('node').description('运行 zcode.cjs 的 node 可执行文件'),
      zcodeDataBaseDir: z.string().default('').description('ZCode 数据目录（读 runtime/provider 下的 zcode-builtin.json）；留空 = 用户主目录'),
      appServerCredentialStorePath: z
        .string()
        .default('')
        .description('ZCode 加密凭据库路径（读 Start Plan 的 zcodejwttoken）；留空 = ~/.zcode/v2/credentials.json'),
      appServerAccountProviderId: z
        .string()
        .default('')
        .description('注入的 start-plan 账户条目；留空 = 按 oauth:active_provider 自动选 account:bigmodel-start-plan / account:zai-start-plan'),
      /* 面板写入目标字段，必须 volatile（见 asVolatile 注释）——赠送额度通道暴露哪些模型。 */
      appServerModels: asVolatile(
        z
          .array(z.string())
          .default([START_PLAN_CATALOG[0].id])
          .description('赠送额度通道暴露给 DSH 的模型 id（设置面板写入；取自内置目录：GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo；未知 id 会被丢弃）')
      ),
      appServerReasoningLevel: z
        .union(START_PLAN_REASONING_LEVELS)
        .default(DEFAULT_REASONING_LEVEL)
        .description('session/setModel 的推理档（ZCode GUI 默认 max；GLM 系 variants = low/high/max）'),
      appServerToolPolicy: z
        .union(['allow-all', 'deny-all'])
        .default('allow-all')
        .description(
          '⚠️ 安全面：allow-all = 会话切 yolo 且自动放行 agent 的每一次工具请求（= DSH 里挂了一个无人确认的全权限 agent）；' +
            'deny-all = 留 build 模式并一律拒绝工具请求（更安全，但 agent 基本只能纯对话）'
        ),
      appServerInjectAccount: z.boolean().default(true).description('把 Start Plan 账户注入 agent（GUI 同款）；关闭则用 agent 冷启动的默认供应商'),
      appServerWorkspace: z.string().default('').description('app-server 会话工作目录；留空 = 用户主目录（勿指向巨型目录树，agent 启动会扫它）'),
      appServerRpcTimeoutMs: z.number().step(1).min(5000).max(600000).default(120000).description('app-server 单次请求（create/inject/setModel/send）超时'),
      appServerTurnTimeoutMs: z.number().step(1).min(30000).max(3600000).default(900000).description('app-server 单回合（send → turn 完成）超时'),
      childEnvAllow: z.array(z.string()).default([]).description('额外透传给 app-server 子进程的环境变量名（默认只透传系统基础变量与 ZCODE_*）'),
    });
  } catch (err) {
    /* ⚠️ 降级必须可见（2026-10-01 教训）：手写 fallback **不是原生 schemastery schema**，
     * DSH 的 config 投影会判 `!isNativeConfigSchema` → 入口 status=unsupported →
     * **整个插件不激活**（provider 消失、状态路由 404）。
     * 所以这里绝不能静默：把原因打出来，否则"插件凭空消失"极难定位。 */
    console.warn(
      '[dsh-connect-zcode] ⚠️ schemastery 路径不可用，降级为手写 schema —— 在 DSH 宿主内这会导致' +
        '入口 status=unsupported（插件不激活、面板状态路由 404）。原因：' +
        `${err?.message ?? err}`
    );
    return fallbackConfigSchema();
  }
}

export const Config = await loadConfig();

/** trae :339 同款：本插件无 pi-ai 凭据生命周期，凭据永远现读 config.json。 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error('dsh-connect-zcode has no pi-ai credential lifecycle');
    },
  },
};

/**
 * 目录事实行 → pi-ai 模型条目（形状对齐 trae toPiModel :380-396）：
 * - reasoning = reasoningEfforts 在场（官方档位或用户开关开）；
 * - thinkingLevelMap：DSH 档位 → wire 枚举；无映射的档位 null = 不发 effort
 *   （trae :383-393 同款）；官方 variants 经 effortEnumName 映射（max→high，trae else 臂）；
 * - compat.supportsReasoningEffort 与 reasoning 联动（T22 §1.3）；
 * - contextWindow 最终钳制：非正整数一律回基础档（INVALID_MODEL_CONTEXT 红线兜底）。
 */
function toPiModel(row, baseUrl) {
  const efforts = row?.reasoningEfforts;
  const hasReasoning = efforts !== undefined && efforts !== null && typeof efforts === 'object';
  const contextWindow = Number.isInteger(row?.contextWindow) && row.contextWindow > 0 ? row.contextWindow : BASE_CONTEXT_WINDOW;
  return {
    id: row.id,
    name: row.name,
    api: 'anthropic-messages',
    provider: PROVIDER_ID,
    baseUrl,
    input: Array.isArray(row?.input) && row.input.length > 0 ? row.input : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: hasReasoning,
    ...(hasReasoning
      ? {
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: efforts.low ?? null,
            medium: null,
            high: efforts.high ?? null,
            xhigh: efforts.xhigh ?? null,
            max: efforts.max ?? null,
          },
        }
      : {}),
    contextWindow,
    maxTokens: Number.isInteger(row?.maxTokens) && row.maxTokens > 0 ? row.maxTokens : FALLBACK_MAX_TOKENS,
    compat: { supportsReasoningEffort: hasReasoning },
  };
}

/**
 * 用户配置消费管线（T22）：图片/推理开关（仅非官方行）→ 上下文预算（仅官方 Max 档）
 * → 显隐勾选。三个 apply 均为纯函数，official 行在各自函数内跳过（锁定语义）。
 */
function applyUserConfig(catalog, userCfg) {
  return filterByEnabledModels(
    applyContextBudgets(applyReasoningSelection(applyImageSelection(catalog, userCfg.overrides), userCfg.overrides), userCfg.budgets),
    userCfg.enabledIds
  );
}

/** 发现回调 / 状态路由共用的目录行形状（trae :4436-4441 同款：id/name/contextWindow/maxTokens/inputModalities）。 */
function toDiscoveredRow(row) {
  return {
    id: row.id,
    name: row.name,
    contextWindow: Number.isInteger(row?.contextWindow) && row.contextWindow > 0 ? row.contextWindow : BASE_CONTEXT_WINDOW,
    maxTokens: Number.isInteger(row?.maxTokens) && row.maxTokens > 0 ? row.maxTokens : FALLBACK_MAX_TOKENS,
    inputModalities: Array.isArray(row?.input) && row.input.length > 0 ? row.input : ['text'],
  };
}

/**
 * pi 模型条目（provider.models / getModels 闭包用）：静态目录事实行 + 用户配置 → toPiModel。
 * @param {string} baseUrl 端点（激活时读一次）。
 * @param {readonly object[]} baseCatalog 目录事实行（staticCatalog / discoverModels 产物）。
 * @param {{enabledIds: string[], budgets: Record<string, number>, overrides: Record<string, object>}} userCfg
 */
function buildModelEntries(baseUrl, baseCatalog, userCfg) {
  return applyUserConfig(baseCatalog, userCfg).map((row) => toPiModel(row, baseUrl));
}

/**
 * 面板只读状态路由（T21 §3.3 方案 B）：client 半拿不到文件系统，冻结态/台账/注册态/
 * 全量目录经回环路由供给。安全面（T21 §3.3-B 硬要求）：GET-only、Host 与 Origin 都必须
 * 回环（trae :1730-1731 同款双校验）、响应零凭据（endpointHost 只出 host）。
 * webServer 服务缺席时静默跳过——面板降级为"状态不可用"，勾选仍走 config。
 */
function registerStatusRoute(webCtx, deps) {
  try {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: ZCODE_STATUS_PATH,
          handler: async (req, res) => {
            try {
              if (req.method !== 'GET') {
                writeJson(res, 405, { error: 'method not allowed' });
                return;
              }
              if (!hostIsLoopback(req.headers?.host)) {
                writeJson(res, 403, { error: 'host_not_allowed' });
                return;
              }
              if (!originIsLoopback(req.headers?.origin)) {
                writeJson(res, 403, { error: 'origin_not_allowed' });
                return;
              }
              writeJson(res, 200, buildStatusDocument(deps));
            } catch (err) {
              writeJson(res, 500, { error: String(err?.message ?? err).slice(0, 200) });
            }
          },
        }),
      'dsh-connect-zcode: panel status route'
    );
  } catch (err) {
    /* R-07：此处原先空 catch，把两种成因混为一谈 —— webServer 服务缺席（已知降级）
     * 与 webServer.register 契约变化（需要修的兼容问题）在用户侧都是"面板状态不可用 404"，
     * 而后者完全不可诊断。与 TROUBLESHOOTING §2.8 同构的静默失效。 */
    console.warn(`[dsh-connect-zcode] 状态路由注册失败（面板将显示状态不可用）：${err?.message ?? err}`);
  }
}

/**
 * 注册主体（宿主 LLM 栈已解析后调用）。返回卸载函数数组（与三部曲一一对应）。
 * 注册时先过一次开关+凭据门（trae 的 shim.ready 先例：凭据不可用就不注册，
 * 用户 /login 后重启/重载 DSH 生效）。
 */
function registerZcodeProvider(ctx, mods, cfg, settingsNs, rawConfig) {
  const credentialPath = cfg.credentialPath === '' ? undefined : cfg.credentialPath;
  /**
   * 每次实际调用前的凭据闸门（PROTOCOL §7.1 冻结语义 + 方案 B 回退）。
   * 用 resolvePlanCredential：config.json 的 key 若验活失败，自动回退到 ZCode 加密凭据库里的
   * 有效候选（2026-10-01 真机事故：OAuth 重登后 ZCode 只更新凭据库、不回写 config.json）。
   * 验活用 GET /v1/models（零推理成本）；失败一律回退为 config.json 原值，不引入新失败面。
   */
  const gate = async () => {
    assertSwitchEnabled(cfg.switchPath);
    return resolvePlanCredential(credentialPath, cfg.planKey, {
      fallback: cfg.credentialFallback,
      onDiagnostic: (msg) => {
        try {
          console.warn(`[dsh-connect-zcode] ${msg}`);
        } catch {
          /* 日志失败不影响凭据解析 */
        }
      },
    });
  };
  // 注册期只读凭据（拿 baseURL 落模型条目），不查开关——开关关闭时插件照样注册，
  // 冻结语义在 resolveApiKey/发现回调的调用路径上生效（PROTOCOL §7.1 验收路径即如此测试）。
  const boot = readPlanCredential(credentialPath, cfg.planKey);

  // 面板配置活读（volatile 字段经 settings 写入后以活引用到达，必须现读；T21 §3.1 + T22 §1.2）。
  const readEnabled = () => enabledModelIdsOf(rawConfig);
  /** 赠送额度通道暴露的模型（**活读**；面板写入 appServerModels 后下一次会话生效）。 */
  const readGiftModels = () => {
    const raw = unwrapLive(rawConfig?.appServerModels);
    const list = Array.isArray(raw) ? raw : [];
    const ids = [...new Set(list.filter((id) => typeof id === 'string' && START_PLAN_CATALOG.some((m) => m.id === id)))];
    return ids.length > 0 ? ids : [START_PLAN_CATALOG[0].id];
  };
  const readBudgets = () => contextBudgetsOf(rawConfig);
  const readOverrides = () => modelOverridesOf(rawConfig);
  const readUserCfg = () => ({ enabledIds: readEnabled(), budgets: readBudgets(), overrides: readOverrides() });
  // 官方元数据（T22）：每次重建现读 config.json 的 models 段（只读元数据，不碰 options；
  // 读不到 → {}，全部按无官方数据处理，绝不抛）。
  const readMeta = () => readOfficialMeta(cfg.credentialPath === '' ? undefined : cfg.credentialPath, cfg.planKey);
  const baseCatalog = () => staticCatalog(readMeta(), cfg.contextWindow);
  // 目录快照（过滤前全量，供面板重勾）；发现失败/冻结期回静态表。
  const state = { registered: false, lastCatalog: baseCatalog() };
  // 发现回调 / 冻结期回退的输出：目录事实行 + 用户配置 → 发现行形状（trae :4436-4441 同款）。
  const discoveredFor = (catalog) => applyUserConfig(catalog, readUserCfg()).map(toDiscoveredRow);
  /* 赠送额度通道的目录行：与 Coding Plan 行**并列**返回（模型 id 不重叠）。
   * ⚠️ 必须惰性求值（只在 discovery 回调里调用）：canImages / appServerState 都在本函数
   * 后文才声明，apply 同步执行期处于 TDZ；回调是异步的，届时已初始化。
   * 没有这些行，宿主的图片策略看不到 gift 模型的 image 能力（2026-10-10 实测：
   * attachmentCount=0，截图被宿主整层剥掉，适配器根本收不到）。 */
  const giftDiscoveryRows = () => {
    if (cfg.appServer !== true || appServerState.registered !== true) return [];
    const imageInput = canImages() ? ['text', 'image'] : ['text'];
    return readGiftModels().map((id) => {
      const entry = START_PLAN_CATALOG.find((m) => m.id === id) ?? { id, name: id, contextWindow: 200000, maxTokens: 128000 };
      const override = readBudgets()[id];
      return {
        id: entry.id,
        name: entry.name ?? entry.id,
        contextWindow:
          Number.isFinite(override) && override > 0
            ? Math.min(Math.trunc(override), 1000000)
            : Number.isInteger(entry.contextWindow) && entry.contextWindow > 0
              ? entry.contextWindow
              : BASE_CONTEXT_WINDOW,
        maxTokens: Number.isInteger(entry.maxTokens) && entry.maxTokens > 0 ? entry.maxTokens : FALLBACK_MAX_TOKENS,
        inputModalities: imageInput,
      };
    });
  };

  const semaphore = new Semaphore(cfg.maxConcurrent);
  const record = (info) => {
    try {
      appendProviderRun(info, cfg.ledgerPath);
    } catch {
      // 记账失败不炸推理通道（台账可写性问题是运维问题，错误只进不了台账）
    }
  };
  const api = instrumentApi(mods.anthropicMessagesApi(), { semaphore, record });
  let models = buildModelEntries(boot.baseURL, state.lastCatalog, readUserCfg());

  /* 默认推理档守卫（启动期静态检查）：配置了 defaultReasoningEffort 但静态目录里有模型
   * 不支持该档（非推理模型 / 该档 thinkingLevelMap 为空）→ 明确列出受影响模型。
   * 不阻断注册（用户显式配置 = 知情选择），但让"FlashX 突然全挂"可一眼定位。 */
  if (cfg.defaultReasoningEffort !== 'none') {
    const effort = cfg.defaultReasoningEffort;
    const victims = models.filter((m) => {
      if (!m.reasoning) return true; // 非推理模型：getSupportedThinkingLevels 只回 ['off']
      const mapped = m.thinkingLevelMap?.[effort];
      return mapped === null || mapped === undefined;
    });
    if (victims.length > 0) {
      console.warn(
        `[dsh-connect-zcode] ⚠️ defaultReasoningEffort='${effort}' 但以下模型不支持该档，` +
          `这些模型将请求失败（dsh-llm-pi-ai :1848 无条件校验）——请改用 none、在面板为这些模型开启推理开关、或换档位：` +
          victims.map((m) => m.id).join(', ')
      );
    }
  }

  const provider = {
    ...mods.createProvider({
      id: PROVIDER_ID,
      name: DISPLAY_NAME,
      auth: {
        apiKey: {
          name: 'ZCode Coding Plan key',
          async resolve() {
            const credential = await gate();
            return {
              auth: { apiKey: credential.apiKey },
              source: credential.source === 'store' ? '~/.zcode/v2/credentials.json（回退）' : '~/.zcode/v2/config.json',
            };
          },
        },
      },
      models,
      api,
    }),
    getModels: () => models, // trae :421 同款覆写：目录以闭包内静态表为准（勾选变化时整体换数组）
  };

  const profile = {
    provider: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    ...(mods.resolveRetryPolicy ? { retryPolicy: mods.resolveRetryPolicy(undefined, 'dsh-connect-zcode retryPolicy') } : {}),
    /* 默认推理档（dsh-llm-pi-ai :1820/:1852）：
     * - catalog 的 defaultEffort = profile.reasoning（模型支持时）→ 选择器切换模型后显示此档而非 "default"；
     * - 实际请求 effort = 用户手动选择 ?? profile.reasoning → 未手动选档时按此档发送。
     * ⚠️ provider 级静态档在"混合推理/非推理模型"的 provider 上不安全：不支持该档的模型
     *   在 :1848 被无条件校验、:1705 throw，且选择器对无推理元数据的模型不给档位控件（无法自救）。
     *   因此默认 'none'（不设，零回归）；显式配置 = 用户知情接受该代价（description 已警示）。
     * deepseek 系"记住档位"的机制就是它配了 profile.reasoning —— 并非按模型记忆，
     * DSH 选择器只有单一 current，本就不存 per-model 选择（2026-10-01 反编译实证）。 */
    ...(cfg.defaultReasoningEffort === 'none' ? {} : { reasoning: cfg.defaultReasoningEffort }),
    /* 图片请求预算（必需，见 REQUEST_IMAGE_BUDGETS 注释）：缺了它带图请求会抛
     * 「Image request width must be a positive integer.」——trae :428 同款展开。 */
    ...REQUEST_IMAGE_BUDGETS,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    defaultContextWindow: cfg.contextWindow,
    piProvider: provider,
  };
  let profiles = new Map([[PROVIDER_ID, profile]]);

  const adapter = new mods.PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => (await gate()).apiKey, // 适配器每请求 await（T20 实证）：开关+凭据的真正调用门
    /* 附件解析（图片输入必需）——**必须挂在 adapter options 上，不能挂 createProvider**。
     * dsh-llm-pi-ai 读的是 `this.config.resolveAttachments`（:1860），而 `this.config` 就是
     * 构造函数收到的这组 options（:1753-1755）。挂到 createProvider 会静默无效：
     * 带图请求仍抛「pi-ai image input requires the durable attachment service」。
     * trae :433-437 同位置；DSH 自家注册内置 provider 也是这么挂的（:2569-2573）。
     * 软取（非硬 inject）：attachments 缺席时返回 undefined，纯文本照常工作，不扩大启动失败面。
     *
     * `resolveImageAccess` **不必传**（已核实）：图片字节来自 `requestImages.get(...)`
     * （由 attachments 服务管线按 requestImagePolicy 构建，:1195-1204），该回调只用于
     * 生成句柄说明文字与离屏图片回放；且 :1874 用 `?.()` 包装，缺席安全返回 undefined。 */
    resolveAttachments: () => ctx.get('attachments'),
  });

  const offs = [];
  offs.push(ctx.llm.registerAdapter([PROVIDER_ID], adapter));

  /* DE-04：C5（dsh-llm-pi-ai 的 options/profile 形状）启动期形状自检。
   * 为什么必须做：本耦合**已两次真机翻车**，且两次都是"挂错位置/缺字段 = 静默无效"
   * （resolveAttachments 挂 createProvider 静默失效；profile 缺图片预算 → 一发图就抛）。
   * 现有唯一校验是"PiAiAdapter 是函数"——上游重命名读取点完全不设防。
   * 策略：**只告警不阻断**（与项目"降级必须可见"纪律一致）——插件仍注册，
   * 但把"某个字段没被认出来"从"特定场景才炸"提前到启动日志。 */
  {
    const missing = [];
    if (adapter?.options?.resolveAttachments === undefined) missing.push('adapter.options.resolveAttachments');
    if (adapter?.options?.auth !== INERT_AUTH) missing.push('adapter.options.auth');
    if (adapter?.options?.profiles === undefined) missing.push('adapter.options.profiles');
    if (adapter?.options?.resolveApiKey === undefined) missing.push('adapter.options.resolveApiKey');
    for (const key of Object.keys(REQUEST_IMAGE_BUDGETS)) {
      if (!Number.isInteger(profile[key]) || profile[key] <= 0) missing.push(`profile.${key}`);
    }
    if (missing.length > 0) {
      console.warn(
        `[dsh-connect-zcode] ⚠️ C5 形状自检未通过，以下字段未被宿主适配器认领：${missing.join(', ')}。` +
          '这通常意味着 dsh-llm-pi-ai 升级后改了读取点 —— 相关能力（附件/图片/凭据/重试）将静默失效，' +
          '请对照 TROUBLESHOOTING §2.7 与宿主包版本排查。'
      );
    }
    /* 正向证据：自检**确实跑到了**（否则"没有告警"既可能是健康、也可能是这段根本没执行——
     * 那正是本项目最怕的假绿）。selfcheck 断言本行在场 + 无 C5 告警 = 双重确认。 */
    console.log(`[dsh-connect-zcode] C5 形状自检通过（检查 ${4 + Object.keys(REQUEST_IMAGE_BUDGETS).length} 项宿主契约字段）`);
    const v = mods.versions ?? {};
    console.log(
      `[dsh-connect-zcode] 宿主 LLM 栈：pi-ai=${v.piAi ?? '未知'} / dsh-llm-pi-ai=${v.piAiAdapter ?? '未知'}；来源=${mods.source}`
    );
  }
  offs.push(
    ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
      const cancellation = signal ?? request?.signal;
      // PROTOCOL §7.1：冻结期连目录发现也不发请求（GET /v1/models 同样不走）。
      if (!readDispatchSwitch(cfg.switchPath).enabled) return [...discoveredFor(state.lastCatalog), ...giftDiscoveryRows()];
      try {
        // 方案 B：与调用门同一凭据解析（config.json 验活失败则回退凭据库），
        // 否则会出现"推理可用但目录发现用旧 key 401"的不一致。
        const credential = await resolvePlanCredential(credentialPath, cfg.planKey, {
          fallback: cfg.credentialFallback,
          ...(cancellation === undefined ? {} : { signal: cancellation }),
        });
        const rows = await discoverModels(credential, {
          officialMeta: readMeta(),
          baseContextWindow: cfg.contextWindow,
          ...(cancellation === undefined ? {} : { signal: cancellation }),
          /* H-02：上游模型增删必须至少留一条线索。5.3 系显式集合过滤是**有意的防误放行取舍**，
           * 但被滤掉的模型连 state.lastCatalog 都进不去 ⇒ 上游新增变体时面板总数不变、
           * 无新模型、无日志，用户与维护者都无从得知"网关已经有新模型了"。 */
          onDiagnostic: (msg) => {
            try {
              console.warn(`[dsh-connect-zcode] ${msg}`);
            } catch {
              /* 日志失败不影响目录发现 */
            }
          },
        });
        state.lastCatalog = rows; // 状态路由展示过滤前的全量（面板要能看到被隐藏的模型才能重新勾上）
        return [...discoveredFor(rows), ...giftDiscoveryRows()];
      } catch (err) {
        /* R-06：目录发现双层静默是本项目最典型的"失败无诊断线索"。
         * 调用门有完整 onDiagnostic 通道，发现路径此前一条都没有 ——
         * 用户只看到"模型列表没更新/少了模型"，主进程日志零线索，
         * 无法区分"网关挂了"与"响应形态变了"。错误消息来自 fetch/JSON.parse/凭据解析，
         * 不含 key 原文（凭据错误文案本身有零明文红线保障）。 */
        try {
          console.warn(`[dsh-connect-zcode] 目录发现失败，回退上次目录：${err?.message ?? err}`);
        } catch {
          /* 日志失败不影响回退 */
        }
        return [...discoveredFor(state.lastCatalog), ...giftDiscoveryRows()];
      }
    })
  );
  /* ── app-server 通道（第二 provider：Start Plan / 账号型额度）────────────────
   * 与既有 `zcode` provider **并存**。默认关（appServer:false）⇒ 本段整体不执行，行为零变化。
   *
   * 为什么不能也走 pi-ai HTTP 栈：Start Plan 端点要求**逐请求的客户端证明**，外部 HTTP
   * （含真实浏览器）直连实测被上游拦成 `405 / code 3012 unusual activity`；只有官方 agent
   * 二进制自己发出的请求能过。故这里是**自建 LlmAdapter 子类**，由常驻
   * `zcode.cjs app-server` 代发模型请求（协议与坑见 lib/app-server.js 头部注释）。
   *
   * 失败面隔离：本段任何异常只告警，**绝不连带打挂既有 Coding Plan 通道**。 */
  /* 图片能力**活判**：只有 DSH 的 attachments 服务在位、且能给出宿主路径时才敢声明 image
   * （声明了却拿不到图 = TROUBLESHOOTING §2.7 那个"带图会话整体失败"的坑）。 */
  const canImages = () => typeof ctx.get?.('attachments')?.imageHostPath === 'function';
  const directoryEntries = [
    { provider: PROVIDER_ID, displayName: DISPLAY_NAME, settingsNs, settingsPath: [], declared: false },
  ];
  /* app-server 通道的注册结果 —— 面板要靠它回答"为什么模型选项里没有赠送额度那条"。
   * 默认 reason=null；每个失败分支都写明可操作原因。 */
  const appServerState = {
    enabled: cfg.appServer === true,
    registered: false,
    reason: null,
    cliPath: null,
    providerId: APPSERVER_PROVIDER_ID,
  };
  if (cfg.appServer) {
    try {
      const cliPath = resolveZcodeCliPath(cfg.zcodeCliPath);
      if (cliPath === '') {
        appServerState.reason = '没探测到 ZCode CLI（zcode.cjs）—— 用配置项 zcodeCliPath 指定绝对路径';
        console.warn(
          '[dsh-connect-zcode] ⚠️ appServer 已启用但没探测到 ZCode CLI（zcode.cjs）—— app-server 通道未注册。' +
            '请用配置项 zcodeCliPath 指定绝对路径（ZCode 常装在非系统盘，自动探测已含盘符扫描）。'
        );
      } else if (typeof mods.LlmAdapter !== 'function') {
        appServerState.reason = '宿主未解析到 @deepseek-ai/dsh-llm 的 LlmAdapter（registerAdapter 的契约基类）';
        console.warn(
          '[dsh-connect-zcode] ⚠️ appServer 已启用但宿主没解析到 @deepseek-ai/dsh-llm 的 LlmAdapter —— ' +
            'app-server 通道未注册（该基类是 DSH `registerAdapter` 的契约）。'
        );
      } else {
        const appServerAdapter = createAppServerAdapter({
          BaseAdapter: mods.LlmAdapter,
          LlmError: mods.LlmError,
          // 活读配置（与既有通道一致）：每次调用现取，配置改动下一次会话生效。
          options: () => ({
            ...cfg,
            zcodeCliPath: cliPath,
            /* 面板可写字段**活读**（与既有通道同款）：保存后下一次会话生效。 */
            appServerModels: readGiftModels(),
            contextBudgets: readBudgets(),
            supportsImages: canImages(),
            /* DSH 图片块 → app-server 附件（`Rar`：kind/filename/mimeType/localPath）。
             * 取**绝对宿主路径**（`attachments.imageHostPath(ref)`）：ZCode agent 是独立进程，
             * 只认真实 OS 路径；DSH 的"执行世界路径"（readonlyPath）对它无效。 */
            materializeImages: async (blocks) => {
              const service = ctx.get?.('attachments');
              if (typeof service?.imageHostPath !== 'function') return [];
              const out = [];
              for (let index = 0; index < blocks.length; index += 1) {
                const block = blocks[index];
                if (block?.ref === null || block?.ref === undefined) continue;
                let hostPath;
                try {
                  hostPath = service.imageHostPath(block.ref);
                } catch (error) {
                  ctx.logger?.warn?.(`[dsh-connect-zcode] 图片附件定位失败（本轮跳过该图）：${error?.message ?? error}`);
                  continue;
                }
                if (typeof hostPath !== 'string' || hostPath === '') continue;
                const mimeType = block.mimeType ?? 'image/png';
                out.push({
                  kind: 'image',
                  filename: `dsh-image-${index + 1}${imageExtension(mimeType)}`,
                  mimeType,
                  localPath: hostPath,
                });
              }
              return out;
            },
            ...(mods.resolveRetryPolicy
              ? { retryPolicy: mods.resolveRetryPolicy(undefined, 'dsh-connect-zcode appServerRetryPolicy') }
              : {}),
          }),
          logger: ctx.logger ?? console,
          // 同一把冻结开关（PROTOCOL §7.1）：关闭时连 agent 进程都不起。
          gate: () => {
            assertSwitchEnabled(cfg.switchPath);
          },
          record: (info) => {
            try {
              appendProviderRun(info, cfg.ledgerPath);
            } catch {
              /* 记账失败不炸推理通道 */
            }
          },
        });
        appServerState.registered = true;
        appServerState.cliPath = cliPath;
        offs.push(ctx.llm.registerAdapter([APPSERVER_PROVIDER_ID], appServerAdapter));
        if (typeof ctx.effect === 'function') {
          // 与仓库既有风格一致：effect 的回调返回值由 cordis 负责在 fiber 卸载时执行，
          // 不再重复塞进 offs（否则卸载时会 dispose 两次）。
          ctx.effect(() => () => appServerAdapter.dispose(), 'dsh-connect-zcode: app-server client');
        }
        directoryEntries.push({
          provider: APPSERVER_PROVIDER_ID,
          displayName: APPSERVER_DISPLAY_NAME,
          settingsNs,
          settingsPath: [],
          declared: false,
        });
        console.log(
          `[dsh-connect-zcode] app-server 通道已注册：provider=${APPSERVER_PROVIDER_ID} ` +
            `模型=${readGiftModels().join('/')} CLI=${cliPath} 工具策略=${cfg.appServerToolPolicy}`
        );
      }
    } catch (err) {
      appServerState.reason = `注册时抛错：${String(err?.message ?? err).slice(0, 120)}`;
      console.warn(`[dsh-connect-zcode] app-server 通道注册失败（既有 Coding Plan 通道不受影响）：${err?.message ?? err}`);
    }
  }
  offs.push(ctx.llm.registerConfigurableProviders(directoryEntries));

  // 面板保存（volatile 写入）后重导目录：trae :4406-4408 同款联动；事件缺席时保存需重启生效。
  if (typeof ctx.on === 'function') {
    try {
      const offUpdate = ctx.on('loader/volatile-update', () => {
        try {
          // 目录整体重建（官方元数据现读 + 用户预算/开关/勾选活读）。
          state.lastCatalog = baseCatalog();
          models = buildModelEntries(boot.baseURL, state.lastCatalog, readUserCfg());
          try {
            provider.models = models; // 双保险：宿主若读属性而非 getModels 也拿到新目录
          } catch {
            /* 只读对象则依赖 getModels 路径 */
          }
        } catch {
          /* 更新尽力而为：保持上次可用目录 */
        }
      });
      if (typeof offUpdate === 'function') offs.push(offUpdate);
    } catch {
      /* 事件机制缺席不致命 */
    }
  }

  // 状态路由依赖注册完成的真实状态，故放在三部曲之后挂载。
  state.registered = true;
  try {
    ctx.inject(['webServer'], (webCtx) =>
      registerStatusRoute(webCtx, {
        registered: () => state.registered,
        readSwitch: () => readDispatchSwitch(cfg.switchPath),
        endpointHost: () => {
          try {
            return new URL(readPlanCredential(credentialPath, cfg.planKey).baseURL).host;
          } catch {
            return null;
          }
        },
        catalog: () => state.lastCatalog,
        enabledModelIds: readEnabled,
        lastLedger: () => readLastLedgerRow(cfg.ledgerPath),
        /* 赠送额度剩余：**只读 ZCode 自己写的日志**（`~/.zcode/v2/logs/*.log` 里它自己的
         * `billing/balance` 响应）。为什么不自己调上游：该端点属 Plan 通道，外部直连实测会被
         * 风控拦（3012），而客户端本来就在调、结果就在日志里 —— 零新请求、零风控面。 */
        planQuota: () => readPlanQuota({ dataBaseDir: cfg.zcodeDataBaseDir }),
        /* 赠送额度通道（app-server）的注册状态 + 面板可配的模型清单。
         * 面板据此渲染「赠送额度通道」区块；未启用/未注册时给出**可操作原因**。 */
        appServer: () => ({
          ...appServerState,
          toolPolicy: cfg.appServerToolPolicy,
          reasoningLevel: cfg.appServerReasoningLevel,
          imagesSupported: canImages(),
          models: appServerState.enabled
            ? readGiftModels().map((id) => {
                const entry = START_PLAN_CATALOG.find((m) => m.id === id) ?? { id, name: id, contextWindow: 200000 };
                const override = readBudgets()[id];
                return {
                  id: entry.id,
                  name: entry.name ?? entry.id,
                  contextWindow:
                    Number.isFinite(override) && override > 0
                      ? Math.min(Math.trunc(override), 1000000)
                      : entry.contextWindow,
                };
              })
            : [],
        }),
      })
    );
  } catch {
    /* webServer 服务缺席 → 面板显示状态不可用 */
  }
  return offs;
}

function logError(ctx, message) {
  const logger = ctx?.logger ?? console;
  (logger.error ?? logger.log)?.call(logger, `[dsh-connect-zcode] ${message}`);
}

export function apply(ctx, config = {}) {
  // DSH 0.1.7 按 Loader entry id 精确匹配 settings 命名空间；写错名字会静默失配（trae :4017-4045 同款坑）。
  const entryId = ctx?.fiber?.entry?.options?.id;
  const settingsNs = typeof entryId === 'string' && entryId !== '' ? entryId : NS;
  const cfg = normalizeConfig(config);

  let disposed = false;
  const offs = [];
  const disposeAll = () => {
    for (const off of offs.splice(0)) {
      try {
        off?.();
      } catch {
        /* 卸载尽力而为 */
      }
    }
  };
  ctx.effect(() => () => {
    disposed = true;
    disposeAll();
  });

  // settings 命名空间自动建账（trae :4400-4404 同款；服务缺席时静默跳过）。
  try {
    ctx.inject(['settings'], (settingsCtx) => {
      ctx.effect(() => settingsCtx.settings.configure({ auto: true }, ctx.fiber));
    });
  } catch {
    /* settings 服务缺席不影响 provider 注册 */
  }

  resolveHostLlmModules()
    .then((mods) => {
      if (disposed) return;
      try {
        offs.push(...registerZcodeProvider(ctx, mods, cfg, settingsNs, config));
      } catch (err) {
        disposeAll();
        logError(ctx, `provider 注册失败（未注册任何入口）：${err?.message ?? err}`);
      }
    })
    .catch((err) => logError(ctx, `宿主 LLM 栈不可用，provider 未注册：${err?.message ?? err}`));
}
