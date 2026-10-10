/**
 * host-modules.js —— 宿主内嵌 LLM 栈（pi-ai / dsh-llm-pi-ai / dsh-llm）的候选链加载器。
 *
 * 为什么不能静态 import（zcode-dispatch 项目 pitfalls Z13-1 / ZB-01 实证）：
 * 本包是 link: 插件，Node 按包的**真实路径**向上查找 node_modules，
 * 宿主的 @deepseek-ai / @earendil-works 作用域不一定在该链上——静态裸 import
 * 可能在模块加载期即失败（zcode-dispatch 项目 Z13-1 / ZB-01 实证）。
 *
 * 候选顺序（每个候选先试 ESM import()、再试 CJS require()；Node 24 支持 require(esm)，
 * asar 的 fs 补丁对两者都生效）：
 *   1. 裸说明符（未来宿主若向 link 插件开放解析，或本包根装了依赖）；
 *   2. env ZCODE_CONNECT_MODULES_ROOT —— 显式 node_modules 根（README 有说明，兜底逃生口）；
 *   3. process.resourcesPath 推导（Electron 宿主内）：app.asar / app.asar.unpacked × 有无 dsh 段；
 *   4. env `ZCODE_CONNECT_DSH_RESOURCES` 显式指定的 DSH resources 目录（兜底逃生口）。
 * 同一候选根内解析齐全部必需包才采用（避免混根产生双份 pi-ai 实例）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** 需要从宿主解析的模块清单：spec=裸说明符；files=包内候选入口（相对包根）。 */
const REQUIRED = [
  {
    key: 'piAi',
    spec: '@earendil-works/pi-ai',
    dir: join('@earendil-works', 'pi-ai'),
    files: ['dist/index.js', 'index.js'],
    validate: (m) => typeof m?.createProvider === 'function',
    what: 'createProvider',
  },
  {
    key: 'piAiAnthropic',
    spec: '@earendil-works/pi-ai/api/anthropic-messages.lazy',
    dir: join('@earendil-works', 'pi-ai'),
    files: ['dist/api/anthropic-messages.lazy.js', 'api/anthropic-messages.lazy.js'],
    validate: (m) => typeof m?.anthropicMessagesApi === 'function',
    what: 'anthropicMessagesApi',
  },
  {
    key: 'piAiAdapter',
    spec: '@deepseek-ai/dsh-llm-pi-ai',
    dir: join('@deepseek-ai', 'dsh-llm-pi-ai'),
    files: ['lib/index.js', 'dist/index.js', 'index.js'],
    validate: (m) => typeof m?.PiAiAdapter === 'function',
    what: 'PiAiAdapter',
  },
];

/** 可选模块：拿不到就降级（retryPolicy 省略），不让激活失败。 */
const OPTIONAL = [
  {
    key: 'dshLlm',
    spec: '@deepseek-ai/dsh-llm',
    dir: join('@deepseek-ai', 'dsh-llm'),
    files: ['lib/index.js', 'dist/index.js', 'index.js'],
    validate: (m) => typeof m?.resolveRetryPolicy === 'function',
    what: 'resolveRetryPolicy',
  },
  {
    /* schemastery 也必须走宿主候选链（不能裸 import）：
     * 本包是 link 插件，裸 import('@deepseek-ai/schemastery') 在 DSH 进程内**解析不到**
     * （profile 树无该包；它在 app.asar 内嵌 node_modules）。
     * 拿不到的后果不止"降级"：Config 会退回手写 schema → enabledModelIds 无法打 volatile 标记
     * → DSH 0.1.7 的写入门禁**静默拒绝**面板的每一次保存（且 set() 照样 resolve）。
     * 故与 pi-ai 栈同级走候选链。 */
    key: 'schemastery',
    spec: '@deepseek-ai/schemastery',
    dir: join('@deepseek-ai', 'schemastery'),
    files: ['lib/index.js', 'dist/index.js', 'index.js'],
    validate: (m) => typeof (m?.default ?? m)?.object === 'function',
    what: 'schemastery z.object',
  },
];

