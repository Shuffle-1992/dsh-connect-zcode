/**
 * app-server.js —— ZCode **app-server 通道**（Start Plan / 赠送额度直连）。
 *
 * 为什么需要它（2026-10-10 本机实测结论）：
 *   Start Plan 的端点 `zcode.z.ai/api/v1/zcode-plan/anthropic` 要求**逐请求**的
 *   客户端证明。外部 HTTP（含真实浏览器）直连实测被上游拦成
 *   `405 / {"code":3012,"msg":"request has been blocked due to unusual activity"}` ——
 *   而**官方 agent 二进制自己发的请求能过**（它用共享凭证里的 token 自己算签名）。
 *   所以"反代"的正确形态不是自建 HTTP 网关，而是**托管一个常驻的官方 agent 进程**，
 *   由它去发模型请求，我们只负责：注入套餐账户、在它索要鉴权时把 token 交回去、
 *   把它的流式事件翻译成 DSH 的 StreamChunk。
 *
 * 与 Coding Plan 通道（本插件既有 `zcode` provider）的关系：
 *   - `zcode`            ：一等 API Key → 标准 anthropic-messages HTTP（pi-ai 栈），DSH 自己发请求；
 *   - `zcode-appserver`  ：Start Plan / 账号型额度 → 常驻 `zcode.cjs app-server`（本文件），
 *                          **官方 agent 自己发请求**。
 *   两者互补：前者可并发、可带图、DSH 工具直通；后者能烧账号型额度，但一轮一个在途回合、
 *   且 agent 用自己的原生工具（**DSH 的工具不会透传进去**，见 README「已知限制」）。
 *
 * 协议（本机 3.14.5 实测 + 对照 kyle123740/dsh-zcode-cli-proxy 的实测配方）：
 *   信封    C→S 请求 `{id, method, params}`；S→C 响应 `{id, result|error}`；
 *           S→C 请求 `{id, method, params}`（**必须应答**，否则 agent 卡住）；
 *           S→C 通知 `{method, params}`。**没有 jsonrpc 字段**（带了会被 -32600 拒）。
 *   流程    session/create → session/subscribe → session/setMode
 *           → provider/updateAccountConfig（注入套餐账户）
 *           → session/setModel → session/send → 收 session/event
 *   事件    `params.type` 在**顶层**（不是 payload.type），数据在 `params.payload`：
 *           model.streaming{kind:'text_delta'|'reasoning_delta', delta, done}
 *           | turn.completed{response, usage, resultType} | turn.failed{error}
 *           | session.updated{providerId, modelId, baseURL}（← 用来确证"烧的哪个渠道"）
 *   服务端请求 start-plan 鉴权走 `interaction/requestProviderRuntimeHeaders` —— 回
 *           `{headersApplied:true, requestAuth:{apiKey:<zcodejwttoken>, headers:{...}}}`。
 *
 * 三个"错了会静默失效"的关键点（本项目最怕的失效形态，全部加了对策）：
 *   1. spawn 必须按 GUI 同款设置 `ZCODE_APP_VERSION` / `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` /
 *      `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` / `ZCODE_BASE_URL`。少了它们 CLI 落到
 *      `0.0.0-dev` 运行时目录，configSource 与注入层的 basedOn 对不上；
 *   2. `provider/updateAccountConfig` 的 `basedOnZCodeBuiltinRevision` 必须**逐字符等于**
 *      `zcode-builtin:<revision>:<sha256(resolve(activeFilePath))>`，否则 registry 合并
 *      守卫静默跳过（**不报错**，providerCount 照回）—— 故注入后要核对
 *      `session.updated.providerId` 才能确证真生效；
 *   3. 鉴权 token 必须是共享凭证里的 **`zcodejwttoken`**；`oauth:*:access_token` 早已过期，
 *      回它上游直接 401。
 *
 * 纪律：本模块**不静态 import 任何宿主包**（本插件是 link 插件，裸说明符解析不到 ——
 * TROUBLESHOOTING §2.4）。`LlmAdapter` / `LlmError` 由调用方（index.js）从宿主候选链取到后
 * 经 `createAppServerAdapter({ BaseAdapter, LlmError, ... })` 注入，本模块只做"填入基类"。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

import { decryptCredentialValue, defaultCredentialStorePath } from './credential-store.js';
/* 官方推理档事实源（ZCode config.json 的 provider[planKey].models 段）。与 Coding Plan
 * 通道同一份数据、只是套餐键不同（builtin:{family}-start-plan）；本模块不新造档位。 */
import { readOfficialMeta } from './model-meta.js';

/** DSH 侧暴露的 provider id（与既有 `zcode` 通道并存，互不影响）。 */
export const APPSERVER_PROVIDER_ID = 'zcode-appserver';
/**
 * provider 在选择器里的显示名。**必须让用户一眼看出它和 Coding Plan 是两笔账** ——
 * ZCode 里 GLM-5.3-Flash 也按套餐分开列（Coding Plan 一份、Start Plan 一份），这里同构。
 */
export const APPSERVER_DISPLAY_NAME = 'ZCode Start Plan（赠送额度）';

/**
 * Start Plan 的内置模型目录（取自 zcode-builtin.json 的
 * `builtinProviderModelRules`：`account:{zai,bigmodel}-start-plan` 声明了这三个）。
 * ⚠️ **不含 GLM-5.3** —— builtin 未给 start-plan 声明它，写了会 setModel 失败。
 * `input` 一律声明 text：本通道 v1 不落盘图片给 agent 读（见 README 已知限制），
 * **声明了却不实现正是 TROUBLESHOOTING §2.7 的坑**，故如实只声明 text。
 * `name` 带「赠送额度」后缀 —— 选择器里与 Coding Plan 的同名模型区分开。
 */
export const START_PLAN_CATALOG = [
  { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash（赠送额度）', contextWindow: 200000, maxTokens: 128000 },
  { id: 'GLM-5.2', name: 'GLM-5.2（赠送额度）', contextWindow: 200000, maxTokens: 128000 },
  { id: 'GLM-5-Turbo', name: 'GLM-5-Turbo（赠送额度）', contextWindow: 200000, maxTokens: 128000 },
];

/** `session/setModel` 的推理档位枚举（ZCode config 里 GLM 系的 variants）。 */
export const START_PLAN_REASONING_LEVELS = ['low', 'high', 'max'];

/**
 * 档位显示名（**只做展示**，取值以官方 variants 为准；未知档位原样显示 id）。
 * L4：DSH 的 `reasoning.efforts[].name` 是给人看的，id 才是发给 CLI 的 `reasoningLevel`。
 */
const REASONING_LEVEL_NAMES = { low: 'Low', high: 'High', max: 'Max' };

/**
 * `account:bigmodel-start-plan` → `builtin:bigmodel-start-plan`（config.json 的套餐键）。
 * 非 account: 前缀 → ''（调用方按"无官方数据"处理）。
 */
export function startPlanConfigKey(providerId) {
  const id = typeof providerId === 'string' ? providerId.trim() : '';
  return id.startsWith('account:') ? `builtin:${id.slice('account:'.length)}` : '';
}

/**
 * 官方推理档事实（每个模型的 variants / defaultVariant），按小写模型 id 索引。
 * 读不到（无 config / 无该套餐段 / 结构不符）→ `{}`：调用方回退到
 * `START_PLAN_REASONING_LEVELS` + `DEFAULT_REASONING_LEVEL`（两者同样取自官方声明，
 * 见各自注释），**绝不发明档位**。
 * @param {string} accountProviderId 形如 `account:bigmodel-start-plan`
 * @param {string} [configPath] 显式 config.json 路径（自检注入夹具；空=缺省真实路径）
 */
export function readStartPlanReasoningMeta(accountProviderId, configPath) {
  const key = startPlanConfigKey(accountProviderId);
  if (key === '') return {};
  const meta = readOfficialMeta(configPath, key);
  const out = {};
  for (const [id, row] of Object.entries(meta)) {
    const variants = Array.isArray(row?.reasoningVariants) ? row.reasoningVariants : [];
    if (variants.length === 0) continue;
    out[id] = {
      variants: [...variants],
      defaultVariant: typeof row?.defaultVariant === 'string' && variants.includes(row.defaultVariant) ? row.defaultVariant : undefined,
    };
  }
  return out;
}

/**
 * DSH 思考档的**强度序**（展示顺序的唯一依据，与官方 variants 的书写顺序无关）。
 * 依据：DeepSeek 内建档位声明即按此序（Off/Low/High/Max，dsh-llm-deepseek REASONING_EFFORTS），
 * Coding Plan 通道的档位展示同为升序 —— 官方 config.json 里 `variants` 写作
 * `["low","max","high"]` 只是书写顺序，照抄会让赠送通道显示 low/max/high（2026-10-10 用户对比截图指出）。
 * 未知档位排在已知档位之后（保持相对稳定，不发明位置）。
 */
const REASONING_INTENSITY_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function sortReasoningLevels(levels) {
  const rank = (value) => {
    const at = REASONING_INTENSITY_ORDER.indexOf(value);
    return at === -1 ? REASONING_INTENSITY_ORDER.length : at;
  };
  return [...levels].sort((a, b) => rank(a) - rank(b));
}

/**
 * 目录行/模型 id → 推理档事实（**单一来源**：适配器 `_catalog()` 与宿主状态文档（面板）
 * 都走它，避免"面板显示的档位"与"真正发出去的档位"两处漂移）。
 *
 * 档位取值优先级：官方 variants > 模块常量（`START_PLAN_REASONING_LEVELS`，同样源自官方声明）；
 * 默认档：**配置值**（面板可改，在档位集合内时优先）> 官方 `defaultVariant` > 模块默认。
 * **顺序一律按强度序归一**（官方 variants 的书写顺序不代表强度，见 sortReasoningLevels）。
 * @param {Record<string, {variants: string[], defaultVariant?: string}>} meta readStartPlanReasoningMeta 的产物
 * @param {string} modelId
 * @param {string} [configuredDefault] 配置项 `appServerReasoningLevel`
 */
export function reasoningFacts(meta, modelId, configuredDefault) {
  const facts = (meta !== null && typeof meta === 'object' ? meta : {})[String(modelId ?? '').toLowerCase()];
  const levels =
    Array.isArray(facts?.variants) && facts.variants.length > 0
      ? sortReasoningLevels(facts.variants)
      : [...START_PLAN_REASONING_LEVELS];
  const official =
    typeof facts?.defaultVariant === 'string' && levels.includes(facts.defaultVariant) ? facts.defaultVariant : undefined;
  const preferred =
    typeof configuredDefault === 'string' && levels.includes(configuredDefault) ? configuredDefault : undefined;
  return { levels, defaultLevel: preferred ?? official ?? DEFAULT_REASONING_LEVEL };
}

/**
 * 目录行 → DSH `resolveModel` 的 `reasoning` 元数据（契约见 dsh-llm types：
 * `{ efforts: [{id,name,description?}], defaultEffort }`，efforts 非空且 id 唯一，
 * defaultEffort 必须命中其中之一，否则宿主抛 INVALID_MODEL_REASONING）。
 * 无档位 → undefined（模型不显示档位选择器，适配器退回配置默认档）。
 */
export function buildReasoningMeta(levels, defaultLevel) {
  const ids = Array.isArray(levels) ? levels.filter((v) => typeof v === 'string' && v !== '') : [];
  if (ids.length === 0) return undefined;
  const efforts = ids.map((id) => ({ id, name: REASONING_LEVEL_NAMES[id] ?? id }));
  const fallback = ids.includes(DEFAULT_REASONING_LEVEL) ? DEFAULT_REASONING_LEVEL : ids[0];
  return { efforts, defaultEffort: typeof defaultLevel === 'string' && ids.includes(defaultLevel) ? defaultLevel : fallback };
}

/** 默认推理档：GUI 用 max（本机实测 setModel 接受）。 */
export const DEFAULT_REASONING_LEVEL = 'max';

/** 目录缺 maxTokens 时的兜底（与 ZCode config 官方声明一致，非自创阈值）。 */
export const FALLBACK_MAX_TOKENS = 128000;

/** 上下文档上界（官方 Max 声明值；与 Coding Plan 通道的 CONTEXT_1M 同值）。 */
const MAX_CONTEXT_WINDOW = 1000000;

/**
 * 一个会话同时只允许一个在途回合。上一轮被中止 / 超时 / 静默丢弃时它**不会自己释放**，
 * 直接重发就被拒 —— 判据文案（实测多种措辞）。
 */
const STUCK_TURN_RE = /already running|already in flight|still running|in progress|is busy/i;
/** 会话在 app-server 侧已不存在（进程重启 / 被回收）：只能重建并重放整段对话。 */
const STALE_SESSION_RE = /not found|unknown session|no such session|does not exist|invalid session/i;
/** 补发 session/stop 之后，给 agent 释放回合锁的时间。 */
const STOP_SETTLE_MS = 1500;
/**
 * 「上一轮回合未释放」的恢复阶梯等待时长（第 N 次撞锁用第 N 个值）。
 * 用完这些仍撞锁 ⇒ 硬重启子进程（见 stream() 的送信恢复循环）——2026-10-11 实测：
 * 900s 超时后 DSH 重试时锁还没释放，旧实现只等 1.5s 就放弃，直接把用户这一轮判死。
 */
const STUCK_RECOVERY_WAITS_MS = [STOP_SETTLE_MS, 6_000];
/** 同一 DSH 会话排队等上一轮的上限；超时放行交给撞锁恢复，避免死等。 */
const TURN_QUEUE_MAX_MS = 60_000;
/** `updateAccountConfig` 是异步注册，等 registry 刷新完成再 setModel。 */
const ACCOUNT_INJECT_SETTLE_MS = 2000;
/** create→subscribe、subscribe→send 之间各垫一点：零延迟时回合会被静默丢弃（实测）。 */
const STEP_SETTLE_MS = 1500;
/** NDJSON 单行缓冲上限（无换行的坏流防 OOM）。 */
const LINE_BUFFER_CAP = 4 * 1024 * 1024;
/** `session/read` 只用来取一次上下文读数：读不到就折算成均值，绝不拖住回合（见 deriveReportedUsage）。 */
const SESSION_READ_TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 promise 落定，最多 ms；超时不算失败（只用于排队闸门，避免死锁）。 */
function settleWithin(promise, ms) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        done();
      },
      () => {
        clearTimeout(timer);
        done();
      }
    );
  });
}

