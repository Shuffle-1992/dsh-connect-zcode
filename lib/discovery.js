/**
 * discovery.js —— 模型目录：动态发现（GET {baseURL}/v1/models，x-api-key 单头）优先，
 * 失败回退静态表（T19 §2 实测 11 模型）。
 *
 * 纪律：
 * - 开关关闭（PROTOCOL §7.1）时**不发任何网络请求**，直接回静态表；
 * - 发现结果不落盘（模型目录不是凭据）；每行必带正整数 contextWindow（缺即
 *   INVALID_MODEL_CONTEXT、整 provider 瘫痪——trae :33-39 注释实证）；
 * - contextWindow 一律用保守值（config，默认 200k）：CLI 实测有效窗口 200k，
 *   config 名义 1M 不采信（T19 §4）。
 */

/** 静态回退目录（T19 探测回填：GET /v1/models 200，11 个 id，2026-10-01 实测）。 */
export const STATIC_MODEL_IDS = [
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.3-flashx',
  'glm-5.2',
  'glm-5.1',
  'glm-5',
  'glm-5-turbo',
  'glm-4.7',
  'glm-4.6',
  'glm-4.5',
  'glm-4.5-air',
];

/** 静态目录行（LlmDiscoveredModel 形状；发现回调与目录注册共用）。 */
export function staticDiscoveredModels(contextWindow) {
  return STATIC_MODEL_IDS.map((id) => ({
    id,
    name: id,
    contextWindow,
    maxTokens: 128000,
  }));
}

/** 从 /v1/models 响应体提取模型 id（兼容 data[]/models[]/字符串数组三种形态）。 */
export function extractModelIds(body) {
  const list = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : [];
  return list
    .map((item) => (typeof item === 'string' ? item : typeof item?.id === 'string' ? item.id : null))
    .filter((id) => typeof id === 'string' && id.length > 0);
}

/**
 * 发现回调主体。任何失败（含凭据缺失、开关读取异常）都回退静态表——发现是尽力而为，
 * 不让目录注册路径抛错。
 * @param {{ baseURL: string, apiKey: string }} credential
 * @param {number} contextWindow 保守窗口（config，默认 200k）。
 * @param {{ fetchFn?: Function, signal?: AbortSignal }} [io] 注入 fetch（自检用）。
 * @returns {Promise<readonly {id:string,name:string,contextWindow:number,maxTokens:number}[]>}
 */
export async function discoverModels(credential, contextWindow, io = {}) {
  const fallback = () => staticDiscoveredModels(contextWindow);
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
    const ids = extractModelIds(await res.json());
    if (ids.length === 0) return fallback();
    return ids.map((id) => ({ id, name: id, contextWindow, maxTokens: 128000 }));
  } catch {
    return fallback();
  }
}
