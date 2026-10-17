/**
 * gift-catalog.js —— 赠送额度（Start Plan）通道的**目录行口径**（ZB-46 / 审查 2.2）。
 *
 * **为什么需要它**：同一套"模型 id 归一 + 用户预算覆盖 + 兜底值"原先在**三处**各写一遍：
 *   ① 发现回调行（`index.js#giftDiscoveryRows`，宿主据此给模型声明 image 能力）；
 *   ② 面板状态文档行（`index.js` 的 status 路由，面板据此渲染 200K/1M 单选）；
 *   ③ 适配器目录（`lib/app-server.js#_catalog`，真正决定 setModel 与上下文口径）。
 * 三处里任何一处改口径，都会让"面板显示 / 宿主看到 / 实际发送"三者**静默漂移**。
 *
 * **边界（刻意不合并的部分）**：三处的**差异**字段仍留在调用点 ——
 *   发现行要 `inputModalities`、状态行要 `has1m/reasoningVariants`、适配器要 `reasoningLevels`。
 * 这些本来就不同，硬合并会制造新的耦合；这里只统一**共同的那部分**。
 *
 * 纯函数、零宿主依赖 ⇒ 可离线断言（见 `test/selfcheck.mjs` 的 2.2 断言组）。
 */

import { BASE_CONTEXT_WINDOW, FALLBACK_MAX_TOKENS } from './model-meta.js';

/** 赠送通道模型的基础上下文窗口（**复用 `model-meta` 的单一来源**，不另写字面量）。 */
export const GIFT_DEFAULT_CONTEXT = BASE_CONTEXT_WINDOW;
/** 上下文预算上限（面板 1M 档；超过即夹断）。 */
export const GIFT_MAX_CONTEXT = 1000000;
/** `maxTokens` 兜底（同样复用 `model-meta`）。 */
export const GIFT_DEFAULT_MAX_TOKENS = FALLBACK_MAX_TOKENS;

/**
 * 归一模型 id 列表：只保留**内置目录里真实存在**的 id（避免 setModel 失败）、去重，
 * 空/全无效时回落到目录首条。
 * @param {unknown} rawList 配置里的模型 id 列表
 * @param {readonly {id: string}[]} catalog 内置目录
 * @returns {string[]}
 */
export function normalizeGiftModelIds(rawList, catalog) {
  const list = Array.isArray(rawList) ? rawList : [];
  const entries = Array.isArray(catalog) ? catalog : [];
  const known = new Set(entries.map((m) => m?.id).filter((id) => typeof id === 'string'));
  const ids = [...new Set(list.filter((id) => typeof id === 'string' && known.has(id)))];
  if (ids.length > 0) return ids;
  const first = entries[0]?.id;
  return typeof first === 'string' ? [first] : [];
}

/**
 * 算模型行的**上下文窗口**（唯一口径）：预算覆盖优先（截断 + 夹上限），否则官方值，再否则兜底。
 * @param {{contextWindow?: number} | undefined} entry 官方目录条目
 * @param {unknown} override 用户预算（面板写入的 `contextBudgets[id]`）
 * @param {{ max?: number, fallback?: number }} [options] 上限与兜底（默认 1M / 200k）
 * @returns {number}
 */
export function giftContextWindow(entry, override, options = {}) {
  const max = Number.isFinite(options.max) && options.max > 0 ? options.max : GIFT_MAX_CONTEXT;
  const fallback = Number.isInteger(options.fallback) && options.fallback > 0 ? options.fallback : GIFT_DEFAULT_CONTEXT;
  const value = Number(override);
  if (Number.isFinite(value) && value > 0) return Math.min(Math.trunc(value), max);
  const base = Number(entry?.contextWindow);
  return Number.isInteger(base) && base > 0 ? base : fallback;
}

/**
 * 算模型行的 `maxTokens`（唯一口径）：官方值优先，否则兜底。
 * @param {{maxTokens?: number} | undefined} entry
 * @returns {number}
 */
export function giftMaxTokens(entry) {
  const value = Number(entry?.maxTokens);
  return Number.isInteger(value) && value > 0 ? value : GIFT_DEFAULT_MAX_TOKENS;
}