/** 候选 node_modules 根（顺序即优先级）。 */
function moduleRootCandidates() {
  const out = [];
  const env = process.env.ZCODE_CONNECT_MODULES_ROOT;
  if (typeof env === 'string' && env) out.push(env);
  const res = typeof process?.resourcesPath === 'string' ? process.resourcesPath : '';
  if (res) {
    for (const base of [join(res, 'app.asar'), join(res, 'app.asar.unpacked')]) {
      out.push(join(base, 'dsh', 'node_modules'));
      out.push(join(base, 'node_modules'));
    }
  }
  // 兜底：从本机常见安装位推导（仅当 resourcesPath 不可用时才需要）。
  // 不写死任何绝对路径 —— 用 env `ZCODE_CONNECT_DSH_RESOURCES` 显式指定 DSH 的
  // resources 目录（例如 Windows 默认安装 `%LOCALAPPDATA%\Programs\DeepSeek\resources`）。
  const custom = process.env.ZCODE_CONNECT_DSH_RESOURCES;
  if (typeof custom === 'string' && custom) {
    for (const base of [join(custom, 'app.asar'), join(custom, 'app.asar.unpacked')]) {
      out.push(join(base, 'dsh', 'node_modules'));
      out.push(join(base, 'node_modules'));
    }
  }
  return [...new Set(out)];
}

/** 单文件加载：ESM import 优先，失败再 CJS require。 */
async function loadFile(file) {
  try {
    return await import(pathToFileURL(file).href);
  } catch {
    return require(file);
  }
}

/** 已尝试过的裸说明符（每进程一次，避免候选根循环里重复 import）。 */
const bareAttempted = new Set();

/**
 * 从已解析入口路径向上找最近的 package.json，读 version（DE-04 用；纯诊断，绝不抛）。
 * `from` 形如 `<...>/node_modules/@scope/pkg/lib/index.js` 或 `bare:@scope/pkg`（后者无法定位，返回 null）。
 * @param {string} from
 * @returns {string|null}
 */