/**
 * 子进程环境变量白名单。DSH 进程 env 里可能带着其他供应商的密钥，
 * **不整包透传**给 agent；只放行系统基础变量、`ZCODE_*` 与 `NODE_EXTRA_CA_CERTS`。
 * 个别环境需要补充时用配置项 `childEnvAllow` 追加（大小写不敏感，保留原始大小写透传）。
 */
const CHILD_ENV_BASE = new Set([
  'path', 'pathext', 'systemroot', 'systemdrive', 'windir', 'comspec',
  'homedrive', 'homepath', 'userprofile', 'appdata', 'localappdata',
  'programfiles', 'programfiles(x86)', 'commonprogramfiles',
  'commonprogramfiles(x86)', 'programdata', 'allusersprofile',
  'temp', 'tmp', 'os', 'username', 'userdomain', 'computername',
  'processor_architecture', 'number_of_processors',
  'lang', 'lc_all', 'lc_ctype', 'term', 'psmodulepath',
  'node_extra_ca_certs',
]);

/**
 * @param {Record<string,string|undefined>} sourceEnv 通常是 process.env
 * @param {Record<string,string>} overrides 必设的 ZCODE_* 项
 * @param {readonly string[]} [extraAllow] 额外透传的变量名
 * @returns {Record<string,string>}
 */
export function buildChildEnv(sourceEnv, overrides, extraAllow) {
  const allow = new Set(CHILD_ENV_BASE);
  for (const key of extraAllow ?? []) {
    if (typeof key === 'string' && key.trim() !== '') allow.add(key.trim().toLowerCase());
  }
  const env = {};
  for (const [key, value] of Object.entries(sourceEnv ?? {})) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (allow.has(lower) || lower.startsWith('zcode_')) env[key] = value;
  }
  Object.assign(env, overrides);
  // Electron 宿主里这个变量会让子进程按 node 模式跑，但对 zcode.cjs 是干扰项。
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * 定位 ZCode 自带 CLI（`zcode.cjs`）。
 *
 * ⚠️ **不能只查 `%ProgramFiles%`**：本机 ZCode 装在 **F 盘**，而 `%ProgramFiles%` 是
 * `C:\Program Files` —— 只查它（以及 `%LOCALAPPDATA%`）会"探测不到"，
 * 表现是 provider 静默不注册。故追加盘符扫描。
 *
 * @param {string} [configured] 显式配置路径（优先）
 * @param {Record<string,string|undefined>} [sourceEnv]
 * @returns {string} 命中路径；都没命中返回 ''（调用方给可操作提示）
 */
export function resolveZcodeCliPath(configured, sourceEnv = process.env) {
  const rel = ['ZCode', 'resources', 'glm', 'zcode.cjs'];
  const candidates = [
    configured,
    sourceEnv?.ZCODE_CLI_PATH,
    sourceEnv?.ProgramFiles ? join(sourceEnv.ProgramFiles, ...rel) : undefined,
    sourceEnv?.['ProgramFiles(x86)'] ? join(sourceEnv['ProgramFiles(x86)'], ...rel) : undefined,
    sourceEnv?.LOCALAPPDATA ? join(sourceEnv.LOCALAPPDATA, 'Programs', ...rel) : undefined,
    ...['C', 'D', 'E', 'F', 'G', 'H'].flatMap((d) => [
      `${d}:\\Program Files\\${rel.join('\\')}`,
      `${d}:\\Program Files (x86)\\${rel.join('\\')}`,
      `${d}:\\ZCode\\${rel.join('\\')}`,
    ]),
    '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    '/opt/ZCode/resources/glm/zcode.cjs',
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 不可读的候选跳过 */
    }
  }
  return '';
}

/** app-server 运行时目录的平台段（与 zcode.cjs 的 `process.platform-process.arch` 同式）。 */
export function runtimePlatformDir(plat = platform(), arch = process.arch) {
  return plat === 'win32' ? `windows-${arch === 'arm64' ? 'aarch64' : 'x86_64'}` : `${plat}-${arch}`;
}

/**
 * 定位 `zcode-builtin.json`（GUI 同款运行时目录）：
 *   `<dataBase>/.zcode/v2/runtime/provider/<platform>/<version>/<endpoint-*>/zcode-builtin.json`
 * 优先**非 `0.0.0-dev`**（那是 CLI 裸跑的 fallback，GUI 的版本目录更权威），其中取最新。
 * 这个文件决定注入时的 `basedOnZCodeBuiltinRevision`，**必须与 spawn 时给 CLI 的是同一个**。
 * @param {string} [dataBaseDir] 留空 = 用户主目录
 * @param {{ platformDir?: string, fsImpl?: object }} [io] 测试注入
 * @returns {{version: string, activeFilePath: string, mtimeMs: number}|undefined}
 */
