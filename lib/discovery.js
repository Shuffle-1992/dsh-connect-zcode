/**
 * discovery.js —— 模型目录：动态发现（GET {baseURL}/v1/models，x-api-key 单头）优先，
 * 失败回退静态表（T19 §2 实测 11 模型，T22 起按 5.3 系过滤为 3 个）。
 *
 * 纪律：
 * - 开关关闭（PROTOCOL §7.1）时**不发任何网络请求**，直接回静态表；
 * - 发现结果不落盘（模型目录不是凭据）；每行必带正整数 contextWindow（缺即
 *   INVALID_MODEL_CONTEXT、整 provider 瘫痪——trae :33-39 注释实证）；
 * - T22：网关只给 {id, display_name}（零能力元数据）⇒ 元数据一律由 lib/model-meta.js
 *   的 buildCatalog 从 ZCode config.json 官方 models 段合并；目录先按 5.3 系
 *   显式集合过滤（用户需求：只显示 5.3 / 5.3-flash / 5.3-flashx）。
 */
import { GLM53_FAMILY, filterGlm53Family, buildCatalog } from './model-meta.js';

/**
 * 静态回退目录（T22 裁剪：5.3 系显式集合 3 项；GLM53_FAMILY 的同值副本。
 * 网关 11 个 id 中其余 8 个（glm-5.2/5.1/5/5-turbo/4.7/4.6/4.5/4.5-air）按用户需求不再暴露）。
 */
export const STATIC_MODEL_IDS = [...GLM53_FAMILY];

/**
 * 静态表的中文/展示名（= 网关 `display_name` 的实测值，T19 探测回填；非虚构）。
 * 为什么要写死：`state.lastCatalog` 初始化为静态表，而**动态发现是懒加载**的
 * （首次拉目录才更新）——若静态表只有 id，面板在首次发现前会显示 `glm-5.3`
 * 而非 `GLM-5.3`。网关对这三个 id 的 display_name 是稳定公开事实，写死无虚构风险。
 */
export const STATIC_MODEL_NAMES = {
  'glm-5.3': 'GLM-5.3',
  'glm-5.3-flash': 'GLM-5.3-Flash',
  'glm-5.3-flashx': 'GLM-5.3-FlashX',
};

/**
 * 静态目录事实行（发现回退与目录注册共用；official 标记/官方 Max 档/推理档随
 * officialMeta 命中情况带出，未命中即按「无官方数据」处理）。
 * @param {Record<string, unknown>} [officialMeta] readOfficialMeta 的归一产物。
 * @param {number} [baseContextWindow] 基础窗口（config，默认 200k）。
 */
export function staticCatalog(officialMeta, baseContextWindow) {
  return buildCatalog(
    STATIC_MODEL_IDS.map((id) => ({ id, name: STATIC_MODEL_NAMES[id] ?? id })),
    officialMeta,
    baseContextWindow
  );
}

/**
 * 按面板勾选过滤模型目录（T21 §3.1 语义，与 trae deriveCatalog :290-292 一致）：
 * `enabledModelIds` 空（未配置或 []）= **全部显示**——没配过的人必须照常看到全部模型，
 * 不能因为新加的字段而突然一个模型都没有；非空 = 只保留列出的 id。
 * 不在目录里的 id 静默忽略（勾选列表与实际目录可能短暂不一致，如动态目录刚变化）。
 * @template T
 * @param {readonly T[]} rows 目录行（元素需带 id 字段）。
 * @param {readonly string[]} enabledIds 面板勾选；空数组 = 不过滤。
 * @returns {T[]}
 */
export function filterByEnabledModels(rows, enabledIds) {
  if (!Array.isArray(enabledIds) || enabledIds.length === 0) return [...rows];
  const wanted = new Set(enabledIds);
  return rows.filter((row) => wanted.has(row?.id));
}

/**
 * 从 /v1/models 响应体提取模型行 {id, name}（T22：新增 display_name 提取；
 * 兼容 data[]/models[]/字符串数组三种形态）。name = display_name，缺失回退 id。
 */
export function extractModels(body) {
  const list = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : [];
  return list
    .map((item) => {
      if (typeof item === 'string') return item !== '' ? { id: item, name: item } : null;
      if (typeof item?.id === 'string' && item.id !== '') {
        return {
          id: item.id,
          name: typeof item.display_name === 'string' && item.display_name !== '' ? item.display_name : item.id,
        };
      }
      return null;
    })
    .filter((row) => row !== null);
}

/** 从 /v1/models 响应体提取模型 id（T21 兼容形状，= extractModels().map(id)）。 */
export function extractModelIds(body) {
  return extractModels(body).map((row) => row.id);
}

/**
 * 发现回调主体：拉网关目录 → 5.3 系过滤 → 合并官方元数据 → 目录事实行。
 * 任何失败（含凭据缺失、开关读取异常）都回退静态表——发现是尽力而为，
 * 不让目录注册路径抛错。**本函数不发元数据请求**（网关没有元数据可发）。
 * @param {{ baseURL: string, apiKey: string }} credential
 * @param {{ officialMeta?: Record<string, unknown>, baseContextWindow?: number, fetchFn?: Function, signal?: AbortSignal }} [io]
 *        注入 officialMeta（index.js 现读 ZCode config）与 fetch（自检用）。
 * @returns {Promise<readonly object[]>} 目录事实行（official/maxContextWindow/reasoningEfforts 随命中带出）。
 */
export async function discoverModels(credential, io = {}) {
  const fallback = () => staticCatalog(io.officialMeta, io.baseContextWindow);
  try {
    const fetchFn = io.fetchFn ?? fetch;
    if (typeof fetchFn !== 'function') return fallback();
    const url = `${credential.baseURL.replace(/\/+$/, '')}/v1/models`;
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        // T19 §2 实测：x-api-key 单头充分（GET /v1/models 与 POST /v1/messages 均 200），
        // 与 pi-ai anthropicMessagesApi 默认 X-Api-Key 天然匹配，无需补 Authorization。
        'x-api-key': credential.apiKey,
        'anthropic-version': '2023-06-01',
      },
      ...(io.signal === undefined ? {} : { signal: io.signal }),
    });
    if (!res.ok) return fallback();
    const rows = filterGlm53Family(extractModels(await res.json()));
    if (rows.length === 0) return fallback();
    return buildCatalog(rows, io.officialMeta, io.baseContextWindow);
  } catch {
    return fallback();
  }
}
