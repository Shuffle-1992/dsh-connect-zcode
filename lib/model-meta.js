/**
 * model-meta.js —— 模型目录元数据层（T22）。
 *
 * 权威事实（T22 任务包 §0，Lead 2026-10-01 实测）：
 * - 网关 GET /v1/models 只给 {id, display_name, type, created_at}，**零能力元数据**；
 *   bigmodel 标准 API 同样零元数据 ⇒ 元数据唯一权威来源 = ZCode config.json 的
 *   provider[planKey].models 段（ZCode 官方写入，与 GUI 同源）。
 * - 该段目前只有 2 个模型：GLM-5.3 与 GLM-5.3-Flash（key 大小写与网关 id 不同，
 *   匹配一律大小写不敏感），元数据含 limit.context=1000000 / limit.output=128000 /
 *   reasoning.variants=["low","max","high"] / modalities.input（Flash 含 image,video）。
 *
 * 语义（任务包 §0.4 / §1.1 / §1.2）：
 * - 5.3 系过滤：显式集合 {glm-5.3, glm-5.3-flash, glm-5.3-flashx}，大小写不敏感；
 *   不用模糊前缀（防未来网关多出 glm-5.3-pro 被误放行）。
 * - 每模型默认 200K，用户可勾 1M；**仅有官方 context=1M 的模型**才出现 1M 选项
 *   （applyContextBudgets 只切到官方声明的 Max 档——trae :246-251 同语义）。
 * - 有官方数据的模型：推理档与输入模态**锁定**（只展示不可改）；无官方数据的模型：
 *   推理/图片由用户开关自担（默认关）。
 * - 本模块只读 config.json 的 models 段，**不读不打印 options.apiKey**（零明文红线）；
 *   任何读不到/异常 → 空对象/原样回退，绝不抛。
 */
import { readFileSync } from 'node:fs';
import { defaultCredentialPath, DEFAULT_PLAN_KEY } from './credential.js';

/** 5.3 系显式集合（T22 §1.1-3：小写；匹配时对 id 做 toLowerCase 再查）。 */
export const GLM53_FAMILY = ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'];

/** 基础上下文窗口（用户语义「默认是 200K」；CLI 实测有效窗口亦为 200k，T19 §4）。 */
export const BASE_CONTEXT_WINDOW = 200000;

/** id 是否属于 5.3 系（大小写不敏感）。 */
export function isGlm53Family(id) {
  return typeof id === 'string' && GLM53_FAMILY.includes(id.toLowerCase());
}

/** 目录行按 5.3 系显式集合过滤（非数组输入 → 空数组，防御）。 */
export function filterGlm53Family(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => isGlm53Family(row?.id));
}

/**
 * 读 ZCode config.json 的 provider[planKey].models 段并归一（T22 §1.1-1）。
 * 输出形状：{ "<小写模型id>": { context, output, reasoningVariants, defaultVariant, input } }。
 * 读不到 / 非法 JSON / 段缺失 / 条目缺正整数 context → 跳过该条；整体异常 → {}。
 * 红线：只碰 models 段，不读 options（apiKey 永不进入本模块的任何返回值/错误消息）。
 * @param {string} [configPath] 显式路径；空/缺省 = ~/.zcode/v2/config.json。
 * @param {string} [planKey] 套餐条目键；缺省 builtin:bigmodel-coding-plan。
 */