export function resolveBuiltinRuntime(dataBaseDir, io = {}) {
  const fsImpl = io.fsImpl ?? { readdirSync, statSync };
  const base = typeof dataBaseDir === 'string' && dataBaseDir.trim() !== '' ? dataBaseDir.trim() : homedir();
  const root = join(base, '.zcode', 'v2', 'runtime', 'provider', io.platformDir ?? runtimePlatformDir());
  let best;
  let bestDev;
  let versions;
  try {
    versions = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const versionDir of versions) {
    if (!versionDir.isDirectory?.()) continue;
    let endpoints;
    try {
      endpoints = fsImpl.readdirSync(join(root, versionDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const endpointDir of endpoints) {
      if (!endpointDir.isDirectory?.() || !String(endpointDir.name).startsWith('endpoint-')) continue;
      const full = join(root, versionDir.name, endpointDir.name, 'zcode-builtin.json');
      let stat;
      try {
        stat = fsImpl.statSync(full);
      } catch {
        continue;
      }
      const candidate = { version: versionDir.name, activeFilePath: full, mtimeMs: stat.mtimeMs };
      if (versionDir.name === '0.0.0-dev') bestDev = candidate;
      else if (best === undefined || stat.mtimeMs > best.mtimeMs) best = candidate;
    }
  }
  return best ?? bestDev;
}

/**
 * 计算 `provider/updateAccountConfig` 要求的 `basedOnZCodeBuiltinRevision`。
 * registry 守卫做**严格相等**比较：`zcode-builtin:<release.revision>:<sha256(resolve(path))>`，
 * 差一个字符注入就被静默丢弃（不报错）—— 这是本通道最隐蔽的失效点。
 * @param {string} activeFilePath
 * @param {(file: string) => string} [readFileImpl]
 */
export function computeBuiltinRevision(activeFilePath, readFileImpl = (f) => readFileSync(f, 'utf8')) {
  const release = JSON.parse(readFileImpl(activeFilePath));
  const hash = createHash('sha256').update(resolve(activeFilePath)).digest('hex');
  return `zcode-builtin:${release.revision}:${hash}`;
}

/**
 * Start Plan 账户注入的 provider id。builtin 里 **zai 与 bigmodel 两个都在**，
 * 取哪个由账号当前登录家族（`oauth:active_provider`）决定：
 *   - `bigmodel` → `account:bigmodel-start-plan`
 *   - `zai`      → `account:zai-start-plan`
 * @param {string} [family] 'zai' | 'bigmodel'；非法/缺失回 'zai'
 */
export function startPlanProviderId(family) {
  return `account:${family === 'bigmodel' ? 'bigmodel' : 'zai'}-start-plan`;
}

/**
 * 把配置里的模型 id 列表解析成内置目录条目（未知 id 丢弃；空/全无效 → 回默认单条）。
 * 不静态信任配置：**只暴露内置目录里真实存在的模型**，避免写出会让 setModel 失败的 id。
 * @param {readonly string[]} [modelIds]
 */
export function resolveAppServerCatalog(modelIds) {
  const ids = Array.isArray(modelIds) ? modelIds.filter((id) => typeof id === 'string' && id !== '') : [];
  const out = [];
  for (const id of ids) {
    const hit = START_PLAN_CATALOG.find((model) => model.id === id);
    if (hit !== undefined && !out.includes(hit)) out.push(hit);
  }
  return out.length > 0 ? out : [START_PLAN_CATALOG[0]];
}

/**
 * 决定注入哪个 start-plan 账户：配置显式指定优先；否则**每次现读** `oauth:active_provider`
 * 自动选（bigmodel / zai）。跟随登录态变化，不缓存。
 * 读不到凭证时回 `account:zai-start-plan`（builtin 里两个都在，注入失败不致命，
 * 真正的失败会由 `session.updated.providerId` 观测到）。
 * @param {{appServerAccountProviderId?: string, appServerCredentialStorePath?: string}} cfg
 */
export function resolveAccountProviderId(cfg) {
  const configured = typeof cfg?.appServerAccountProviderId === 'string' ? cfg.appServerAccountProviderId.trim() : '';
  if (configured !== '') return configured;
  try {
    const storePath = typeof cfg?.appServerCredentialStorePath === 'string' && cfg.appServerCredentialStorePath !== ''
      ? cfg.appServerCredentialStorePath
      : undefined;
    return startPlanProviderId(readStartPlanAuth(storePath).activeProvider);
  } catch {
    return startPlanProviderId(undefined);
  }
}

/** 注入补丁（schema 严格：access 只接受 {type:'zhipu-account', entitled}）。 */
export function buildAccountConfigPatch(basedOnRevision, providerId, modelIds, nowMs = Date.now()) {
  return {
    revision: `dsh-connect-zcode:${nowMs}`,
    basedOnZCodeBuiltinRevision: basedOnRevision,
    providers: {
      [providerId]: {
        access: { type: 'zhipu-account', entitled: true },
        builtinModelIds: [...modelIds],
      },
    },
    states: {
      [providerId]: { availability: 'available', entitled: true, current: true },
    },
  };
}

/**
 * 读共享凭证里的 Start Plan 鉴权（**只解密、不落盘、不打日志**）。
 * 只有 `zcodejwttoken` 可用；`oauth:*:access_token` 是过期的 OAuth 会话 token（回它上游 401）。
 * @param {string} [storePath]
 * @returns {{ token: string, activeProvider?: string }}
 * @throws {Error} 可操作文案（不含任何明文）
 */
export function readStartPlanAuth(storePath = defaultCredentialStorePath()) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(storePath, 'utf8'));
  } catch (err) {
    throw new Error(
      `读不到 ZCode 共享凭证库 ${storePath}（${err?.code ?? err?.message}）。请确认 ZCode 客户端已登录。`
    );
  }
  const token = decryptCredentialValue(raw?.zcodejwttoken);
  if (typeof token !== 'string' || token === '') {
    throw new Error(
      '共享凭证库里没有可用的 zcodejwttoken（Start Plan 鉴权 token）。' +
        '请确认 ZCode 客户端已登录 Z.ai / 智谱账号，并已领取 Start Plan 额度。'
    );
  }
  /* ⚠️ `oauth:active_provider` 也必须是**解密后**的值（2026-10-10 真机踩到）：
   * 凭据库里除它以外的值都是 `enc:v1:` 密文；直接读 raw 会拿到密文串，
   * 于是家族判定 `activeProvider === 'bigmodel'` 永远不成立 → 静默回落到 zai 条目。
   * 症状很隐蔽：注入照样 `status:received`、请求照样打到 zcode-plan（**不报错**），
   * 只是注入了另一个家族的账户。`decryptCredentialValue` 对非密文原样返回，故可统一走它。 */
  const activePlain = typeof raw?.['oauth:active_provider'] === 'string'
    ? decryptCredentialValue(raw['oauth:active_provider'])
    : null;
  const activeProvider = typeof activePlain === 'string' && activePlain !== '' ? activePlain : undefined;
  return activeProvider === undefined ? { token } : { token, activeProvider };
}

// ─── 对话拍平（与既有 zcode 通道同风格的最小子集） ──────────────────────────────

/**
 * 历史里泄漏的伪工具调用标记（模型把 `<antml:invoke …>` 当正文写进了历史）。
 * 重放时不洗掉，模型会照着继续模仿 —— 压成占位，历史即"解毒"。
 */
const LEAKED_CALL_RE =
  /<antml:invoke\b[^>]*>[\s\S]*?<\/antml:invoke>|<antml:parameter\b[^>]*>[\s\S]*?<\/antml:parameter>|<\/?(?:antml:)?(?:invoke|parameter|function_calls)\b[^>]*>/g;
const LEAKED_CALL_HINT = '（历史中曾把工具调用写成正文，已省略；工具要用原生机制调用）';
const LEAKED_CALL_DUP_RE = new RegExp(`(?:\\s*${LEAKED_CALL_HINT})+`, 'g');
/** 流式正文里刚出现伪标记就整段掐断（防标签渣进 DSH 聊天窗）。 */
const LEAK_TAG_RE = /<(?:antml:|\/?invoke\b|function_calls\b)/;
/**
 * 掐断后补的说明块（原文写在 stream() 里，2026-10-10 提到模块级：
 * 它现在要和"最终答案追加"一起排进块序列，放在调用点会遮住块编排逻辑）。
 */
const LEAK_SUPPRESS_NOTE =
  '〔拦截说明：模型试图把工具调用写成正文（伪 antml 标记），这段输出已被桥接层拦下。本通道的工具由 agent 原生执行、不会以文本形式出现；若反复出现，请新开会话。〕';

export function sanitizeLeakedCalls(text) {
  if (typeof text !== 'string') return text;
  return text.replace(LEAKED_CALL_RE, LEAKED_CALL_HINT).replace(LEAKED_CALL_DUP_RE, LEAKED_CALL_HINT);
}

function flattenContent(content, imageText) {
  if (typeof content === 'string') return sanitizeLeakedCalls(content);
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return '';
      if (block.type === 'text') return sanitizeLeakedCalls(block.text ?? '');
      if (block.type === 'image') return imageText?.get(block) ?? '[图片]';
      if (block.type === 'tool-call') return `[调用工具 ${block.name}]`;
      // reasoning 不回放（既省 token，也避免把上一轮思维链当示例）
      return '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * 把 DSH 的对话拍平成一段可读文本（新会话首轮；续接轮只发最后一条用户消息）。
 * @param {readonly object[]} messages
 * @param {string} [system]
 * @param {Map<object,string>} [imageText] 图片块 → 占位文本
 */
export function flattenConversation(messages, system, imageText) {
  const parts = [];
  if (typeof system === 'string' && system.trim() !== '') parts.push(`# 系统提示\n${system.trim()}`);
  for (const message of messages ?? []) {
    const content = message?.content ?? [];
    const role = message?.role;
    if (role === 'system') {
      const text = flattenContent(content, imageText);
      if (text !== '') parts.push(`# 系统提示\n${text}`);
      continue;
    }
    if (role === 'assistant') {
      const text = flattenContent(content, imageText);
      const calls = (Array.isArray(content) ? content : [])
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call')
        .map((block) => `[调用工具 ${block.name}(${block.arguments ?? ''})]`);
      const body = [text, ...calls].filter((value) => value !== '').join('\n');
      if (body !== '') parts.push(`# 助手\n${body}`);
      continue;
    }
    if (Array.isArray(content)) {
      for (const result of content.filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-result')) {
        parts.push(`# 工具结果\n${flattenContent(result.content, imageText)}`);
      }
    }
    const text = flattenContent(content, imageText);
    if (text !== '') parts.push(role === 'tool' ? `# 工具结果\n${text}` : `# 用户\n${text}`);
  }
  return parts.join('\n\n');
}

/** 取最后一条用户消息（续接会话只发这一条）。 */
export function lastUserText(messages, imageText) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      const text = flattenContent(message.content, imageText);
      if (text !== '') return text;
    }
  }
  return '';
}

/**
 * 收集**本轮要转发**的图片块 —— app-server 的 `attachments` 承载的就是这一轮的图。
 *
 * DSH 的图片块形状（2026-10-11 真机会话日志实证）：
 * `{ type:'image', attachment:{ attachmentId:'sha256:<64hex>', mediaType, width, height, bytes, name } }`
 * —— mime 叫 `mediaType` 且在 attachment 里，块本身可能没有 `mimeType`。
 *
 * ⚠️ 扫描范围是「最后一条 assistant 之后的所有 user 消息」，**不是**"最后一条 user 消息"：
 * context-pilot 等注入会在真正的用户消息**之后**追加 user 角色的系统消息（实测
 * 'Context usage before this turn …'），只看最后一条会永远扫到注入消息 ⇒ 图片被静默丢弃
 * （CLI 日志 attachmentCount:0 的真根因，2026-10-11）。历史图片（最后一条 assistant 之前）
 * 仍不转发：由 agent 自己的会话历史承载。
 * @param {readonly object[]} messages
 * @returns {{ref: object|null, mimeType: string|null}[]}
 */
export function collectImageBlocks(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let start = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === 'assistant') {
      start = index + 1;
      break;
    }
  }
  const out = [];
  for (let index = start; index < list.length; index += 1) {
    const message = list[index];
    if (message?.role !== 'user') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block === null || typeof block !== 'object' || block.type !== 'image') continue;
      const ref = block.attachment ?? block.ref ?? null;
      const mediaType =
        typeof block.mimeType === 'string' && block.mimeType !== ''
          ? block.mimeType
          : typeof ref?.mediaType === 'string' && ref.mediaType !== ''
            ? ref.mediaType
            : null;
      out.push({ ref: ref !== null && typeof ref === 'object' ? ref : null, mimeType: mediaType });
    }
  }
  return out;
}

