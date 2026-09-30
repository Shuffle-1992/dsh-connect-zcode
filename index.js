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
 * - v1 不声明 dsh.client（无 client 半、无 UI——规避 ClientPackageCompositionError）。
 */
import { DEFAULT_PLAN_KEY, readPlanCredential } from './lib/credential.js';
import { DEFAULT_SWITCH_PATH, assertSwitchEnabled, readDispatchSwitch } from './lib/switch.js';
import { DEFAULT_LEDGER_PATH, appendProviderRun } from './lib/ledger.js';
import { resolveHostLlmModules } from './lib/host-modules.js';
import { STATIC_MODEL_IDS, staticDiscoveredModels, discoverModels } from './lib/discovery.js';
import { Semaphore, instrumentApi } from './lib/api-instrument.js';

const NS = 'zcode';
const PROVIDER_ID = 'zcode';
const DISPLAY_NAME = 'ZCode Coding Plan';
const STREAM_IDLE_TIMEOUT_MS = 300000;
const FALLBACK_MAX_TOKENS = 128000;

/** 依赖的宿主服务：llm（注册三部曲的落点；trae :4016 同款）。 */
export const inject = ['llm'];

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

/** 插件 config schema：首选宿主随包出货的 schemastery（官方插件同款），缺包降级手写。 */
async function loadConfig() {
  try {
    const { default: z } = await import('@deepseek-ai/schemastery');
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

/** 模型条目（形状对齐 trae toPiModel :380-396：api 字符串 + baseUrl 落在模型上）。 */
function buildModelEntries(baseUrl, contextWindow) {
  return STATIC_MODEL_IDS.map((id) => ({
    id,
    name: id,
    api: 'anthropic-messages',
    provider: PROVIDER_ID,
    baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow,
    maxTokens: FALLBACK_MAX_TOKENS,
    compat: { supportsReasoningEffort: false },
  }));
}

/**
 * 注册主体（宿主 LLM 栈已解析后调用）。返回卸载函数数组（与三部曲一一对应）。
 * 注册时先过一次开关+凭据门（trae 的 shim.ready 先例：凭据不可用就不注册，
 * 用户 /login 后重启/重载 DSH 生效）。
 */
function registerZcodeProvider(ctx, mods, cfg, settingsNs) {
  const credentialPath = cfg.credentialPath === '' ? undefined : cfg.credentialPath;
  const gate = () => {
    assertSwitchEnabled(cfg.switchPath);
    return readPlanCredential(credentialPath, cfg.planKey);
  };
  // 注册期只读凭据（拿 baseURL 落模型条目），不查开关——开关关闭时插件照样注册，
  // 冻结语义在 resolveApiKey/发现回调的调用路径上生效（PROTOCOL §7.1 验收路径即如此测试）。
  const boot = readPlanCredential(credentialPath, cfg.planKey);

  const semaphore = new Semaphore(cfg.maxConcurrent);
  const record = (info) => {
    try {
      appendProviderRun(info, cfg.ledgerPath);
    } catch {
      // 记账失败不炸推理通道（台账可写性问题是运维问题，错误只进不了台账）
    }
  };
  const api = instrumentApi(mods.anthropicMessagesApi(), { semaphore, record });
  const models = buildModelEntries(boot.baseURL, cfg.contextWindow);

  const provider = {
    ...mods.createProvider({
      id: PROVIDER_ID,
      name: DISPLAY_NAME,
      auth: {
        apiKey: {
          name: 'ZCode Coding Plan key',
          async resolve() {
            const credential = gate();
            return { auth: { apiKey: credential.apiKey }, source: '~/.zcode/v2/config.json' };
          },
        },
      },
      models,
      api,
    }),
    getModels: () => models, // trae :421 同款覆写：目录以闭包内静态表为准
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
    resolveApiKey: async () => gate().apiKey, // 适配器每请求 await（T20 实证）：开关+凭据的真正调用门
  });

  const offs = [];
  offs.push(ctx.llm.registerAdapter([PROVIDER_ID], adapter));
  offs.push(
    ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
      const cancellation = signal ?? request?.signal;
      // PROTOCOL §7.1：冻结期连目录发现也不发请求（GET /v1/models 同样不走）。
      if (!readDispatchSwitch(cfg.switchPath).enabled) return staticDiscoveredModels(cfg.contextWindow);
      try {
        return await discoverModels(readPlanCredential(credentialPath, cfg.planKey), cfg.contextWindow, cancellation === undefined ? {} : { signal: cancellation });
      } catch {
        return staticDiscoveredModels(cfg.contextWindow);
      }
    })
  );
  offs.push(
    ctx.llm.registerConfigurableProviders([
      { provider: PROVIDER_ID, displayName: DISPLAY_NAME, settingsNs, settingsPath: [], declared: false },
    ])
  );
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
        offs.push(...registerZcodeProvider(ctx, mods, cfg, settingsNs));
      } catch (err) {
        disposeAll();
        logError(ctx, `provider 注册失败（未注册任何入口）：${err?.message ?? err}`);
      }
    })
    .catch((err) => logError(ctx, `宿主 LLM 栈不可用，provider 未注册：${err?.message ?? err}`));
}
