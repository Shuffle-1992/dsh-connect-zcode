/**
 * session-workspace.js —— app-server 会话「工作目录」的解析策略（ZB-42）。
 *
 * **为什么单独成模块**：这段逻辑原先散落在两处 —— `index.js` 的闭包负责"软取宿主服务"，
 * 而 `lib/app-server.js` 的 `_resolveSessionWorkspace()` 又自己抄了一份"配置 vs 跟随"的优先级。
 * 两份实现意味着"到底用了哪个目录"难以推理，改一处忘一处就会出现静默漂移。
 *
 * 现在边界清楚：
 *   - **优先级只此一份**：`pickWorkspace()`（纯函数，可直接单测，不碰宿主服务）；
 *   - **宿主服务访问只此一份**：`createWorkspaceResolver()`（软取 `agents` + `workingDirectory`）；
 *   - 适配器（`lib/app-server.js`）只消费"注入进来的 resolver"和这个纯函数，不认识宿主服务。
 *
 * 依赖方向：`index.js`（宿主侧）→ 本模块；`lib/app-server.js` → 本模块（仅纯函数）。
 * 本模块**不认识 Cordis 上下文**（`getService` 由调用方注入），因此可离线测试。
 */
import { homedir, platform } from 'node:os';
import { normalize, resolve } from 'node:path';

/**
 * 路径归一（ZB-43）：目录比较与 `session/create` 下发**都必须先归一**。
 * 理由：DSH 的 `workingDirectory.set()` 返回 `processPath()` 规范化值，而成功路径上的
 * `ensure()` 返回的是"已提交的 cwd"原值；首值来自 `defaultDirectory`、后续可能来自
 * 不同来源 ⇒ `C:\a` / `c:\A\\` / 尾斜杠差异会被裸 `!==` 当成"目录变更"而**白白重建会话**。
 * Windows 下统一小写（路径大小写不敏感）。
 * @param {unknown} input
 * @returns {string} 归一后的绝对路径；输入为空返回 `''`
 */
export function normalizeWorkspacePath(input) {
  if (typeof input !== 'string' || input.trim() === '') return '';
  const unified = normalize(resolve(input));
  return platform() === 'win32' ? unified.toLowerCase() : unified;
}

/** 工作目录来源（用于日志/状态文档，别用裸字符串字面量散在各处）。 */
export const WORKSPACE_SOURCE = Object.freeze({
  SESSION: 'session', // 跟随当前会话的官方工作目录
  CONFIG_PINNED: 'config-pinned', // appServerWorkspaceFollow=false，用配置值
  FALLBACK: 'fallback', // 解析不到 ⇒ 配置值/用户主目录
});

/**
 * 纯函数：按优先级选出本次要用的工作目录。
 * 优先级：① `follow === false` ⇒ 配置值（用户钉死）；② 解析值可用 ⇒ 解析值；③ 回落配置值。
 * @param {{ follow?: boolean, configured?: string, resolved?: string }} input
 * @returns {{ path: string, source: string, followIntent: boolean }}
 */
export function pickWorkspace({ follow = true, configured = '', resolved } = {}) {
  const pinned = !(follow !== false); // follow === false 即钉死
  /* 两侧都归一后再比较/下发，避免"大小写或尾斜杠差异"被当成目录变更（见 normalizeWorkspacePath）。 */
  const configuredText = normalizeWorkspacePath(configured);
  const fallbackPath = configuredText !== '' ? configuredText : normalizeWorkspacePath(homedir());
  if (pinned) return { path: fallbackPath, source: WORKSPACE_SOURCE.CONFIG_PINNED, followIntent: false };
  const resolvedText = normalizeWorkspacePath(resolved);
  if (resolvedText === '') return { path: fallbackPath, source: WORKSPACE_SOURCE.FALLBACK, followIntent: true };
  return { path: resolvedText, source: WORKSPACE_SOURCE.SESSION, followIntent: true };
}

/**
 * 生成"当前会话工作目录"解析器（软取宿主服务）。
 * 与 `index.js` 既有的 `resolveAttachments: () => ctx.get('attachments')` 同款策略：
 * **软取**（`getService` 缺席/服务未挂载 ⇒ 返回 undefined），绝不硬 inject ——
 * 否则缺该服务的 profile 会整体不激活。
 * @param {{ getService: (name: string) => any, logger?: any, onResolve?: (info: object) => void }} deps
 * @returns {(sessionId: string) => Promise<string | undefined>}
 */
export function createWorkspaceResolver({ getService, logger, onResolve } = {}) {
  return async function resolveWorkspace(sessionId) {
    const emit = (info) => {
      try {
        onResolve?.(info);
      } catch {
        /* 观测留痕不能影响解析本身 */
      }
    };
    try {
      const agents = typeof getService === 'function' ? getService('agents') : undefined;
      const workingDirectory = typeof getService === 'function' ? getService('workingDirectory') : undefined;
      const agent = agents?.get?.(sessionId);
      if (agent === undefined) {
        emit({ sessionId, path: undefined, reason: 'no-agent' });
        return undefined;
      }
      const resolved =
        typeof workingDirectory?.ensure === 'function'
          ? await workingDirectory.ensure(agent)
          : typeof workingDirectory?.get === 'function' && agent.session !== undefined
            ? workingDirectory.get(agent.session)
            : undefined;
      emit({ sessionId, path: typeof resolved === 'string' ? resolved : undefined, reason: resolved === undefined ? 'no-service' : 'ok' });
      return typeof resolved === 'string' && resolved.trim() !== '' ? resolved : undefined;
    } catch (error) {
      logger?.warn?.(`[dsh-connect-zcode] 读取会话工作目录失败（回落配置目录）：${error?.message ?? error}`);
      emit({ sessionId, path: undefined, reason: 'error', error: String(error?.message ?? error) });
      return undefined;
    }
  };
}

/**
 * 解析结果留痕（供状态文档/日志/测试观察"到底有没有跟随"）。
 * 只保留最近一次与累计次数，**不缓存目录内容**、不含任何凭据。
 */
export function createWorkspaceTracker() {
  let state = { lastSessionId: null, lastPath: null, lastSource: null, lastReason: null, lastAt: null, sessionResolutions: 0, fallbacks: 0 };
  return {
    update(info = {}) {
      state = {
        lastSessionId: typeof info.sessionId === 'string' ? info.sessionId : state.lastSessionId,
        lastPath: typeof info.path === 'string' ? info.path : null,
        lastSource: typeof info.source === 'string' ? info.source : state.lastSource,
        lastReason: typeof info.reason === 'string' ? info.reason : state.lastReason,
        lastAt: new Date().toISOString(),
        sessionResolutions: state.sessionResolutions + (info.source === WORKSPACE_SOURCE.SESSION ? 1 : 0),
        fallbacks: state.fallbacks + (info.source !== undefined && info.source !== WORKSPACE_SOURCE.SESSION ? 1 : 0),
      };
    },
    snapshot() {
      return { ...state };
    },
  };
}