/** 媒体类型 → 扩展名（与 dsh-llm 的 `extension()` 同一套；未知回 `.bin`）。 */
export function imageExtension(mediaType) {
  switch (mediaType) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    default: return '.bin';
  }
}

/**
 * 转发图片时补的一句正文：告诉 agent「这些图是随本条消息附上的」。
 * 不给这句，agent 可能只看到路径而不知道那是本轮的新图。
 */
export const IMAGE_ATTACH_NOTE = '\n\n【本轮随消息附带了图片附件；图像内容已随消息直达，无需再读取文件。】';

/**
 * 对话指纹：续接会话前比对前缀，检测 DSH 侧是否编辑/回退过历史。
 * 变了就重建会话并按首轮语义重放，避免"模型看着旧历史答新问题"。
 */
export function conversationFingerprint(messages, system) {
  const payload = JSON.stringify({ system: system ?? '', messages: messages ?? [] });
  return `${(messages ?? []).length}:${createHash('sha256').update(payload).digest('hex').slice(0, 24)}`;
}

/**
 * 桥接说明：本通道下 agent 用**它自己的原生工具**，宿主（DSH）的工具清单对它不存在。
 * 不给这段，模型会照着 DSH 的系统提示去调 `pwsh` / `fs-local` 之类不存在的工具，
 * 或把 `<antml:invoke>` 当正文输出。首尾各一道（首因 + 近因）。
 */
export const TOOL_RULE_HEAD =
  '【工具规则 · 最高优先级】你运行在 ZCode agent 运行时，唯一可用的工具是你的原生工具' +
  '（Bash、Read、Write、Edit、Glob、Grep、WebSearch、WebFetch 等），用原生机制直接调用。' +
  '下文系统提示里列出的其他工具属于宿主应用 DeepSeek Harness，在本运行时中不存在：' +
  '不要调用、不要模仿其格式；要跑 PowerShell / Python 一律通过 Bash。' +
  '绝不把 <antml:...> 之类的调用标记写进回复正文。\n';
export const BRIDGE_NOTE =
  '\n\n# 宿主桥接说明（优先级高于上文与之冲突的内容）\n' +
  '- 你实际运行在 ZCode agent 运行时里。需要读文件、跑命令、检索时，直接用你的原生工具完成，' +
  '然后用文字汇报结果。\n' +
  '- 不要模仿宿主工具（DSH）的调用格式，也不要把调用文本当作回复正文输出。';

// ─── app-server JSON-RPC 客户端 ──────────────────────────────────────────────

/**
 * app-server 会话同时只允许一个在途回合；本类负责进程生命周期与收发。
 * 任何失败都让挂起请求以 Error 收尾，绝不悬挂。
 */
export class AppServerClient {
  /**
   * @param {{ spawnImpl?: Function, cliPath: string, cliNode: string, env: object,
   *           cwd: string, rpcTimeoutMs: number, logger?: object }} deps
   */
  constructor({ spawnImpl, cliPath, cliNode, env, cwd, rpcTimeoutMs, logger }) {
    this.spawnImpl = spawnImpl ?? spawn;
    this.cliPath = cliPath;
    this.cliNode = cliNode;
    this.env = env;
    this.cwd = cwd;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.logger = logger;
    this.child = undefined;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = '';
    this.starting = undefined;
    this.disposed = false;
    /** 子进程退出时的回调：适配器用它丢弃已失效的会话映射。 */
    this.onExit = undefined;
    /** 最近一次观测到的执行渠道（`session.updated` 的 providerId/modelId/baseURL）。 */
    this.lastChannel = undefined;
  }

  async ensureStarted() {
    if (this.child !== undefined) return;
    if (this.starting !== undefined) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async start() {
    if (this.disposed) throw new Error('app-server 已销毁（插件被停用或正在重启）');
    if (!existsSync(this.cliPath)) throw new Error(`找不到 ZCode CLI：${this.cliPath}`);
    let child;
    try {
      child = this.spawnImpl(this.cliNode, [this.cliPath, 'app-server', '--surface', 'terminal', '--no-color'], {
        cwd: this.cwd,
        env: this.env,
        // 注意：**不能**加 `--browser-use headless`（app-server 只允许 -p/--target/tui 搭配它，加了直接退出）。
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(`app-server 启动失败：${error?.message ?? error}`);
    }
    this.child = child;
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => this.onData(chunk));
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => {
      const text = String(chunk).trim();
      if (text !== '') this.logger?.debug?.(`zcode app-server: ${text.slice(0, 200)}`);
    });
    child.on?.('exit', (code) => {
      this.logger?.warn?.(`app-server 退出（code=${code}），下次调用会重启`);
      this.failAll(new Error(`app-server 已退出（code=${code}）`));
      this.child = undefined;
      try {
        this.onExit?.();
      } catch {
        /* 清理回调不影响收发 */
      }
    });
    // spawn 失败是 'error' 事件：不接住就是未捕获异常，会把宿主进程一起带崩。
    child.on?.('error', (error) => {
      this.logger?.error?.(`app-server 启动失败：${error?.message ?? error}`);
      this.failAll(new Error(`app-server 启动失败：${error?.message ?? error}`));
      this.child = undefined;
      try {
        this.onExit?.();
      } catch {
        /* 同上 */
      }
    });
  }

  failAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > LINE_BUFFER_CAP && this.buffer.indexOf('\n') < 0) {
      this.logger?.warn?.('app-server 输出无换行且超上限，丢弃缓冲（协议异常？）');
      this.buffer = '';
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  dispatch(message) {
    // 我方请求的响应
    if (message?.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) entry.reject(new Error(String(message.error?.message ?? 'app-server 错误')));
      else entry.resolve(message.result);
      return;
    }
    // 服务端 → 客户端 的请求（必须应答）
    if (message?.method !== undefined && message.id !== undefined) {
      this.onServerRequest(message);
      return;
    }
    // 通知
    if (message?.method !== undefined) {
      for (const listener of this.listeners) {
        try {
          listener(message);
        } catch {
          /* 单个监听器异常不影响收发 */
        }
      }
    }
  }

  /**
   * 服务端请求的默认应答。**子类/适配器可覆写 `onServerRequest` 的钩子**——
   * 这里实现的是安全默认：偏好回复空对象、权限一律拒绝（真正放行由适配器按配置决定）。
   */
  onServerRequest(message) {
    this.write({ id: message.id, result: {} });
  }