export function readOfficialMeta(configPath, planKey = DEFAULT_PLAN_KEY) {
  try {
    const path = typeof configPath === 'string' && configPath !== '' ? configPath : defaultCredentialPath();
    const models = JSON.parse(readFileSync(path, 'utf8'))?.provider?.[planKey]?.models;
    if (models === null || typeof models !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(models)) {
      if (typeof key !== 'string' || key === '' || value === null || typeof value !== 'object') continue;
      const context = value?.limit?.context;
      // 缺正整数 context 的条目不收编：宁按「无官方数据」处理，不虚构数字。
      if (!Number.isInteger(context) || context <= 0) continue;
      const variants = Array.isArray(value?.reasoning?.variants)
        ? value.reasoning.variants.filter((v) => typeof v === 'string' && v !== '')
        : [];
      const input = Array.isArray(value?.modalities?.input)
        ? value.modalities.input.filter((m) => typeof m === 'string' && m !== '')
        : [];
      out[key.toLowerCase()] = {
        context,
        output: Number.isInteger(value?.limit?.output) && value.limit.output > 0 ? value.limit.output : null,
        reasoningVariants: variants,
        defaultVariant: typeof value?.reasoning?.defaultVariant === 'string' ? value.reasoning.defaultVariant : null,
        input,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * trae :233 同款枚举映射（逐字符同语义）：low→light，xhigh→extra_high，**其余一律→high**。
 * ZCode 官方档位 "max" 不在 trae 显式枚举表，落入 else 臂 → "high"（T22 §1.3 决策：
 * 选 max→high 而非 max→xhigh，因为这是 trae 自身代码对未知档位的既有处置，
 * 不发明新映射；"high" 是 5.3 系已实证的 wire 枚举值）。
 */
export function effortEnumName(effort) {
  return effort === 'low' ? 'light' : effort === 'xhigh' ? 'extra_high' : 'high';
}

/**
 * 合并网关目录 × 官方元数据 → 目录事实行（T22 §1.1-2）。
 * - name ← 网关 display_name（缺失回退 row.name / id）；
 * - 官方命中（大小写不敏感）：maxContextWindow=官方 context（仅当高于基础窗口，
 *   即「官方 Max 档」，1M 选项的判定来源）；input=官方 modalities（锁定，含 image/video
 *   原样保留——官方声明零虚构）；推理档=官方 variants 经 effortEnumName 映射（锁定）；
 * - 未命中：基础窗口 + input ['text']，official:false（推理/图片交给用户开关）。
 * 每行必有正整数 contextWindow（INVALID_MODEL_CONTEXT 红线；toPiModel 还有最终钳制）。
 * @param {readonly {id: string, display_name?: string, name?: string}[]} gatewayModels
 * @param {Record<string, {context:number, output:number|null, reasoningVariants:string[], defaultVariant:string|null, input:string[]}>} [officialMeta]
 * @param {number} [baseContextWindow] 基础窗口（config，默认 200k）。
 */
export function buildCatalog(gatewayModels, officialMeta = {}, baseContextWindow = BASE_CONTEXT_WINDOW) {
  const meta = officialMeta !== null && typeof officialMeta === 'object' ? officialMeta : {};
  const base = Number.isInteger(baseContextWindow) && baseContextWindow > 0 ? baseContextWindow : BASE_CONTEXT_WINDOW;
  return (Array.isArray(gatewayModels) ? gatewayModels : [])
    .filter((row) => typeof row?.id === 'string' && row.id !== '')
    .map((row) => {
      const name =
        typeof row.display_name === 'string' && row.display_name !== ''
          ? row.display_name
          : typeof row.name === 'string' && row.name !== ''
            ? row.name
            : row.id;
      const hit = meta[row.id.toLowerCase()];
      if (!hit) {
        return { id: row.id, name, contextWindow: base, maxTokens: 128000, input: ['text'], official: false };
      }
      const maxContextWindow = hit.context > base ? hit.context : undefined;
      const efforts =
        hit.reasoningVariants.length > 0
          ? Object.fromEntries(hit.reasoningVariants.map((variant) => [variant, effortEnumName(variant)]))
          : undefined;
      return {
        id: row.id,
        name,
        contextWindow: base,
        ...(maxContextWindow !== undefined ? { maxContextWindow } : {}),
        maxTokens: hit.output ?? 128000,
        input: hit.input.length > 0 ? hit.input : ['text'],
        official: true,
        ...(efforts !== undefined ? { reasoningEfforts: efforts } : {}),
      };
    });
}

/** Record 入参防御（非对象 → {}）。 */
function recordOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 图片开关（trae applyImageSelection 同名同位，T22 扩展：官方行跳过——
 * 官方数据锁定 input，图片能力以官方 modalities 为准，用户不可加也不可减）。
 * 非官方行：overrides[id].image === true → 并入 'image'；否则剥离 'image'（默认无图）。
 */
export function applyImageSelection(catalog, overrides = {}) {
  const selected = recordOf(overrides);
  return (Array.isArray(catalog) ? catalog : []).map((model) => {
    if (model?.official) return model;
    const want = selected[model?.id]?.image === true;
    const input = Array.isArray(model?.input) ? model.input : ['text'];
    const has = input.includes('image');
    if (want === has) return model;
    return { ...model, input: want ? [...input, 'image'] : input.filter((m) => m !== 'image') };
  });
}

/**
 * 推理开关（非官方行专用；官方行推理档锁定，跳过）。
 * overrides[id].reasoning === true → 附 reasoningEfforts（用户自担，档位取 5.3 系
 * 已实证的 wire 枚举 "high" 单档——thinkingLevelMap 只在 DSH 'high' 档下发 effort，
 * 其余档位 null 不发，宁缺勿滥）；关闭/缺省 → 无 reasoningEfforts（推理关闭，默认态）。
 */
export function applyReasoningSelection(catalog, overrides = {}) {
  const selected = recordOf(overrides);
  return (Array.isArray(catalog) ? catalog : []).map((model) => {
    if (model?.official) return model;
    const on = selected[model?.id]?.reasoning === true;
    const has = model?.reasoningEfforts !== undefined;
    if (on === has) return model;
    if (on) return { ...model, reasoningEfforts: { high: 'high' } };
    const next = { ...model };
    delete next.reasoningEfforts;
    return next;
  });
}

/**
 * 上下文预算（trae :246-251 同语义照抄）：**只允许切到该模型官方声明的 Max 档**——
 * budgets[id] === maxContextWindow 时 contextWindow 才换成官方 Max 值；无官方 Max 档的
 * 模型（含 FlashX）无论写什么值都不生效（1M 选项根本不出现，用户无路径写入）。
 * 实测差异注意：ZCode config 官方声明 limit.context=1000000，但 CLI 实测有效窗口 200k、
 * 压缩发生在 200k 附近（T18/PROTOCOL §5.2）——照官方值上，README 已注明差异。
 */
export function applyContextBudgets(catalog, budgets = {}) {
  const applied = recordOf(budgets);
  return (Array.isArray(catalog) ? catalog : []).map((model) => ({
    ...model,
    ...(model?.maxContextWindow !== undefined && applied[model?.id] === model.maxContextWindow
      ? { contextWindow: model.maxContextWindow }
      : {}),
  }));
}