export function readPackageVersionNear(from) {
  try {
    if (typeof from !== 'string' || from.startsWith('bare:')) return null;
    let dir = dirname(from);
    for (let i = 0; i < 6; i += 1) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
        return typeof pkg?.version === 'string' ? `${pkg.name ?? '?'}@${pkg.version}` : null;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/** 单包解析：先裸说明符（一次性），再根×候选文件。返回 {module, from} 或 null。 */
async function resolvePackage(pkg, root, tried) {
  if (!bareAttempted.has(pkg.spec)) {
    bareAttempted.add(pkg.spec);
    try {
      const mod = await import(pkg.spec);
      if (pkg.validate(mod)) return { module: mod, from: `bare:${pkg.spec}` };
      tried.push(`${pkg.spec}（裸导入缺 ${pkg.what}）`);
    } catch {
      tried.push(`${pkg.spec}（裸导入失败）`);
    }
  }
  if (!root) return null;
  for (const rel of pkg.files) {
    const file = join(root, pkg.dir, rel);
    try {
      if (!existsSync(file)) {
        tried.push(file);
        continue;
      }
      const mod = await loadFile(file);
      if (pkg.validate(mod)) return { module: mod, from: file };
      tried.push(`${file}（缺导出 ${pkg.what}）`);
    } catch {
      tried.push(`${file}（加载失败）`);
    }
  }
  return null;
}

/**
 * 解析宿主 LLM 栈。全部必需包在同一候选根解析齐才返回；否则抛可操作错误（列出尝试点）。
 * @returns {Promise<{ createProvider: Function, anthropicMessagesApi: Function,
 *                     PiAiAdapter: Function, resolveRetryPolicy?: Function, source: string }>}
 */
export async function resolveHostLlmModules() {
  const tried = [];
  for (const root of moduleRootCandidates()) {
    const results = {};
    let ok = true;
    for (const pkg of REQUIRED) {
      const hit = await resolvePackage(pkg, root, tried);
      if (!hit) {
        ok = false;
        break;
      }
      results[pkg.key] = hit;
    }
    if (!ok) continue;
    const mods = {
      createProvider: results.piAi.module.createProvider,
      anthropicMessagesApi: results.piAiAnthropic.module.anthropicMessagesApi,
      PiAiAdapter: results.piAiAdapter.module.PiAiAdapter,
      source: results.piAi.from,
      /* DE-04：带上宿主包版本供启动日志输出。
       * 本插件与 C4/C5 的耦合是"照 trae 抄来的偶然事实"（PiAiAdapter options 形状、
       * profile 字段读取点），行号随宿主版本漂移——上游升级时日志首行就能对照出问题，
       * 否则只能重走一遍逆向。 */
      versions: {
        piAi: readPackageVersionNear(results.piAi.from),
        piAiAdapter: readPackageVersionNear(results.piAiAdapter.from),
      },
    };
    for (const pkg of OPTIONAL) {
      const hit = await resolvePackage(pkg, root, tried);
      if (!hit) continue;
      if (pkg.key === 'dshLlm') {
        mods.resolveRetryPolicy = hit.module.resolveRetryPolicy;
        /* app-server 通道要把适配器挂到宿主的 LlmAdapter 基类上（DSH 的 registerAdapter
         * 契约是 `LlmAdapter` 子类实例）。同一包顺带取走，避免第二次解析。 */
        if (typeof hit.module.LlmAdapter === 'function') mods.LlmAdapter = hit.module.LlmAdapter;
        if (typeof hit.module.LlmError === 'function') mods.LlmError = hit.module.LlmError;
        mods.versions.dshLlm = readPackageVersionNear(hit.from);
      }
      if (pkg.key === 'schemastery') mods.schemastery = hit.module.default ?? hit.module;
    }
    /* dshLlm 是 OPTIONAL 条目：上面只在本候选根解析到它时才带走 LlmAdapter。
     * app-server 通道**硬依赖** LlmAdapter，故再兜一圈其余候选根 —— 否则会出现
     * "LLM 栈在这个根、dsh-llm 在另一个根"的部署上静默没有 app-server 通道。 */
    if (mods.LlmAdapter === undefined) {
      const pkg = OPTIONAL.find((p) => p.key === 'dshLlm');
      for (const otherRoot of moduleRootCandidates()) {
        if (otherRoot === root) continue;
        const hit = await resolvePackage(pkg, otherRoot, tried);
        if (hit && typeof hit.module.LlmAdapter === 'function') {
          mods.LlmAdapter = hit.module.LlmAdapter;
          if (typeof hit.module.LlmError === 'function') mods.LlmError = hit.module.LlmError;
          mods.versions.dshLlm = readPackageVersionNear(hit.from);
          break;
        }
      }
    }
    return mods;
  }
  throw new Error(
    'dsh-connect-zcode：宿主内找不到 pi-ai LLM 栈（createProvider / anthropicMessagesApi / PiAiAdapter）。' +
      '尝试过：' +
      tried.slice(-24).join('；') +
      '。可用环境变量 ZCODE_CONNECT_MODULES_ROOT 指向包含这些包的 node_modules 根后重启 DSH。'
  );
}

/**
 * 单独解析 schemastery（供 Config schema 在**模块加载期**使用；apply() 尚未运行）。
 * 拿不到返回 null，调用方降级为手写 schema —— 但注意降级会让面板写入被 DSH 门禁静默拒绝
 * （见 OPTIONAL 中 schemastery 条目注释），因此这里失败要留下可诊断线索。
 * @returns {Promise<object|null>}
 */
export async function resolveSchemastery() {
  const tried = [];
  const pkg = OPTIONAL.find((p) => p.key === 'schemastery');
  for (const root of moduleRootCandidates()) {
    const hit = await resolvePackage(pkg, root, tried);
    if (hit) return hit.module.default ?? hit.module;
  }
  /* R-08：失败时必须把 tried 带出去。原先直接 return null，tried 整个丢弃 ——
   * 而 schemastery 降级正是本项目**危害最大的降级链**（手写 schema 无 volatile 标记 →
   * DSH 写入门禁静默拒绝面板保存 → 更甚者判 !isNativeConfigSchema → 插件整体不激活）。
   * 它的诊断线索反而比 LLM 栈失败（host-modules:178-183 会列 tried.slice(-24)）少一档：
   * 用户无法区分"宿主真没这个包"与"路径候选推导错了"。 */
  const err = new Error(tried.length > 0 ? `尝试过：${tried.slice(-24).join('；')}` : '无可用候选根（resourcesPath/env 均未命中）');
  err.tried = tried;
  throw err;
}