  request(method, params, timeoutMs = this.rpcTimeoutMs) {
    if (this.disposed) return Promise.reject(new Error('app-server 已销毁'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  /** 通知（无响应）。 */
  notify(method, params) {
    this.write({ method, params });
  }

  write(message) {
    try {
      this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.logger?.warn?.(`app-server 写入失败：${error?.message ?? error}`);
    }
  }

  onNotification(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * **硬重启**：杀掉当前子进程并复位到"可重新启动"状态（`ensureStarted()` 会重新 spawn）。
   *
   * 用途（2026-10-11 真机事故）：上一轮回合锁迟迟不释放时（`A prompt is already running for
   * this session`），补发 `session/stop` + 等待可能都不够 —— **新进程没有残留回合**是唯一
   * 可靠手段。与 `dispose()` 的唯一区别是**不置 disposed**（那会让 ensureStarted 直接抛）。
   */
  restart() {
    this.dispose();
    this.disposed = false;
    this.buffer = '';
    this.starting = undefined;
  }

  dispose() {
    this.disposed = true;
    this.failAll(new Error('app-server 客户端已销毁'));
    const child = this.child;
    this.child = undefined;
    if (child === undefined) return;
    try {
      // Windows：树杀兜底孙进程；进程已退出时 taskkill 返回非 0 属正常。
      if (platform() === 'win32' && typeof child.pid === 'number') {
        const killer = this.spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on?.('error', () => {});
      }
    } catch {
      /* 树杀失败不致命 */
    }
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }
}

/** `session/event` 的 (type, payload) 提取：**type 在 params 顶层**，不是 payload.type。 */
export function eventPayload(message) {
  const params = message?.params ?? {};
  const type = params.type ?? params.payload?.type ?? '';
  return { type, payload: params.payload ?? {}, params };
}

/**
 * 把 CLI 的 usage 折算成 **DSH 的单次调用口径**（2026-10-10 真机事故修复）。
 *
 * ## 为什么必须折算
 * CLI 的 `turn.completed.usage` **不是**一次调用的用量，而是**本回合全部模型调用之和**：
 * `zcode.cjs` 里 `ZO(events)` 收集本回合每条 `ModelComplete` 的 usage，再交给 `Jgr(...)`
 * 用 `reduce` 逐桶相加，并给出 `modelRequestCount`（本回合的模型调用次数）。
 * 而 DSH 的 usage 是**单次请求**口径：`dsh-token-meter` 直接拿它当 `contextPressure` 的锚点
 * （`pressureFrom(usage) = inputTokens + cacheReadTokens + cacheWriteTokens`），
 * `measure().totalTokens` 也在 `usageTokens(usage) >= 启发式估值` 时取它做 baseline。
 * ⇒ 照搬聚合值 = 把"上下文已用"抬高 N 倍。
 *
 * ## 实测（本机 2026-10-10，ZCode Start Plan 通道）
 * - 单调用回合：账本 `~/.dsh/zcode-runs.jsonl` 记 input=117,207 / 220,089，与 CLI
 *   `~/.zcode/cli/rollout/model-io-<sid>.jsonl` 里那一笔的 `response.usage.inputTokens`
 *   **逐字相同** ⇒ 聚合值**就是**按次值，照搬即正确（这类回合占多数，不该多花一次 RPC）；
 * - 17 次调用的长回合：账本记 input=3,871,622（同会话单次调用仅 ~22 万），DSH 侧
 *   `pressureTokens` 于是 ≈ 7.08M / 1M 窗口 = 708%：原生弹窗顶部「上下文已用 100%
 *   ~7.1M / 1M」与同一弹窗里**纯启发式**的明细（系统 2.2K / 工具 15.2K / 对话 7.5K）
 *   自相矛盾；虚高占用同时喂给 `dsh-compaction-basic`（80% 引擎线）与 context-pilot 的
 *   强制线（75%），同一轮里连触发两次压缩、每次都在超大估算上跑（用户看到"分析很久"）。
 *
 * ## 取哪个值当"按次"
 * 优先用 CLI **自己按次维护**的 `projection.contextUsed`（`session/read` 下发）：它在每条
 * `ModelComplete` 上被覆写为该次调用的 `inputTokens + outputTokens`
 * （`zcode.cjs`：`Ofe(usage) = kns(usage) + outputTokens`；`kns` 取 input，缺失时回退
 * `total − output` 或 cache 之和）。这正是"同一次调用的上下文有多大"的定义，
 * 也是 CLI 自身压缩决策的量纲（`tokenOverride.contextUsageTokenCount`）。
 *
 * ## 折算规则（返回值 `basis` 即取证口径）
 * - `modelRequestCount <= 1`：聚合值本身是按次值 ⇒ **原样上报**（保留 cache 分桶）；
 * - `modelRequestCount > 1` 且有 `contextUsed`：上报 `{inputTokens: contextUsed, outputTokens: 0}`
 *   —— `contextUsed` 已含该次调用的 output，再报一次就是重复计；
 * - 多调用但拿不到 `contextUsed`：**按调用次数取均值**（轮内上下文单调增长 ⇒ 均值 ≤ 末次值，
 *   宁可偏小也不虚高），调用方据此告警；
 * - `contextUsed` 超过回合聚合总量（口径漂移的护栏）：不采信，退回均值；
 * - 调用次数未知（老 CLI 不带 `modelRequestCount`）但拿得到 `contextUsed`：按按次值用。
 *
 * @param {object|undefined} cliUsage CLI 的回合聚合 usage（可含 `modelRequestCount`）
 * @param {number|undefined} contextUsed CLI `projection.contextUsed`（按次上下文用量）
 * @returns {{usage: object, basis: string, modelRequestCount: number}}
 */
export function deriveReportedUsage(cliUsage, contextUsed) {
  const pos = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.round(x) : 0);
  const u = cliUsage ?? {};
  const count = pos(u.modelRequestCount);
  const aggTotal = pos(u.inputTokens) + pos(u.outputTokens) + pos(u.cacheReadTokens) + pos(u.cacheWriteTokens);
  const ctx = pos(contextUsed);
  /* 口径漂移护栏：按次读数不可能大于整回合聚合总量（聚合值为 0 时无从校验，放行）。 */
  const ctxTrusted = ctx > 0 && (aggTotal === 0 || ctx <= aggTotal);
  const withCache = (baseInput, baseOutput, read, write) => ({
    inputTokens: baseInput,
    outputTokens: baseOutput,
    ...(u.cacheReadTokens === undefined ? {} : { cacheReadTokens: read }),
    ...(u.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: write }),
  });
  if (count > 1) {
    if (ctxTrusted) {
      return { usage: { inputTokens: ctx, outputTokens: 0 }, basis: 'context-used', modelRequestCount: count };
    }
    const div = (x) => Math.round(pos(x) / count);
    return {
      usage: withCache(div(u.inputTokens), div(u.outputTokens), div(u.cacheReadTokens), div(u.cacheWriteTokens)),
      basis: 'divided-by-count',
      modelRequestCount: count,
    };
  }
  if (count === 0 && ctxTrusted) {
    return { usage: { inputTokens: ctx, outputTokens: 0 }, basis: 'context-used', modelRequestCount: count };
  }
  return {
    usage: withCache(pos(u.inputTokens), pos(u.outputTokens), pos(u.cacheReadTokens), pos(u.cacheWriteTokens)),
    basis: count === 1 ? 'cli-single' : 'cli-raw',
    modelRequestCount: count,
  };
}

/** 运行时偏好应答（服务端会问；不回 agent 会卡住）。 */
const RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
};

/**
 * 构造 app-server 版适配器实例。
 *
 * `BaseAdapter` / `LlmError` 由调用方从宿主候选链注入（本模块不静态 import 宿主包）。
 * @param {{
 *   BaseAdapter?: Function, LlmError?: Function,
 *   options: () => object, logger?: object,
 *   gate?: () => Promise<void>|void,
 *   record?: (info: object) => void,
 *   spawnImpl?: Function,
 * }} deps
 */
export function createAppServerAdapter({ BaseAdapter, LlmError, options, logger, gate, record, spawnImpl, materializeImages }) {
  const base = typeof BaseAdapter === 'function' ? BaseAdapter : class {};
  const fail = (message, code) => {
    if (typeof LlmError === 'function') return new LlmError(message, code);
    const error = new Error(message);
    error.code = code;
    return error;
  };

  class ZcodeAppServerAdapter extends base {
    constructor() {
      super();
      this.options = options;
      this.logger = logger;
      this.client = new AppServerClient({
        spawnImpl,
        cliPath: '',
        cliNode: 'node',
        env: {},
        cwd: homedir(),
        rpcTimeoutMs: 120000,
        logger,
      });
      /** DSH sessionId → app-server 会话条目 */
      this.sessions = new Map();
      /** DSH sessionId → 上一轮收尾 Promise（同一会话回合串行化闸门） */
      this.turnLocks = new Map();
      /** 在途流句柄：进程退出 / dispose 时立刻唤醒，不等回合超时。 */
      this.activeStreams = new Set();
      this.client.onExit = () => {
        if (this.sessions.size !== 0) {
          this.logger?.warn?.(`zcode-appserver: app-server 进程已退出，丢弃 ${this.sessions.size} 个缓存会话`);
          this.sessions.clear();
        }
        for (const handle of this.activeStreams) {
          try {
            handle.onDeath();
          } catch {
            /* 单个流的收尾不影响其他 */
          }
        }
      };
      this._configureClient();
    }

    /** 从当前 options 重建 client 的静态参数（配置热更新后下一次调用即生效）。 */
    _configureClient() {
      const cfg = this.options();
      this.client.cliPath = cfg.zcodeCliPath;
      this.client.cliNode = cfg.zcodeCliNode;
      this.client.cwd = cfg.appServerWorkspace;
      this.client.rpcTimeoutMs = cfg.appServerRpcTimeoutMs;
      this.client.env = this._childEnv(cfg);
      /* 服务端请求处理器**常驻**（而不是只在 stream() 里临时装）：
       * agent 在 `session/create` 阶段就可能问 `session/requestRuntimePreferences`，
       * 若那时没人应答，拿到的是默认空 `{}` ⇒ 回 `invalid_type: nativeSearchEnhancementsEnabled`
       * 这种看不出根因的错。常驻后任何入口（含未来的非 stream 调用）都能正确应答。 */
      this.client.onServerRequest = (message) => this._answerServerRequest(message);
    }

    /** GUI 同款子进程 env：四个 ZCODE_* 缺一不可（否则 CLI 落到 0.0.0-dev 目录）。 */
    _childEnv(cfg) {
      const overrides = {
        ZCODE_SERVICE_AUTHORITY_MODE: 'desktop-local',
        ZCODE_BASE_URL: 'https://zcode.z.ai',
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(cfg.zcodeDataBaseDir, '.zcode', 'v2', 'provider_config.json'),
      };
      if (this.builtin !== undefined) {
        overrides.ZCODE_APP_VERSION = this.builtin.version;
        overrides.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = this.builtin.activeFilePath;
      }
      return buildChildEnv(process.env, overrides, cfg.childEnvAllow);
    }

    dispose() {
      this.client.dispose();
      for (const handle of this.activeStreams) {
        try {
          handle.onDeath();
        } catch {
          /* 单个流的收尾不影响其他 */
        }
      }
      this.sessions.clear();
      this.turnLocks.clear();
    }

    /**
     * 当前配置暴露的模型目录（内置目录 ∩ `appServerModels`；未知 id 自动丢弃）。
     * `contextBudgets[id]` 覆盖上下文窗口 —— 面板的 200K/1M 单选写的就是它，
     * 与 Coding Plan 通道**共用同一份预算字典**（模型 id 不重叠，互不干扰）。
     * 这里是唯一的覆盖点：`listModels` 与 `resolveModel` 都走它。
     *
     * 推理档（2026-10-10 补）：档位事实取自 **ZCode config 的 start-plan 套餐段**
     * （与 Coding Plan 通道同源），读不到才回退到模块常量（同样源自官方声明）。
     */
    _catalog() {
      const cfg = this.options();
      const budgets = cfg.contextBudgets !== null && typeof cfg.contextBudgets === 'object' ? cfg.contextBudgets : {};
      const official = readStartPlanReasoningMeta(resolveAccountProviderId(cfg));
      return resolveAppServerCatalog(cfg.appServerModels).map((model) => {
        const override = budgets[model.id];
        const facts = reasoningFacts(official, model.id, cfg.appServerReasoningLevel);
        const withBudget = Number.isFinite(override) && override > 0
          ? { ...model, contextWindow: Math.min(Math.trunc(override), MAX_CONTEXT_WINDOW) }
          : model;
        return { ...withBudget, reasoningLevels: facts.levels, defaultReasoningLevel: facts.defaultLevel };
      });
    }

    /**
     * 声明给宿主的输入能力。**只有真接了 attachments 服务才敢声明 `image`** ——
     * 声明了却拿不到图，正是 TROUBLESHOOTING §2.7 那个"带图会话整体失败"的坑。
     */
    _inputModalities() {
      return this.options().supportsImages === true ? ['text', 'image'] : ['text'];
    }

    providerInfo(provider) {
      return { id: provider, name: APPSERVER_DISPLAY_NAME };
    }

    providerRetryPolicy() {
      return this.options().retryPolicy;
    }

    listModels(provider) {
      return Promise.resolve(
        this._catalog().map((model) => ({
          provider,
          id: model.id,
          name: model.name ?? model.id,
          inputModalities: this._inputModalities(),
        }))
      );
    }

    resolveModel(provider, model) {
      const cfg = this.options();
      const configured = this._catalog().find((entry) => entry.id === model);
      const reasoning = buildReasoningMeta(configured?.reasoningLevels, configured?.defaultReasoningLevel);
      return Promise.resolve({
        provider,
        id: model,
        name: configured?.name ?? model,
        inputModalities: this._inputModalities(),
        context: { contextWindow: configured?.contextWindow ?? cfg.contextWindow },
        defaultMaxTokens: configured?.maxTokens ?? FALLBACK_MAX_TOKENS,
        /* 声明官方档位 ⇒ 组装器/UI 出现思考档位选择器；请求侧由 `request.reasoningEffort`
         * 回来（宿主已按这份 efforts 校验过），再由本适配器落到 CLI 的 reasoningLevel。 */
        ...(reasoning === undefined ? {} : { reasoning }),
      });
    }

    /** 让 app-server 放弃该会话正在跑的回合（`session/stop` 是通知，无响应）。 */
    stopTurn(session, reason) {
      if (session?.sessionId === undefined) return;
      try {
        this.client.notify('session/stop', { sessionId: session.sessionId });
        this.logger?.warn?.(`zcode-appserver: 已补发 session/stop（${reason}）`);
      } catch (error) {
        this.logger?.warn?.(`zcode-appserver: session/stop 发送失败（${reason}）：${error?.message ?? error}`);
      }
    }

    /**
     * 读 CLI 自己按次维护的上下文读数（`session/read` → `projection.contextUsed`）。
     *
     * 只在**多调用回合**才需要它（单调用回合的聚合 usage 本身就是按次值，见
     * `deriveReportedUsage`），所以这条 RPC 不会出现在多数回合里。
     * `messageLimit: 1` 是为了让 CLI 的快照构建尽量便宜（默认会带上整段消息）。
     * 任何失败都降级成 `null`（调用方退回均值折算）——**绝不打断已经跑完的回合**。
     */
    async _readSessionContext(session, cfg) {
      try {
        const result = await this.client.request(
          'session/read',
          { sessionId: session.sessionId, messageLimit: 1 },
          Math.min(cfg.appServerRpcTimeoutMs, SESSION_READ_TIMEOUT_MS)
        );
        const projection = result?.projection;
        const used = projection?.contextUsed;
        if (typeof used !== 'number' || !Number.isFinite(used) || used <= 0) {
          this.logger?.warn?.('zcode-appserver: session/read 未给出 projection.contextUsed（本轮按调用次数取均值折算）');
          return null;
        }
        return {
          contextUsed: used,
          contextWindow: typeof projection?.contextWindow === 'number' ? projection.contextWindow : undefined,
        };
      } catch (error) {
        this.logger?.warn?.(`zcode-appserver: session/read 读取上下文读数失败（本轮按调用次数取均值折算）：${error?.message ?? error}`);
        return null;
      }
    }

    /**
     * 让 CLI 把会话切到指定模型 + 推理档（`session/setModel`）。
     * 失败**不致命**（会话默认供应商仍可能可用），但必须留痕 —— 否则"没换成"会静默。
     */
    async _applyModel(sessionId, accountProviderId, modelId, reasoningLevel, cfg) {
      try {
        await this.client.request(
          'session/setModel',
          { sessionId, model: { providerId: accountProviderId, modelId, options: { reasoningLevel } } },
          cfg.appServerRpcTimeoutMs
        );
        this.logger?.info?.(`zcode-appserver: 会话模型已切到 ${accountProviderId}/${modelId}（reasoningLevel=${reasoningLevel}）`);
        return true;
      } catch (error) {
        this.logger?.warn?.(`zcode-appserver: setModel 失败（继续用会话当前模型）：${error?.message ?? error}`);
        return false;
      }
    }

    /**
     * 建立（或复用）app-server 会话：create → subscribe → setMode → 注入账户 → setModel。
     *
     * 推理档（2026-10-10 补）：档位由**每次请求**带进来（宿主的 `reasoningEffort`，
     * 已按 `resolveModel` 声明的 efforts 校验过），档位变化时**复用会话并重发 setModel**
     * —— 原来只在建会话时设一次，用户在输入框换档位就完全不生效。模型 id 变化同理
     * （同一 DSH 会话内切换赠送模型时旧实现会一直用第一个模型）。
     *
     * @param {string} dshSessionKey DSH 会话 id
     * @param {string} modelId 本轮要用的模型 id
     * @param {string} reasoningLevel 本轮推理档（CLI 的 `options.reasoningLevel`）
     */
    async ensureSession(dshSessionKey, modelId, reasoningLevel) {
      const cfg = this.options();
      const level = typeof reasoningLevel === 'string' && reasoningLevel !== '' ? reasoningLevel : cfg.appServerReasoningLevel;
      const existing = this.sessions.get(dshSessionKey);
      if (existing !== undefined) {
        if (existing.modelId === modelId && existing.reasoningLevel === level) return existing;
        const accountProviderId = resolveAccountProviderId(cfg);
        await this._applyModel(existing.sessionId, accountProviderId, modelId, level, cfg);
        await sleep(STEP_SETTLE_MS);
        existing.modelId = modelId;
        existing.reasoningLevel = level;
        return existing;
      }
      // 每次建会话现读账号家族（跟随 ZCode 登录态变化，不缓存）——决定注入哪个 start-plan 账户。
      const accountProviderId = resolveAccountProviderId(cfg);
      this._configureClient();

      // builtin 运行时必须在 spawn 前定下来：它同时决定 spawn 的 env 与注入的 basedOn。
      this.builtin = resolveBuiltinRuntime(cfg.zcodeDataBaseDir);
      if (this.builtin === undefined) {
        this.logger?.warn?.(
          'zcode-appserver: 未找到 zcode-builtin.json 运行时目录 —— Start Plan 注入会失效。' +
            '请先启动一次 ZCode 桌面端（或检查 ZCODE_CONNECT_DATA_BASE_DIR）。'
        );
      }
      this._configureClient();

      await this.client.ensureStarted();
      const created = await this.client.request(
        'session/create',
        { workspace: { workspacePath: cfg.appServerWorkspace, workspaceKey: 'dsh-connect-zcode' } },
        cfg.appServerRpcTimeoutMs
      );
      const sessionId = created?.session?.sessionId ?? created?.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw fail('app-server 没有返回 sessionId', 'PROVIDER');
      }
      await this.client.request(
        'session/subscribe',
        { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true },
        cfg.appServerRpcTimeoutMs
      );
      // 权限模式：allow-all 走 yolo（DSH 委派场景没有人工批准 UI）；deny-all 留 build。
      try {
        await this.client.request(
          'session/setMode',
          { sessionId, mode: cfg.appServerToolPolicy === 'allow-all' ? 'yolo' : 'build' },
          cfg.appServerRpcTimeoutMs
        );
      } catch (error) {
        this.logger?.warn?.(`zcode-appserver: setMode 失败（继续用会话默认模式）：${error?.message ?? error}`);
      }
      await this.injectAccount(cfg, accountProviderId);
      await sleep(ACCOUNT_INJECT_SETTLE_MS);
      await this._applyModel(sessionId, accountProviderId, modelId, level, cfg);
      await sleep(STEP_SETTLE_MS);
      const entry = { sessionId, firstTurn: true, modelId, reasoningLevel: level, sentFingerprint: undefined };
      this.sessions.set(dshSessionKey, entry);
      this.logger?.info?.(`zcode-appserver: 新建 app-server 会话 ${sessionId}`);
      return entry;
    }

    /** 注入套餐账户（GUI 同款）。basedOn 算错会被 registry **静默跳过**，故必须与 spawn 同源。 */
    async injectAccount(cfg, accountProviderId) {
      if (cfg.appServerInjectAccount !== true) return;
      if (this.builtin === undefined) {
        this.logger?.warn?.('zcode-appserver: 跳过账户注入（没有可用的 builtin 运行时）');
        return;
      }
      try {
        const basedOn = computeBuiltinRevision(this.builtin.activeFilePath);
        const patch = buildAccountConfigPatch(basedOn, accountProviderId, this._catalog().map((m) => m.id));
        const result = await this.client.request('provider/updateAccountConfig', patch, cfg.appServerRpcTimeoutMs);
        this.logger?.info?.(
          `zcode-appserver: 已注入 ${accountProviderId}` +
            `（providerCount=${result?.providerCount ?? '?'} status=${result?.status ?? '?'}）`
        );
      } catch (error) {
        this.logger?.warn?.(`zcode-appserver: 账户注入失败（不影响其他通道）：${error?.message ?? error}`);
      }
    }

    /** 服务端请求应答：鉴权交给宿主、权限按策略、其余回空对象。 */
    _answerServerRequest(message) {
      const cfg = this.options();
      if (message.method === 'session/requestRuntimePreferences') {
        this.client.write({ id: message.id, result: RUNTIME_PREFERENCES });
        return;
      }
      if (message.method === 'interaction/requestProviderRuntimeHeaders') {
        // 关键一步：agent 自己算签名，我们只把 token 递回去。
        try {
          const storePath = cfg.appServerCredentialStorePath;
          const auth = readStartPlanAuth(typeof storePath === 'string' && storePath !== '' ? storePath : undefined);
          const appVersion = this.builtin?.version ?? '0.0.0.0';
          this.logger?.info?.(`zcode-appserver: 应答鉴权（token ${auth.token.length} 字符, appVersion=${appVersion}）`);
          this.client.write({
            id: message.id,
            result: {
              headersApplied: true,
              requestAuth: {
                apiKey: auth.token,
                headers: {
                  'http-referer': 'https://zcode.z.ai',
                  'user-agent': `ZCode/${appVersion}`,
                  'x-zcode-app-version': appVersion,
                  'x-title': 'Z Code@cli',
                },
              },
            },
          });
        } catch (error) {
          // 明确拒绝（headersApplied:false）让 agent 走自己的兜底，而不是挂死。
          this.logger?.warn?.(`zcode-appserver: 鉴权应答失败 → ${error?.message ?? error}`);
          this.client.write({ id: message.id, result: { headersApplied: false, errorMessage: String(error?.message ?? error) } });
        }
        return;
      }
      if (message.method === 'interaction/requestPermission' || /approval|permission/i.test(String(message.method))) {
        this.client.write({ id: message.id, result: { decision: cfg.appServerToolPolicy === 'allow-all' ? 'allow' : 'deny' } });
        return;
      }
      if (message.method === 'interaction/browserList') {
        // 宿主不提供浏览器集成：回空列表，agent 回落自带 headless backend。
        this.client.write({ id: message.id, result: { browsers: [] } });
        return;
      }
      if (message.method === 'interaction/browserExecute') {
        this.client.write({
          id: message.id,
          result: { ok: false, error: { code: 'host_unavailable', message: '宿主不提供浏览器集成' } },
        });
        return;
      }
      this.client.write({ id: message.id, result: {} });
    }

    /**
     * 一轮对话 → StreamChunk 流。
     * @param {object} request DSH 的 GenerateOptions
     */
    async *stream(request) {
      const cfg = this.options();
      const started = Date.now();

      // 会话标题这类辅助调用在本地生成，不消耗额度。
      if (request?.purpose === 'session-title') {
        const title = (lastUserText(request.messages) || '新会话').replace(/\s+/g, ' ').slice(0, 24);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: title };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: title } };
        /* 本地生成的标题**不发 usage 块**（没有真实上游用量）：宿主的 tokenMeter 把 usage 当
         * contextPressure 锚点，报一个 0 等于把"已用上下文"清零（见下面 usage 收尾处的长注释）。 */
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      /* 调用门（PROTOCOL §7.1）：冻结期一律拒绝，**连 agent 进程都不起**。
       * 这里**故意抛**而不是转成 finish chunk —— 与既有 `zcode` 通道（resolveApiKey 抛
       * SwitchFrozenError）保持同一语义，宿主会把适配器抛错规范化成终态 error chunk。
       * 位置在取回合锁之前，故不需要任何释放动作。 */
      if (typeof gate === 'function') await gate();

