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
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
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
    };
    const optionalHit = await resolvePackage(OPTIONAL[0], root, tried);
    if (optionalHit) mods.resolveRetryPolicy = optionalHit.module.resolveRetryPolicy;
    return mods;
  }
  throw new Error(
    'dsh-connect-zcode：宿主内找不到 pi-ai LLM 栈（createProvider / anthropicMessagesApi / PiAiAdapter）。' +
      '尝试过：' +
      tried.slice(-24).join('；') +
      '。可用环境变量 ZCODE_CONNECT_MODULES_ROOT 指向包含这些包的 node_modules 根后重启 DSH。'
  );
}
