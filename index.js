/**
 * @local/dsh-connect-zcode —— Host 半边：把 ZCode Coding Plan 注册为 DSH 的 LLM provider。
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
import { DEFAULT_PLAN_KEY, readPlanCredential, resolvePlanCredential } from './lib/credential.js';
import { DEFAULT_SWITCH_PATH, assertSwitchEnabled, readDispatchSwitch } from './lib/switch.js';
import { DEFAULT_LEDGER_PATH, appendProviderRun } from './lib/ledger.js';
import { resolveHostLlmModules, resolveSchemastery } from './lib/host-modules.js';
import { staticCatalog, discoverModels, filterByEnabledModels } from './lib/discovery.js';
import {
  BASE_CONTEXT_WINDOW,
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
const FALLBACK_MAX_TOKENS = 128000;

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
  const clampInt = (v, lo, hi, dflt) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : dflt;
  const nonEmptyStr = (v, dflt) => (typeof v === 'string' && v !== '' ? v : dflt);
  const v = config ?? {};
  return {
    planKey: nonEmptyStr(v.planKey, DEFAULT_PLAN_KEY),
    contextWindow: clampInt(v.contextWindow, 1, 1000000, 200000),
    maxConcurrent: clampInt(v.maxConcurrent, 1, 2, 2),
    credentialPath: typeof v.credentialPath === 'string' ? v.credentialPath : '',
    switchPath: nonEmptyStr(v.switchPath, DEFAULT_SWITCH_PATH),
    ledgerPath: nonEmptyStr(v.ledgerPath, DEFAULT_LEDGER_PATH),
    // 降级路径也要保真这些字段（活读，剥 volatile 引用），否则 validate 会把面板写入剥掉。
    enabledModelIds: enabledModelIdsOf(v),
    contextBudgets: contextBudgetsOf(v),
    modelOverrides: modelOverridesOf(v),
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
 *  写入门禁静默拒绝（`has no volatile fields`，且 set() 照样 resolve）。 */
async function loadConfig() {
  try {
    const z = await resolveSchemastery();
    if (!z) throw new Error('宿主内未解析到 @deepseek-ai/schemastery');
    return z.object({
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
    });
  } catch {
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
  } catch {
    /* 路由注册失败不影响 provider 三部曲 */
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
      /* 附件解析（图片输入必需）—— trae :438/:4424 同款软取。
       * 缺了它会报「pi-ai image input requires the durable attachment service」：
       * 我们的模型条目声明了 input 含 "image"（GLM-5.3-Flash 官方支持图片/视频），
       * 一旦会话带图片上下文，pi-ai 就需要该服务把图片引用换成可请求的字节；
       * 服务缺席时它直接抛错 ⇒ 整个会话的模型调用失败（纯文本会话不受影响，
       * 所以症状是"新会话能用、带图/附件历史的会话不能用"）。
       * 软取（而非硬 inject）：attachments 缺席时返回 undefined，纯文本场景照常工作，
       * 与 trae 一致、不扩大启动失败面。 */
      resolveAttachments: () => ctx.get('attachments'),
    }),
    getModels: () => models, // trae :421 同款覆写：目录以闭包内静态表为准（勾选变化时整体换数组）
  };

  const profile = {
    provider: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    ...(mods.resolveRetryPolicy ? { retryPolicy: mods.resolveRetryPolicy(undefined, 'dsh-connect-zcode retryPolicy') } : {}),
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
  });

  const offs = [];
  offs.push(ctx.llm.registerAdapter([PROVIDER_ID], adapter));
  offs.push(
    ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
      const cancellation = signal ?? request?.signal;
      // PROTOCOL §7.1：冻结期连目录发现也不发请求（GET /v1/models 同样不走）。
      if (!readDispatchSwitch(cfg.switchPath).enabled) return discoveredFor(state.lastCatalog);
      try {
        // 方案 B：与调用门同一凭据解析（config.json 验活失败则回退凭据库），
        // 否则会出现"推理可用但目录发现用旧 key 401"的不一致。
        const credential = await resolvePlanCredential(credentialPath, cfg.planKey, {
          ...(cancellation === undefined ? {} : { signal: cancellation }),
        });
        const rows = await discoverModels(credential, {
          officialMeta: readMeta(),
          baseContextWindow: cfg.contextWindow,
          ...(cancellation === undefined ? {} : { signal: cancellation }),
        });
        state.lastCatalog = rows; // 状态路由展示过滤前的全量（面板要能看到被隐藏的模型才能重新勾上）
        return discoveredFor(rows);
      } catch {
        return discoveredFor(state.lastCatalog);
      }
    })
  );
  offs.push(
    ctx.llm.registerConfigurableProviders([
      { provider: PROVIDER_ID, displayName: DISPLAY_NAME, settingsNs, settingsPath: [], declared: false },
    ])
  );

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