      const configured = this._catalog().find((entry) => entry.id === request.model);
      const modelId = configured?.id ?? this._catalog()[0]?.id ?? 'GLM-5.3-Flash';
      const key = String(request.sessionId ?? 'default');
      /* 本轮推理档：宿主按 `resolveModel` 声明的 efforts 校验后从 `reasoningEffort` 传回；
       * 没传（模型未声明档位 / 老宿主）→ 配置默认档。 */
      const reasoningLevel =
        typeof request?.reasoningEffort === 'string' && request.reasoningEffort !== ''
          ? request.reasoningEffort
          : cfg.appServerReasoningLevel;

      if (this.client.disposed === true) throw fail('app-server 已销毁（插件被停用或正在重启），请重试', 'TRANSPORT');

      // 回合串行化：同一 DSH 会话的两轮排队跑（app-server 一个会话只允许一个在途回合）。
      const previousTurn = this.turnLocks.get(key) ?? Promise.resolve();
      let releaseTurn = () => {};
      const turnDone = new Promise((done) => {
        releaseTurn = done;
      });
      const tail = previousTurn.then(() => turnDone);
      this.turnLocks.set(key, tail);
      tail.catch(() => {}).then(() => {
        if (this.turnLocks.get(key) === tail) this.turnLocks.delete(key);
      });
      await settleWithin(previousTurn, TURN_QUEUE_MAX_MS);

      /** 声明必须在通知监听注册**之前**：闭包引用它，晚声明会在事件早到时撞 TDZ。 */
      let session;
      const queue = [];
      let notify = () => {};
      const waitFor = () => new Promise((done) => {
        notify = done;
      });
      let finished;
      let channel;
      /* 上报给 DSH 的单次调用口径 usage（null = **无可信读数，一个块都不发**）——见收尾处注释。 */
      let usage = null;
      /* `usage` = 上报给 DSH 的**单次调用口径**；`turnUsage` = CLI 的**回合聚合**（本回合 N 次
       * 模型调用之和）。两者不是一回事，折算规则见 `deriveReportedUsage`（2026-10-10 真机事故）。 */
      let turnUsage;
      let turnSettled = false;
      /* 主动硬重启客户端时置真：此时"进程退出"是**我们自己安排的**，不能把本轮判成死亡
       * （否则 onDeath 会把 finished 写成 failed，重启等于自杀）。 */
      let suppressDeath = false;
      const streamHandle = {
        onDeath: () => {
          if (suppressDeath || finished !== undefined) return;
          finished = { response: '', resultType: 'failed', error: 'app-server 进程已退出，回合中止（下次调用自动重建会话）' };
          notify();
        },
      };
      this.activeStreams.add(streamHandle);
      const offNotifications = this.client.onNotification((message) => {
        if (message.method !== 'session/event') return;
        const { type, payload, params } = eventPayload(message);
        if (session?.sessionId !== undefined && params.sessionId !== undefined && params.sessionId !== session.sessionId) return;
        switch (type) {
          case 'session.updated':
            // 这是"到底烧的哪个渠道"的唯一确证点（providerId/baseURL）。
            if (typeof payload.baseURL === 'string') {
              channel = { providerId: payload.providerId, modelId: payload.modelId, baseURL: payload.baseURL };
              this.client.lastChannel = channel;
            }
            break;
          case 'model.streaming': {
            if (payload.done === true) break;
            if (payload.kind === 'text_delta') queue.push({ kind: 'text', text: String(payload.delta ?? '') });
            else if (payload.kind === 'reasoning_delta') queue.push({ kind: 'reasoning', text: String(payload.delta ?? '') });
            notify();
            break;
          }
          case 'turn.completed': {
            if (payload.usage !== undefined) {
              turnUsage = {
                inputTokens: payload.usage.inputTokens ?? 0,
                outputTokens: payload.usage.outputTokens ?? 0,
                ...(payload.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: payload.usage.cacheReadTokens }),
                /* cacheWriteTokens 与 modelRequestCount 此前被丢掉：前者 DSH 的
                 * `pressureFrom` 计入（口径必须完整），后者决定要不要取按次读数折算。 */
                ...(payload.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: payload.usage.cacheWriteTokens }),
                ...(payload.usage.modelRequestCount === undefined ? {} : { modelRequestCount: payload.usage.modelRequestCount }),
              };
            }
            finished = {
              response: typeof payload.response === 'string' ? payload.response : '',
              resultType: payload.resultType ?? 'success',
              error: undefined,
            };
            notify();
            break;
          }
          case 'turn.failed': {
            const attribution = payload.error?.attribution ?? {};
            const detail = payload.error?.message ?? payload.error?.code ?? 'unknown';
            this.logger?.warn?.(
              `zcode-appserver: 回合失败（${attribution.providerId ?? '?'}/${attribution.modelId ?? '?'} ` +
                `${attribution.providerErrorCode ?? ''} ${detail}）`
            );
            finished = { response: '', resultType: 'failed', error: detail, errorCode: attribution.providerErrorCode };
            notify();
            break;
          }
          default:
            break;
        }
      });
      // 服务端请求的应答（鉴权 / 权限）：覆写钩子，事件期间常驻。
      const serverRequestHandler = (message) => this._answerServerRequest(message);
      this.client.onServerRequest = serverRequestHandler;

      try {
        session = await this.ensureSession(key, modelId, reasoningLevel);

        // 历史分叉检测：DSH 侧编辑/回退过历史就重建会话并按首轮重放。
        const fingerprint = conversationFingerprint(request.messages, request.system);
        if (!session.firstTurn && session.sentFingerprint !== undefined && session.sentFingerprint !== fingerprint) {
          this.logger?.warn?.('zcode-appserver: 检测到会话历史变化，重建 app-server 会话（按首轮重放）');
          this.sessions.delete(key);
          session = await this.ensureSession(key, modelId, reasoningLevel);
        }

        const imageBlocks = collectImageBlocks(request.messages);
        /* 图片 → app-server 的 `attachments`（`{kind:'image', …, localPath}`）。
         * 解析失败**降级为纯文本**而不是整轮失败：看不到图总好过整个会话挂掉，而且会告警。
         *
         * ⚠️ 2026-10-11 真机事故（图片"静默丢失"）：物化函数先看**顶层注入**，再看
         * `options()` —— 宿主把 `materializeImages` 放在 `options()` 里，而这里只读顶层
         * ⇒ 恒为 undefined ⇒ 有图也按纯文本发，**且一个告警都不留**（实测 CLI 侧
         * `attachmentCount: 0`、模型请求里 0 个 image 块，查了半天才定位）。
         * 现在两条路都认，并且**只要"有图却没物化成功"就必须出声**。 */
        const attachments = await (async () => {
          if (imageBlocks.length === 0) return undefined;
          const materialize = typeof materializeImages === 'function' ? materializeImages : cfg.materializeImages;
          if (typeof materialize !== 'function') {
            this.logger?.warn?.(
              `zcode-appserver: 本轮有 ${imageBlocks.length} 张图片，但宿主未注入 materializeImages（attachments.imageHostPath 缺席？）→ 按纯文本发送`
            );
            return undefined;
          }
          try {
            const list = await materialize(imageBlocks);
            if (Array.isArray(list) && list.length > 0) {
              this.logger?.info?.(`zcode-appserver: 本轮随消息转发 ${list.length} 张图片`);
              return list;
            }
            this.logger?.warn?.(
              `zcode-appserver: 本轮有 ${imageBlocks.length} 张图片，但一张都没能物化成附件（宿主 imageHostPath 未给出可用路径？）→ 按纯文本发送`
            );
            return undefined;
          } catch (error) {
            this.logger?.warn?.(`zcode-appserver: 图片附件解析失败，本轮按纯文本发送（${error?.message ?? error}）`);
            return undefined;
          }
        })();

        const buildContent = () => {
          const base = session.firstTurn
            ? flattenConversation(request.messages, request.system) || lastUserText(request.messages)
            : lastUserText(request.messages);
          const head = session.firstTurn ? `${TOOL_RULE_HEAD}\n${base}${BRIDGE_NOTE}` : base || '（继续）';
          return attachments === undefined ? head : `${head}${IMAGE_ATTACH_NOTE}`;
        };

        // 发送 + 撞锁/会话失效恢复。
        for (let attempt = 0; ; attempt += 1) {
          try {
            await this.client.request(
              'session/send',
              { sessionId: session.sessionId, content: buildContent(), ...(attachments === undefined ? {} : { attachments }) },
              cfg.appServerRpcTimeoutMs
            );
            session.firstTurn = false;
            session.sentFingerprint = fingerprint;
            break;
          } catch (error) {
            const detail = String(error?.message ?? error);
            const stuck = STUCK_TURN_RE.test(detail);
            const stale = !stuck && STALE_SESSION_RE.test(detail);
            /* 恢复阶梯（2026-10-11 真机事故：超时后 DSH 重试撞上 `A prompt is already running`
             * 直接把用户这一轮判死）。每一级都留痕，最后一级才用"杀进程"这种重手段。
             *   ① 补发 session/stop + 等 1.5s  ② 再 stop + 等 6s
             *   ③ 硬重启 CLI 子进程 + 重建会话（新进程没有残留回合 —— 唯一可靠手段） */
            if (!stuck && !stale) throw error;
            if (attempt > STUCK_RECOVERY_WAITS_MS.length) throw error;
            if (stale) {
              this.logger?.warn?.(`zcode-appserver: 会话已失效（${detail}）→ 重建会话并重放整段对话`);
              this.sessions.delete(key);
              session = await this.ensureSession(key, modelId, reasoningLevel);
              continue;
            }
            const waitMs = STUCK_RECOVERY_WAITS_MS[attempt];
            if (waitMs !== undefined) {
              this.logger?.warn?.(`zcode-appserver: 会话上一轮未释放（${detail}）→ 补发 session/stop 后等 ${waitMs}ms 重试`);
              this.stopTurn(session, '上一轮未释放');
              await sleep(waitMs);
              continue;
            }
            this.logger?.warn?.(
              `zcode-appserver: 回合锁 ${attempt + 1} 次都没释放（${detail}）→ **硬重启 app-server 子进程**并重建会话`
            );
            /* 这一步是自己安排的退出：先屏蔽 onDeath，别把本轮判死（否则重启=自杀）。
             * `ensureSession` 会重新 spawn 并跑完 create/subscribe/setMode/注入（数秒），
             * 旧进程的 exit 事件在那之前就派发完了，之后再把死亡监听恢复。 */
            suppressDeath = true;
            this.client.restart();
            this.sessions.delete(key);
            session = await this.ensureSession(key, modelId, reasoningLevel);
            suppressDeath = false;
          }
        }

        /* ── 正文 / 思考的**块划分**（2026-10-10 真机事故修复，坑位见 TROUBLESHOOTING §2.11）──
         * 宿主的 `BlockAssembler` 与 GUI 的 `updateChunk` 都以 **index 为键**：
         *   - GUI：`blocks[i] = { kind, text: (previous?.kind === <同类> ? previous.text : "") + delta }`
         *     ⇒ 同一 index 上 text / reasoning 交替时，**每次换类都会丢弃上一块内容**；
         *   - 汇编器：`ensure(index, type)` 只在 index 不存在时定类型，之后两类 delta 会拼进
         *     同一个块，而 `block-end` 的负载**整体替换**它（旧实现正是用 CLI 的最终
         *     response 收尾 ⇒ 流出的中间内容被抹掉）。
         * ⇒ 规矩：**换一次块类型就换一个新 index，并显式 `block-start`**；每块用自己的
         * 累计文本收尾（`block-end` 与已流出内容一致，宿主不会替换出不同内容）。 */
        let nextIndex = 0;
        let open = null; // { index, blockType, text }
        let streamedText = '';
        const closeOpen = function* () {
          if (open === null) return;
          yield { type: 'block-end', index: open.index, block: { type: open.blockType, text: open.text } };
          open = null;
        };
        const pushDelta = function* (blockType, text) {
          if (text === '') return;
          if (open === null || open.blockType !== blockType) {
            yield* closeOpen();
            open = { index: nextIndex, blockType, text: '' };
            nextIndex += 1;
            yield { type: 'block-start', index: open.index, blockType };
          }
          open.text += text;
          if (blockType === 'text') streamedText += text;
          yield blockType === 'text'
            ? { type: 'text-delta', index: open.index, text }
            : { type: 'reasoning-delta', index: open.index, text };
        };
        // 正文流出：伪 antml 标记一旦出现就整段掐断（防标签渣进聊天窗）。
        let suppressed = false;
        let tailText = '';
        const emitText = function* (raw) {
          if (suppressed) return;
          if (LEAK_TAG_RE.test(raw) || LEAK_TAG_RE.test((tailText + raw).slice(-64))) {
            suppressed = true;
            return;
          }
          tailText = (tailText + raw).slice(-24);
          yield* pushDelta('text', raw);
        };
        const drain = function* () {
          while (queue.length > 0) {
            const item = queue.shift();
            if (item.kind === 'text') yield* emitText(item.text);
            else yield* pushDelta('reasoning', sanitizeLeakedCalls(item.text));
          }
        };

        const deadline = Date.now() + cfg.appServerTurnTimeoutMs;
        while (finished === undefined) {
          yield* drain();
          if (finished !== undefined) break;
          if (Date.now() > deadline) throw fail(`app-server 回合超时（${cfg.appServerTurnTimeoutMs}ms）`, 'TIMEOUT');
          if (request.signal?.aborted === true) throw fail('请求被调用方中止', 'ABORTED');
          await Promise.race([waitFor(), sleep(500)]);
        }
        turnSettled = finished.resultType === 'success';
        yield* drain();

        /* ── usage 口径折算（2026-10-10 真机事故）────────────────────────────────
         * CLI 的 `turn.completed.usage` 是本回合 N 次模型调用之和；DSH 要的是单次调用口径
         * （tokenMeter 直接拿它当 contextPressure 锚点）。照搬 ⇒ 上下文占用虚高 N 倍。
         * 单调用回合（占多数）聚合值就是按次值 ⇒ 不多打 RPC；多调用回合才读一次
         * `session/read` 的 `projection.contextUsed`（CLI 自己按次维护的上下文读数）。 */
        if (turnSettled && turnUsage !== undefined) {
          const turnCalls = turnUsage.modelRequestCount;
          const needProbe = !(typeof turnCalls === 'number' && turnCalls <= 1);
          const probe =
            needProbe && session?.sessionId !== undefined ? await this._readSessionContext(session, cfg) : null;
          const derived = deriveReportedUsage(turnUsage, probe?.contextUsed);
          usage = derived.usage;
          this.logger?.info?.(
            `zcode-appserver: usage 口径=${derived.basis}（CLI 回合聚合 input=${turnUsage.inputTokens}` +
              ` output=${turnUsage.outputTokens} 调用次数=${turnCalls ?? '?'}` +
              `${probe === null ? '' : `；CLI contextUsed=${probe.contextUsed} window=${probe.contextWindow ?? '?'}`}` +
              `）⇒ 上报 DSH input=${usage.inputTokens} output=${usage.outputTokens}`
          );
        } else if (session?.sessionId !== undefined) {
          /* 回合未落定（中止 / 超时 / CLI 没给 usage）：照样读一次 CLI 的**按次上下文** ——
           * 它描述的是"最后一次完成的模型调用"，中止时依然是真实读数。用它当锚点既避免
           * "报 0 把占用清零"，也能把**已经被清零的锚点自愈**回真实量级。 */
          const probe = await this._readSessionContext(session, cfg);
          if (probe !== null) {
            usage = { inputTokens: probe.contextUsed, outputTokens: 0 };
            this.logger?.warn?.(
              `zcode-appserver: 回合未落定（settled=${turnSettled}）→ 改用 CLI 按次上下文 ${probe.contextUsed} 当锚点（不报 0，避免把上下文占用清零）`
            );
          }
        }

        const finalText = sanitizeLeakedCalls(finished.response ?? '');
        /* 收尾（与上面同一处事故）：**不再用最终文本覆盖**已流出的内容。
         * 每块用自己的累计文本收尾；只有"最终答案没出现在流出内容里"时才**追加**一块
         * —— 三种来源：CLI 没走 text 流（流恢复/截断）、正文被伪调用标记整段拦下、
         * 流出的中间叙述与最终应答不同。追加而非覆盖 ⇒ 不丢答案，也不再闪回。 */
        if (suppressed) yield* pushDelta('text', LEAK_SUPPRESS_NOTE);
        if (finalText !== '' && !streamedText.includes(finalText)) {
          if (streamedText !== '') {
            this.logger?.warn?.(
              `zcode-appserver: 流式正文与最终答案不一致（流式 ${streamedText.length} 字 / 最终 ${finalText.length} 字）→ 追加最终答案块，不覆盖已流出内容`
            );
          }
          yield* pushDelta('text', finalText);
        }
        /* 空回合（两者都为空）也留一个空文本块：与旧行为一致，避免宿主拿到"零块"消息。 */
        if (nextIndex === 0) {
          open = { index: 0, blockType: 'text', text: '' };
          nextIndex = 1;
          yield { type: 'block-start', index: 0, blockType: 'text' };
        }
        yield* closeOpen();
        if (channel !== undefined) {
          this.logger?.info?.(
            `zcode-appserver: 本轮执行渠道 providerId=${channel.providerId ?? '?'} model=${channel.modelId ?? '?'} baseURL=${channel.baseURL ?? '?'}`
          );
        }
        /* ── usage 只在**可信**时下发（2026-10-10 真机事故，坑位见 TROUBLESHOOTING §2.13）──
         * 宿主的 tokenMeter 把这个 usage 当 `contextPressure` 的锚点
         * （`pressureFrom = inputTokens + cacheReadTokens + cacheWriteTokens`）：**报一个 0
         * 就等于把"已用上下文"清零**。实测一次跑了 561 秒却未落定的回合（用户中止）让弹窗从
         * 40% 掉到 0% —— 同一弹窗的启发式明细明明还有 383K。
         * ⇒ 拿不到可信读数（回合未落定 / CLI 没给 usage / 全零）时**一个 usage 块都不发**：
         * 宿主退回自己的启发式估值（准确），比报 0 安全得多。 */
        if (usage !== null && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
          yield { type: 'usage', usage };
        } else {
          this.logger?.warn?.(
            `zcode-appserver: 本轮无可信 usage（settled=${turnSettled} 聚合=${turnUsage === undefined ? '无' : '有'}）→ 不下发 usage 块，宿主改用启发式估值`
          );
        }

        const channelled = channel === undefined ? {} : { channel };
        if (finished.error !== undefined || (finished.resultType !== 'success' && finalText === '')) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: finished.error !== undefined ? `ZCode Start Plan 回合失败：${finished.error}` : `app-server 回合以 ${finished.resultType} 结束`,
                code: finished.errorCode !== undefined ? String(finished.errorCode) : 'PROVIDER',
              },
            },
          };
        } else {
          yield {
            type: 'finish',
            reason: { kind: 'stop' },
            replayState: { response: { model: request.model, stopReason: 'end_turn' }, blocks: [null], ...channelled },
          };
        }
      } catch (error) {
        if (error?.code === 'ABORTED' || error?.name === 'AbortError') {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: String(error?.message ?? error), code: 'ABORTED' } } };
        } else {
          yield {
            type: 'finish',
            reason: { kind: 'error', failure: { message: `app-server 通道失败：${error?.message ?? error}`, code: error?.code ?? 'PROVIDER' } },
          };
        }
      } finally {
        this.activeStreams.delete(streamHandle);
        offNotifications();
        if (!turnSettled) this.stopTurn(session, '本轮未正常结束（超时 / 中止 / 发送失败 / 回合失败）');
        releaseTurn();
        if (typeof record === 'function') {
          try {
            record({
              model: modelId,
              endpoint: channel?.baseURL ?? null,
              /* 账本记**回合聚合**（真实消耗，多调用回合 = N 次之和），不是上报给 DSH 的按次折算值。 */
              input: turnUsage?.inputTokens ?? 0,
              output: turnUsage?.outputTokens ?? 0,
              ...(turnUsage?.modelRequestCount === undefined ? {} : { modelRequestCount: turnUsage.modelRequestCount }),
              exit: turnSettled ? 0 : 'app-server turn not settled',
              elapsedMs: Date.now() - started,
              tag: 'dsh-provider-appserver',
            });
          } catch {
            /* 记账失败不炸推理通道 */
          }
        }
      }
    }
  }

  return new ZcodeAppServerAdapter();
}
