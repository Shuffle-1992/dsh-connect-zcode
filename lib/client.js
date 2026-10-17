window.__ModuleLoader__.load({
	id: "dsh-connect-zcode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * dsh-connect-zcode client 半（T21 面板 + T22 模型元数据行控件）。
		 *
		 * 结构完全照 dsh-connect-trae lib/client.js 的信封与卡注册（不发明 API）：
		 * - ModuleLoader 信封（自足 bundle，无构建步骤；唯一外部 require 是宿主提供的 react，
		 *   与 trae 同款；组件用 React.createElement 手写，不引 JSX/构建链）；
		 * - 卡注册 plugins.bundle.config，key = bundle 包名（slot 契约，Lead 从 Cordis Inspect 取证）；
		 * - 设置读写走 configForms 软探测 + 命名空间重绑定（trae :1417-1486 同款），
		 *   写后必须回读校验（trae :300 教训：set() resolve ≠ 真存进去了）；
		 * - 只读状态（冻结态/台账/目录+能力事实）经 host 半回环路由 GET（方案 B）；
		 * - apply() 整体 try/catch，失败只 console.error，绝不抛（trae :1504-1506 同款）。
		 *
		 * T22 行布局（对标 trae 行控件）：每行 = 显隐勾选 + 名称 + ·官方徽标 + 图片开关
		 * （官方行锁定）+ 200K/1M 单选（仅官方 Max 档模型出现 1M）+ 推理档展示（官方锁定）
		 * 或推理开关（无官方数据，默认关）。锁定的推理档/图片不可交互（disabled）。
		 *
		 * 文案：面板内文案为中文常量（最小面板不做 i18n；trae 的 locale 服务刻意不依赖，
		 * 少一个服务就少一分启动失败面）。
		 */
		let react = require("react");
		const el = react.createElement;

		//#region 常量与纯 helpers（跨半不能 import，与 lib/*.js 是同值副本）
		/** host 半 lib/web-status.js ZCODE_STATUS_PATH 的同值副本（改动需两处同步）。 */
		const STATUS_PATH = "/plugins/dsh-connect-zcode/status";
		/** 卡片 key = bundle 包名（plugins.bundle.config slot 契约）。 */
		const BUNDLE_KEY = "dsh-connect-zcode";
		/**
		 * 赠送额度通道的 provider id（host 半 `lib/app-server.js` APPSERVER_PROVIDER_ID 的同值副本；
		 * 自检里有跨半一致性断言守着）。**输入框进度条只在选中这条 provider 的模型时显示** ——
		 * 它烧的是 Start Plan 赠送额度，与 Coding Plan 那条 5.3 Flash 是两笔账。
		 */
		const QUOTA_PROVIDER_ID = "zcode-appserver";
		const NS_EXACT = "zcode-connect";
		/** 设置命名空间匹配（host 的 settingsNs = Loader entry id = cordis.patch.yml 的 id）。 */
		const NS_PATTERN = /zcode/i;
		/**
		 * 官方 Max 档上下文值（lib/model-meta.js：ZCode config 官方 limit.context=1000000 的
		 * 同值副本）。注意实测差异：CLI 实测有效窗口 200k、压缩发生在 200k 附近
		 * （T18/PROTOCOL §5.2）——1M 是官方声明值，README 已注明。
		 */
		const CONTEXT_1M = 1000000;
		/**
		 * 静态目录回退（lib/discovery.js STATIC_MODEL_IDS 同值副本，T22 起裁剪为 5.3 系 3 项）：
		 * 状态路由不可用时勾选列表至少能显示 5.3 系；回退行不带能力事实
		 * （无徽标/无 1M 选项，图片与推理按无官方数据开关处理）。
		 */
		const STATIC_MODEL_IDS = ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"];
		/** 页面视图拉到的最近一次状态（summary 视图复用，避免每行各拉一次）。 */
		const STATUS_CACHE = { current: null };
		/**
		 * 剥 volatile 活引用（trae unwrapVolatileDeep 同款）：settings 里 volatile 字段以
		 * `{ get(): T }` 引用形态到达，直接当数组用会处处 undefined，spread 还会把函数漏进文档。
		 */
		function unwrapLive(value) {
			if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
			return value;
		}
		function unwrapLiveDeep(value) {
			if (value === null || typeof value !== "object") return value;
			if (typeof value.get === "function") return unwrapLiveDeep(value.get());
			if (Array.isArray(value)) return value.map((entry) => unwrapLiveDeep(entry));
			const source = value;
			const out = {};
			for (const key of Object.keys(source)) out[key] = unwrapLiveDeep(source[key]);
			return out;
		}
		/** 任意形状 → 去重后的合法 id 数组（空/缺失/形状不对 = [] = 全部显示）。 */
		function canonIds(value) {
			const raw = unwrapLive(value);
			if (!Array.isArray(raw)) return [];
			return [...new Set(raw.filter((id) => typeof id === "string" && id.length > 0))];
		}
		/** 任意形状 → {id: 正整数}（非法条目剥掉；语义有效性由 host applyContextBudgets 判定）。 */
		function canonBudgets(value) {
			const raw = unwrapLive(value);
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
			const out = {};
			for (const [id, budget] of Object.entries(raw)) {
				if (typeof id === "string" && id !== "" && Number.isInteger(budget) && budget > 0) out[id] = budget;
			}
			return out;
		}
		/** 任意形状 → {id: {仅显式 true 的开关}}（与 host modelOverridesOf 同一规范化）。 */
		function canonOverrides(value) {
			const raw = unwrapLive(value);
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
			const out = {};
			for (const [id, entry] of Object.entries(raw)) {
				if (typeof id !== "string" || id === "" || entry === null || typeof entry !== "object") continue;
				const item = {};
				if (entry?.reasoning === true) item.reasoning = true;
				if (entry?.image === true) item.image = true;
				if (Object.keys(item).length > 0) out[id] = item;
			}
			return out;
		}
		/**
		 * 写一个设置字段并回读校验（trae :297-320 同款纪律，T22 扩展到三个字段）：
		 * set() resolve 为 false = Host 拒绝；resolve 为 true 也不代表落盘，必须读回比对。
		 * @throws {Error} 未落盘时（文案可操作）。
		 */
		async function writeField(scope, field, value, canon) {
			if (!scope || typeof scope.set !== "function") throw new Error("设置服务不可用，面板处于只读状态。");
			if ((await scope.set(field, value)) === false) {
				throw new Error(`Host 拒绝写入 ${field}。常见原因：插件 config 未走 schemastery 主路径（缺 volatile 标记）或命名空间未就绪，可稍后重试或查看 DSH 日志。`);
			}
			const readBack = canon(unwrapLiveDeep(scope.getSnapshot().value)?.[field]);
			if (JSON.stringify(readBack) !== JSON.stringify(canon(value))) {
				throw new Error(`写入未被持久化（${field} 读回值与写入值不一致），界面即将回弹。请重试；若持续失败请查看 DSH 日志。`);
			}
		}
		//#endregion
		//#region 样式（一次性注入；纯色，无渐变）
		/* 主题 token 名以本机 Cordis Inspect（client Theme.listTokens）取到的**真实清单**为准：
		 *   --dsw-alias-label-primary / -label-secondary  （文本）
		 *   --dsw-alias-border-l1 / -border-l2            （描边）
		 *   --dsw-alias-bg-layer-1 / -layer-2 / -bg-overlay（面）
		 *   --dsw-alias-brand-primary / state-error-primary / state-success-primary
		 * 此前用了不存在的名字（text-primary / border / fill-primary / state-error-secondary）
		 * ⇒ 回退值（浅色 #fafafa/#fff）在深色主题下生效，概览卡片呈白底、正文低对比。
		 * 教训（已入 pitfalls §10.8）：① 回退值必须是**主题无关**的（transparent /
		 * rgba(128,128,128,·) / currentColor），否则 token 名一错就变成"深色下的白块"；
		 * ② token 名不要凭记忆写，用 Inspect 查。 */
		const ZCODE_PANEL_CSS = [
			".dzc-panel{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,currentColor)}",
			".dzc-summary{color:var(--dsw-alias-label-secondary,currentColor);opacity:.85}",
			".dzc-banner{padding:8px 12px;border:1px solid var(--dsw-alias-state-error-primary,currentColor);border-radius:6px;background:transparent;color:var(--dsw-alias-state-error-primary,currentColor);font-weight:600}",
			".dzc-note{padding:8px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:6px;color:var(--dsw-alias-label-secondary,currentColor);opacity:.9}",
			/* 概览：两列网格；面用 layer-1（与宿主卡片同层），回退 transparent 而非浅色 */
			".dzc-overview{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent)}",
			".dzc-overview dt{color:var(--dsw-alias-label-secondary,currentColor);opacity:.85;white-space:nowrap}",
			".dzc-overview dd{margin:0;font-variant-numeric:tabular-nums;word-break:break-all;color:var(--dsw-alias-label-primary,currentColor)}",
			/* 模型列表：分隔线式；外框 layer-1 */
			".dzc-models{display:flex;flex-direction:column;max-height:340px;overflow:auto;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:8px;padding:2px 0;background:var(--dsw-alias-bg-layer-1,transparent)}",
			".dzc-model{display:flex;flex-direction:column;gap:4px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22))}",
			".dzc-model:last-child{border-bottom:none}",
			".dzc-model:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10))}",
			".dzc-model-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dzc-model-sub{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding-left:24px}",
			".dzc-spacer{flex:1 1 auto}",
			".dzc-ctxgroup{display:inline-flex;align-items:center;gap:12px;white-space:nowrap}",
			".dzc-ctl-name{font-weight:600;color:var(--dsw-alias-label-primary,currentColor)}",
			".dzc-model-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}",
			".dzc-badge{padding:1px 7px;border:1px solid var(--dsw-alias-brand-primary,currentColor);border-radius:999px;font-size:11px;color:var(--dsw-alias-brand-primary,currentColor);white-space:nowrap;line-height:1.6;background:transparent}",
			".dzc-ctl{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;cursor:pointer;color:var(--dsw-alias-label-primary,currentColor)}",
			".dzc-ctl input:disabled{cursor:not-allowed}",
			".dzc-ctl:has(input:disabled){cursor:default;color:var(--dsw-alias-state-idle-primary,currentColor);opacity:.75}",
			".dzc-hint{color:var(--dsw-alias-label-secondary,currentColor);opacity:.85;font-size:12px}",
			".dzc-section-title{font-weight:600;margin-bottom:6px;color:var(--dsw-alias-label-primary,currentColor)}",
			".dzc-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding-top:2px}",
			".dzc-btn{padding:5px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,currentColor);cursor:pointer;transition:background-color .15s,border-color .15s;font-size:13px}",
			".dzc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}",
			".dzc-btn:disabled{opacity:.5;cursor:not-allowed}",
			".dzc-btn-primary{border-color:var(--dsw-alias-brand-primary,currentColor);color:var(--dsw-alias-brand-primary,currentColor);font-weight:600}",
			".dzc-msg-ok{color:var(--dsw-alias-state-success-primary,currentColor);font-weight:600}",
			/* 赠送额度进度条（composer dock + 面板共用）。主题纪律同 §样式头注：
			 * 只用实测存在的 token 名，回退值主题无关（rgba/currentColor/transparent）。 */
			".dzc-quota{display:flex;align-items:center;gap:8px;padding:3px 12px 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,currentColor)}",
			".dzc-quota-track{position:relative;flex:1 1 auto;min-width:60px;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.22));overflow:hidden}",
			".dzc-quota-fill{position:absolute;top:0;bottom:0;left:0;border-radius:999px;background:var(--dsw-alias-brand-primary,currentColor)}",
			".dzc-quota-fill-low{background:var(--dsw-alias-state-error-primary,currentColor)}",
			".dzc-quota-fill-idle{background:var(--dsw-alias-state-idle-primary,currentColor)}",
			".dzc-quota-label{white-space:nowrap;font-variant-numeric:tabular-nums}",
			".dzc-quota-pct{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,currentColor)}",
			".dzc-msg-error{color:var(--dsw-alias-state-error-primary,currentColor);font-weight:600}"
		].join("\n");
		if (typeof document !== "undefined") {
			const cssId = "dsh-connect-zcode/client.css";
			if (!document.querySelector(`style[data-plugin-css="${cssId}"]`)) {
				const styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-connect-zcode";
				styleTag.dataset.pluginCss = cssId;
				styleTag.textContent = ZCODE_PANEL_CSS;
				document.head.appendChild(styleTag);
			}
		}
		//#endregion
		//#region 状态文档共享轮询
		/**
		 * 状态文档（`/plugins/dsh-connect-zcode/status`）的**共享轮询器**。
		 *
		 * 为什么必须共享（而不是每个消费者各自 `setInterval`）：
		 *   ① 面板与"输入框下方赠送额度进度条"是**两个**消费者，各自轮询 = 双份请求；
		 *   ② 更要紧的是**一致性**：各自持有 `useState` 副本时，进度条刷新不会让面板重渲染，
		 *      同一个数字在两处会显示成不同时刻的值 —— 用户看到的是"两个数对不上"。
		 * 故：单一定时器 + 单一 in-flight 请求 + 监听器广播，任一处刷新都会同步另一边。
		 *
		 * 节流口径：60s 一次。宿主每次 GET 只做一次**有界尾部读**（64KB 块，命中即止），
		 * 代价很低；而上游余额本身就是分钟级刷新的，更快轮询没有信息增量。
		 */
		const STATUS_POLL_MS = 60000;
		const STATUS_STORE = { listeners: new Set(), timer: null, inflight: null, at: 0 };
		function notifyStatusError(error) {
			for (const listener of [...STATUS_STORE.listeners]) {
				try {
					listener.onError?.(error);
				} catch (inner) {
					/* 单个消费者异常不影响其他 */
				}
			}
		}
		function publishStatusDoc(doc) {
			STATUS_CACHE.current = doc;
			for (const listener of [...STATUS_STORE.listeners]) {
				try {
					listener.onDoc?.(doc);
				} catch (inner) {
					/* 单个消费者异常不影响其他 */
				}
			}
		}
		/**
		 * 拉一次状态文档。同一时刻只允许一个 in-flight（多个消费者共享同一个 Promise）；
		 * 非强制且距上次不足 1s 时直接复用缓存（防 React 重订阅风暴）。
		 * 失败不抛：走 onError 广播，UI 各自决定降级文案。
		 */
		function refreshStatusDoc(force) {
			if (STATUS_STORE.inflight !== null) return STATUS_STORE.inflight;
			if (force !== true && Date.now() - STATUS_STORE.at < 1000 && STATUS_CACHE.current !== null) {
				return Promise.resolve(STATUS_CACHE.current);
			}
			STATUS_STORE.at = Date.now();
			let pending;
			try {
				pending = fetch(STATUS_PATH, { method: "GET", credentials: "same-origin" });
			} catch (error) {
				notifyStatusError(error);
				return Promise.resolve(null);
			}
			STATUS_STORE.inflight = Promise.resolve(pending)
				.then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
				.then((doc) => {
					publishStatusDoc(doc);
					return doc;
				})
				.catch((error) => {
					notifyStatusError(error);
					return null;
				})
				.then((value) => {
					STATUS_STORE.inflight = null;
					return value;
				});
			return STATUS_STORE.inflight;
		}
		/**
		 * 订阅状态文档：立即拉一次，并在**第一个**订阅者出现时挂上全局定时器；
		 * 最后一个订阅者离开时撤掉定时器（不留后台空转）。
		 * @returns {() => void} 退订函数（React effect 的 cleanup 直接用）
		 */
		function subscribeStatusDoc(listener) {
			STATUS_STORE.listeners.add(listener);
			refreshStatusDoc(false);
			if (STATUS_STORE.timer === null) {
				STATUS_STORE.timer = setInterval(() => {
					refreshStatusDoc(true);
				}, STATUS_POLL_MS);
			}
			return () => {
				STATUS_STORE.listeners.delete(listener);
				if (STATUS_STORE.listeners.size === 0 && STATUS_STORE.timer !== null) {
					clearInterval(STATUS_STORE.timer);
					STATUS_STORE.timer = null;
				}
			};
		}
		//#endregion
		//#region 卡片组件
		/**
		 * 设置卡。props = slot inject 的 { settingsScope, statusRef } + owner 传入的 view。
		 * 所有渲染走 createElement（文本子节点自动转义，无 innerHTML，XSS 面为零）。
		 */
		function ZcodePanelCard({ settingsScope, statusRef, view }) {
			const snapshot = settingsScope?.getSnapshot?.() ?? { status: "unavailable", value: void 0, writable: false };
			const writable = snapshot.writable === true;
			const configValue = unwrapLiveDeep(snapshot.value);
			const storedIds = canonIds(configValue?.enabledModelIds);
			const storedBudgets = canonBudgets(configValue?.contextBudgets);
			const storedOverrides = canonOverrides(configValue?.modelOverrides);
			/** 赠送额度通道（appServer）暴露的模型 id（configValue.appServerModels）。 */
			const storedGiftIds = canonIds(configValue?.appServerModels);
			/** 赠送额度通道的**默认思考档**（configValue.appServerReasoningLevel）：
			 * 未手动选档 / 宿主未下发 effort 时它生效；模型选择器里可逐轮改。 */
			const storedGiftReasoning = typeof configValue?.appServerReasoningLevel === "string"
				? configValue.appServerReasoningLevel
				: "max";
			const REASONING_LEVELS = ["low", "high", "max"];
			const [rev, setRev] = react.useState(0);
			/** 未保存的草稿（null = 未编辑，展示跟随已存值）。 */
			const [draftIds, setDraftIds] = react.useState(null);
			const [draftBudgets, setDraftBudgets] = react.useState(null);
			const [draftOverrides, setDraftOverrides] = react.useState(null);
			const [draftGiftIds, setDraftGiftIds] = react.useState(null);
			const [draftGiftBudgets, setDraftGiftBudgets] = react.useState(null);
			const [draftGiftReasoning, setDraftGiftReasoning] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [message, setMessage] = react.useState(void 0);
			const [status, setStatus] = react.useState(statusRef?.current ?? void 0);
			const [statusError, setStatusError] = react.useState(void 0);
			react.useEffect(() => {
				if (settingsScope?.subscribe === void 0) return void 0;
				return settingsScope.subscribe(() => setRev((value) => value + 1));
			}, [settingsScope]);
			react.useEffect(() => {
				if (view !== "page") return void 0;
				setStatusError(void 0);
				/* 走共享轮询器（见 subscribeStatusDoc 注释）：面板与输入框进度条共用一份请求，
				 * 且任一处刷新都会同步另一边 —— 两处显示的额度不会出现"两个数对不上"。
				 * `rev` 在依赖里 = 设置命名空间变更时重订阅（顺带强制拉一次新数据）。 */
				return subscribeStatusDoc({
					onDoc: (doc) => {
						setStatus(doc);
						if (statusRef !== void 0) statusRef.current = doc;
					},
					onError: (error) => setStatusError(String(error?.message ?? error)),
				});
			}, [view, rev, statusRef]);
			/** 目录：状态路由优先（含动态发现 + 能力事实），否则静态表（无事实的降级行）。 */
			const catalog = (status !== void 0 && Array.isArray(status?.models) && status.models.length > 0
				? status.models.map((row) => ({
					id: String(row.id),
					name: String(row.name ?? row.id),
					/** facts = 行带权威能力事实（状态路由返回）；降级行不做无效条目清理（防误删用户配置）。 */
					facts: true,
					official: row.official === true,
					has1m: row.has1m === true,
					imageSupported: row.imageSupported === true,
					reasoningVariants: Array.isArray(row.reasoningVariants) ? row.reasoningVariants.filter((v) => typeof v === "string") : []
				}))
				: STATIC_MODEL_IDS.map((id) => ({ id, name: id, facts: false, official: false, has1m: false, imageSupported: false, reasoningVariants: [] })));
			const total = catalog.length;
			/** 生效配置：草稿优先，未编辑跟随已存值。 */
			const effectiveIds = draftIds ?? storedIds;
			const budgets = draftBudgets ?? storedBudgets;
			const overrides = draftOverrides ?? storedOverrides;
			const enabledCount = effectiveIds.length === 0 ? total : catalog.filter((row) => effectiveIds.includes(row.id)).length;
			const budget1mCount = catalog.filter((row) => row.has1m && budgets[row.id] === CONTEXT_1M).length;
			const isEnabled = (id) => (effectiveIds.length === 0 ? true : effectiveIds.includes(id));
			/** 图片开关态：官方行锁定为官方 modalities（不支持图片的官方行也不可勾）；非官方行看用户开关。 */
			const imageOn = (row) => (row.official ? row.imageSupported : overrides[row.id]?.image === true);
			const reasoningOn = (row) => (row.official ? row.reasoningVariants.length > 0 : overrides[row.id]?.reasoning === true);
			const clearMessage = () => setMessage(void 0);
			const toggleEnable = (id, nextChecked) => {
				const base = effectiveIds.length === 0 ? catalog.map((row) => row.id) : effectiveIds;
				setDraftIds(nextChecked ? [...new Set([...base, id])] : base.filter((entry) => entry !== id));
				clearMessage();
			};
			/** 更新一个开关草稿（role = "image" | "reasoning"；只留显式 true，空条目删除）。 */
			const toggleOverride = (row, role, nextChecked) => {
				const base = draftOverrides ?? storedOverrides;
				const entry = { ...(base[row.id] ?? {}) };
				if (nextChecked) entry[role] = true;
				else delete entry[role];
				const next = { ...base };
				if (Object.keys(entry).length > 0) next[row.id] = entry;
				else delete next[row.id];
				setDraftOverrides(next);
				clearMessage();
			};
			/** 上下文档位草稿（want1m=false 即回到 200K 基础档 = 删除条目）。 */
			const setBudgetTier = (row, want1m) => {
				const base = draftBudgets ?? storedBudgets;
				const next = { ...base };
				if (want1m) next[row.id] = CONTEXT_1M;
				else delete next[row.id];
				setDraftBudgets(next);
				clearMessage();
			};
			/**
			 * 保存前的无效条目清理（T22 §1.2「有官方数据的忽略并回读提示」）：
			 * 只清理**当前目录带权威事实且可判定**不生效的条目（官方行覆盖 / 非官方 Max 档行的
			 * 1M 勾选）；状态路由缺席（降级行无事实）或目录里查不到的 id 一律保留——
			 * host 侧 applyXxx 本来就会忽略无效条目，这里不做不可判定的删除。
			 */
			const sanitizeDrafts = () => {
				const rawBudgets = draftBudgets ?? storedBudgets;
				const rawOverrides = draftOverrides ?? storedOverrides;
				const keptBudgets = {};
				let droppedBudgets = 0;
				for (const [id, value] of Object.entries(rawBudgets)) {
					const row = catalog.find((entry) => entry.id === id);
					if (row !== void 0 && row.facts && (row.has1m !== true || value !== CONTEXT_1M)) {
						droppedBudgets += 1;
						continue;
					}
					keptBudgets[id] = value;
				}
				const keptOverrides = {};
				let droppedOverrides = 0;
				for (const [id, entry] of Object.entries(rawOverrides)) {
					const row = catalog.find((item) => item.id === id);
					if (row !== void 0 && row.facts && row.official) {
						droppedOverrides += 1;
						continue;
					}
					keptOverrides[id] = entry;
				}
				return { ids: draftIds ?? storedIds, budgets: keptBudgets, overrides: keptOverrides, dropped: droppedBudgets + droppedOverrides };
			};
			const save = async () => {
				if (saving || writable !== true) return;
				setSaving(true);
				setMessage(void 0);
				try {
					const next = sanitizeDrafts();
					await writeField(settingsScope, "enabledModelIds", next.ids, canonIds);
					/* 赠送额度的上下文档与 Coding Plan **共用同一个 contextBudgets 字典**
					 * （id 不重叠），故这里合并后再写一次，避免两次写相互覆盖。 */
					const mergedBudgets = { ...next.budgets };
					for (const row of giftCatalog) {
						const value = draftGiftBudgets !== null && row.id in draftGiftBudgets ? draftGiftBudgets[row.id] : budgets[row.id];
						if (value === CONTEXT_1M) mergedBudgets[row.id] = CONTEXT_1M;
						else delete mergedBudgets[row.id];
					}
					await writeField(settingsScope, "contextBudgets", mergedBudgets, canonBudgets);
					await writeField(settingsScope, "modelOverrides", next.overrides, canonOverrides);
					await writeField(settingsScope, "appServerModels", giftIds, canonIds);
					/* 默认思考档（通道级）：写入前与官方候选求交，非法值一律回落到"当前生效值"，
					 * 避免把面板不认识的值写进配置（schema 也会兜一层，但这里先自证）。 */
					await writeField(
						settingsScope,
						"appServerReasoningLevel",
						giftReasoningOf(),
						(value) => (giftReasoningLevels.includes(value) ? value : storedGiftReasoning)
					);
					setDraftIds(null);
					setDraftBudgets(null);
					setDraftOverrides(null);
					setDraftGiftIds(null);
					setDraftGiftBudgets(null);
					setDraftGiftReasoning(null);
					setMessage({
						kind: "ok",
						text:
							"已保存（显隐/预算/开关三项写后回读校验通过）。" +
							(next.dropped > 0 ? `清理了 ${next.dropped} 项不生效条目（官方模型的开关不可覆盖；无官方 Max 档的模型无 1M 档）。` : "") +
							"新配置对模型目录的生效方式见下方说明。"
					});
				} catch (error) {
					setMessage({ kind: "error", text: String(error?.message ?? error) });
				} finally {
					setSaving(false);
				}
			};
			if (view !== "page") {
				const parts = [`${total} 个模型`, `已启用 ${enabledCount} 个`, `1M 档 ${budget1mCount} 个`];
				if (status !== void 0) parts.push(status.frozen ? "开关：frozen（冻结）" : "开关：active");
				return el("div", { className: "dzc-summary" }, parts.join(" · "));
			}
			const dirty = draftIds !== null || draftBudgets !== null || draftOverrides !== null || draftGiftIds !== null || draftGiftBudgets !== null || draftGiftReasoning !== null;
			/* ── 赠送额度通道（Start Plan，provider `zcode-appserver`）────────────────
			 * 与上面 Coding Plan 的模型列表**并列但独立**：勾选写 `appServerModels`（该通道暴露哪些模型），
			 * 上下文档写进共享的 `contextBudgets`（id 不重叠，互不影响）。
			 * 事实来源 = 状态文档的 `appServer` 段（host 半现读配置 + 真实注册结果）。 */
			const giftState = status?.appServer;
			const giftCatalog = giftState !== void 0 && Array.isArray(giftState.models)
				? giftState.models.map((row) => ({
					id: String(row.id),
					name: String(row.name ?? row.id),
					contextWindow: Number.isFinite(row.contextWindow) ? row.contextWindow : 200000,
					/** 官方档位事实（状态文档下发；缺省回退已知档位，不新造档位）。 */
					reasoningLevels: Array.isArray(row.reasoningLevels) && row.reasoningLevels.length > 0
						? row.reasoningLevels.filter((v) => typeof v === "string" && REASONING_LEVELS.includes(v))
						: REASONING_LEVELS,
					defaultReasoningLevel: typeof row.defaultReasoningLevel === "string" && REASONING_LEVELS.includes(row.defaultReasoningLevel)
						? row.defaultReasoningLevel
						: "max",
				}))
				: [];
			const giftDefaultId = giftCatalog.length > 0 ? giftCatalog[0].id : "";
			const giftIds = draftGiftIds ?? storedGiftIds;
			/** 空 = 回默认单条（与 host `resolveAppServerCatalog([])` 同语义）。 */
			const giftBase = giftIds.length === 0 ? (giftDefaultId === "" ? [] : [giftDefaultId]) : giftIds;
			const giftChecked = (id) => giftBase.includes(id);
			const toggleGift = (id, on) =>
				setDraftGiftIds(on ? [...new Set([...giftBase, id])] : giftBase.filter((entry) => entry !== id));
			const giftBudgetOf = (id) =>
				draftGiftBudgets !== null && id in draftGiftBudgets ? draftGiftBudgets[id] : (budgets[id] ?? 200000);
			const setGiftBudget = (id, value) => setDraftGiftBudgets({ ...(draftGiftBudgets ?? {}), [id]: value });
			/** 通道级**默认思考档**（configValue.appServerReasoningLevel）：整个通道一个值。
			 * 档位候选来自官方 variants（状态文档下发），面板不硬编码、也不新造档位。 */
			const giftReasoningLevels = giftCatalog.length > 0 ? giftCatalog[0].reasoningLevels : REASONING_LEVELS;
			const giftReasoningOf = () => {
				const value = draftGiftReasoning ?? storedGiftReasoning;
				return giftReasoningLevels.includes(value) ? value : giftReasoningLevels[giftReasoningLevels.length - 1];
			};
			/** 默认思考档一行（通道级，全通道共用一个值）。 */
			const giftReasoningRow = () =>
				el("div", { className: "dzc-model-sub", key: "gift-reasoning" },
					el("span", { className: "dzc-hint" }, "默认思考档（全通道）"),
					el("span", { className: "dzc-ctxgroup" },
						giftReasoningLevels.map((level) =>
							el("label", { key: `gift-reasoning-${level}`, className: "dzc-ctl" },
								el("input", {
									type: "radio",
									name: "gift-reasoning",
									"data-role": "gift-reasoning",
									"data-level": level,
									checked: giftReasoningOf() === level,
									disabled: ctlDisabled,
									onChange: () => { setDraftGiftReasoning(level); clearMessage(); }
								}),
								el("span", null, level)
							)
						)
					)
				);
			/** 赠送额度通道一行：显隐 + 上下文档（图片能力与官方思考档为**事实展示**）。 */
			const giftModelRow = (row) =>
				el("div", { key: `gift-${row.id}`, className: "dzc-model" },
					el("div", { className: "dzc-model-head" },
						el("label", { className: "dzc-ctl" },
							el("input", {
								type: "checkbox",
								"data-role": "gift-enable",
								"data-model": row.id,
								checked: giftChecked(row.id),
								disabled: ctlDisabled,
								onChange: (event) => { toggleGift(row.id, event.target.checked); clearMessage(); }
							}),
							el("span", { className: "dzc-ctl-name" }, row.name)
						),
						el("span", { className: "dzc-badge" }, "赠送额度"),
						el("span", { className: "dzc-spacer" }),
						el("span", { className: "dzc-ctxgroup" },
							el("label", { className: "dzc-ctl" },
								el("input", {
									type: "radio",
									name: `gift-ctx-${row.id}`,
									"data-role": "gift-ctx-base",
									"data-model": row.id,
									checked: giftBudgetOf(row.id) !== CONTEXT_1M,
									disabled: ctlDisabled,
									onChange: () => { setGiftBudget(row.id, 200000); clearMessage(); }
								}),
								el("span", null, "200K")
							),
							el("label", { className: "dzc-ctl" },
								el("input", {
									type: "radio",
									name: `gift-ctx-${row.id}`,
									"data-role": "gift-ctx-1m",
									"data-model": row.id,
									checked: giftBudgetOf(row.id) === CONTEXT_1M,
									disabled: ctlDisabled,
									onChange: () => { setGiftBudget(row.id, CONTEXT_1M); clearMessage(); }
								}),
								el("span", null, "1M")
							)
						)
					),
					el("div", { className: "dzc-model-sub" },
						el("span", { className: "dzc-hint" },
							giftState?.imagesSupported === true
								? "图片：支持（作为附件随消息转交给官方 agent）"
								: "图片：未启用（需 DSH attachments 服务在位；就绪后本通道即可收图）"),
						el("span", { className: "dzc-hint" },
							`思考档：${row.reasoningLevels.join(" / ")}（官方；默认 ${row.defaultReasoningLevel}，` +
								"可在模型选择器里逐轮切换）")
					)
				);
			/** 赠送额度通道的状态一行（未启用/未注册时给出可操作原因）。 */
			const giftStateText = (() => {
				if (giftState === void 0) return "状态未知（状态路由未返回 appServer 段）。";
				if (giftState.enabled !== true) return "未启用。在插件配置里设 appServer: true 后重启 DSH（见 README「Start Plan 通道」）。";
				if (giftState.registered !== true) return `已启用但未注册：${giftState.reason ?? "原因未知"}`;
				return `已注册 · CLI=${giftState.cliPath ?? "?"} · 工具策略=${giftState.toolPolicy ?? "?"}`;
			})();
			const lastLedger = status?.lastLedger;
			const ctlDisabled = !writable || saving;
			/** 一行的控件组（T22 §1.4 行布局；2026-10-01 排版重构为两行，对齐 trae 观感）：
			 * 第一行 = 显隐勾选 + 名称 + ·官方徽标 + 上下文档（200K/1M，右对齐）；
			 * 第二行 = 图片能力 + 推理档（官方只展示锁定文案 / 无官方数据给开关）。 */
			const modelRow = (row) =>
				el("div", { key: row.id, className: "dzc-model" },
					el("div", { className: "dzc-model-head" },
						el("label", { className: "dzc-ctl dzc-ctl-name" },
							el("input", {
								type: "checkbox",
								"data-role": "enable",
								checked: isEnabled(row.id),
								disabled: ctlDisabled,
								onChange: (event) => toggleEnable(row.id, event.target.checked === true)
							}),
							el("span", { className: "dzc-model-id" }, row.name)
						),
						row.official ? el("span", { className: "dzc-badge" }, "官方") : null,
						el("span", { className: "dzc-spacer" }),
						el("span", { className: "dzc-ctxgroup" },
							el("label", { className: "dzc-ctl" },
								el("input", {
									type: "radio",
									"data-role": "ctx-base",
									name: `dzc-ctx-${row.id}`,
									checked: !(row.has1m && budgets[row.id] === CONTEXT_1M),
									disabled: ctlDisabled,
									onChange: () => setBudgetTier(row, false)
								}),
								"200K"
							),
							row.has1m
								? el("label", { className: "dzc-ctl" },
									el("input", {
										type: "radio",
										"data-role": "ctx-1m",
										name: `dzc-ctx-${row.id}`,
										checked: budgets[row.id] === CONTEXT_1M,
										disabled: ctlDisabled,
										onChange: () => setBudgetTier(row, true)
									}),
									"1M"
								)
								: null
						)
					),
					el("div", { className: "dzc-model-sub" },
						el("label", { className: "dzc-ctl" },
							el("input", {
								type: "checkbox",
								"data-role": "image",
								checked: imageOn(row),
								disabled: row.official || ctlDisabled,
								onChange: (event) => toggleOverride(row, "image", event.target.checked === true)
							}),
							"图片"
						),
						row.official
							? el("span", { className: "dzc-hint" },
								row.reasoningVariants.length > 0
									? `推理档：${row.reasoningVariants.join(" / ")}（官方，锁定）`
									: "官方数据：无推理档（锁定）")
							: el("label", { className: "dzc-ctl" },
								el("input", {
									type: "checkbox",
									"data-role": "reasoning",
									checked: reasoningOn(row),
									disabled: ctlDisabled,
									onChange: (event) => toggleOverride(row, "reasoning", event.target.checked === true)
								}),
								"推理"
							),
						row.official ? null : el("span", { className: "dzc-hint" }, "（未提供官方数据，开关自担）")
					)
				);
			return el("div", { className: "dzc-panel", style: { marginTop: 8 } },
				status?.frozen === true
					? el("div", { className: "dzc-banner", role: "alert" }, "套餐冻结中：provider 调用与派发均被拒（PROTOCOL §7.1）。勾选仍可保存，解除冻结后生效。")
					: null,
				statusError !== void 0
					? el("div", { className: "dzc-note" }, `状态不可用（${statusError}）。勾选保存不受影响；能力徽标与 1M 档以目录恢复后为准。`)
					: null,
				el("dl", { className: "dzc-overview" },
					el("dt", null, "模型总数"),
					el("dd", null, status !== void 0 ? String(status.modelsTotal) : `${total}（静态表）`),
					el("dt", null, "已启用"),
					el("dd", null, `${enabledCount} 个`),
					el("dt", null, "上下文预算"),
					el("dd", null, `${budget1mCount} 个模型已切 1M`),
					el("dt", null, "provider"),
					el("dd", null, status === void 0 ? "未知" : status.providerRegistered ? "已注册" : "未注册"),
					el("dt", null, "开关"),
					el("dd", null, status === void 0 ? "未知" : status.frozen ? "frozen（冻结：provider 调用与派发均被拒）" : "active"),
					el("dt", null, "端点"),
					el("dd", null, status?.endpointHost ?? "未知"),
					el("dt", null, "赠送额度"),
					el("dd", { className: "dzc-quota-cell" }, status !== void 0 && status.planQuota !== void 0 ? quotaLineText(status.planQuota) : "未知（状态未取到）"),
					el("dt", null, "工作目录"),
					el("dd", null, workspaceLineText(status?.workspace)),
					lastLedger !== void 0 && lastLedger !== null
						? [
							el("dt", { key: "dt-ledger" }, "最近调用"),
							el("dd", { key: "dd-ledger" },
								`${lastLedger.model ?? "?"} · ${lastLedger.exit === 0 ? "ok" : `exit ${lastLedger.exit}`}` +
								(lastLedger.elapsedMs === null || lastLedger.elapsedMs === void 0 ? "" : ` · ${lastLedger.elapsedMs}ms`))
						]
						: null
				),
				el("div", null,
					el("div", { className: "dzc-section-title" }, "模型显示与能力"),
					el("div", { className: "dzc-hint", style: { marginBottom: 6 } },
						"勾选 = 在模型选择器中显示。带「官方」徽标的模型，其图片与推理档来自 ZCode 官方配置，锁定不可改；其余模型未提供官方数据，开关默认关、后果自担。"),
					el("div", { className: "dzc-models" }, catalog.map(modelRow)),
					el("div", { className: "dzc-hint", style: { marginTop: 6 } },
						"全部不勾 = 全部显示（默认）。1M 档为官方声明值（CLI 实测有效窗口 200k，压缩发生在 200k 附近）；仅官方声明 1M 上下文的模型提供该选项。")
				),
				el("div", null,
					el("div", { className: "dzc-section-title" }, "赠送额度通道（Start Plan）"),
					el("div", { className: "dzc-hint", style: { marginBottom: 6 } }, giftStateText),
					giftCatalog.length === 0
						? el("div", { className: "dzc-note" },
							"通道未就绪，暂无模型可配。启用后这里会出现「GLM-5.3-Flash（赠送额度）」等条目 —— 它与上面 Coding Plan 的同名模型是**两笔账**。")
						: el("div", { className: "dzc-models" }, [giftReasoningRow(), ...giftCatalog.map(giftModelRow)]),
					giftCatalog.length === 0
						? null
						: el("div", { className: "dzc-hint", style: { marginTop: 6 } },
							"勾选 = 出现在模型选择器的「ZCode Start Plan（赠送额度）」分组下（走官方 agent 代发，烧赠送额度）；" +
							"全部不勾 = 回默认单条（GLM-5.3-Flash）。上下文档与上方 Coding Plan 共用同一份预算表（模型 id 不重叠）。")
				),
				el("div", { className: "dzc-actions" },
					el("button", { className: "dzc-btn", disabled: ctlDisabled, onClick: () => { setDraftIds(catalog.map((row) => row.id)); clearMessage(); } }, "全选"),
					el("button", { className: "dzc-btn", disabled: ctlDisabled, onClick: () => { setDraftIds([]); clearMessage(); } }, "全不选（=全部显示）"),
					el("button", { className: "dzc-btn", disabled: ctlDisabled, onClick: () => { setDraftIds([]); setDraftBudgets({}); setDraftOverrides({}); setDraftGiftIds([]); setDraftGiftBudgets({}); setDraftGiftReasoning("max"); clearMessage(); } }, "恢复默认"),
					dirty ? el("button", { className: "dzc-btn", disabled: saving, onClick: () => { setDraftIds(null); setDraftBudgets(null); setDraftOverrides(null); setDraftGiftIds(null); setDraftGiftBudgets(null); setDraftGiftReasoning(null); clearMessage(); } }, "放弃修改") : null,
					el("button", { className: "dzc-btn dzc-btn-primary", disabled: ctlDisabled || !dirty, onClick: save }, saving ? "保存中…" : "保存"),
					writable ? null : el("span", { className: "dzc-hint" }, "设置命名空间不可写（尚未就绪），当前只读。"),
					message !== void 0 ? el("span", { className: message.kind === "ok" ? "dzc-msg-ok" : "dzc-msg-error", role: "status" }, message.text) : null
				),
				el("div", { className: "dzc-hint" },
					"生效方式：保存写入插件配置（enabledModelIds / contextBudgets / modelOverrides / appServerModels / appServerReasoningLevel）；模型目录按「loader/volatile-update」事件重导（与 trae 同机制），宿主未派发该事件时重启 DSH 生效。赠送额度通道暴露哪些模型由 appServerModels 决定，其上下文档与 Coding Plan 共用 contextBudgets；默认思考档只在宿主未下发档位时兜底，日常在输入框的模型选择器里逐轮切换。")
			);
		}
		//#endregion
		//#region 赠送额度（Start Plan）展示
		/**
		 * 额度单位紧凑格式（亿/万）：inline 标签用；悬浮提示用完整千分位。
		 * 只做展示，绝不参与判定 —— 数值本身来自状态文档的整数。
		 */
		function fmtUnitsShort(value) {
			if (!Number.isFinite(value)) return "—";
			const abs = Math.abs(value);
			if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
			if (abs >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
			return String(value);
		}
		function fmtUnitsFull(value) {
			return Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";
		}
		/** epoch 秒 → 本地 HH:MM（面板显示"何时生效/过期"）。 */
		function fmtClock(epochSeconds) {
			if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return "—";
			const d = new Date(epochSeconds * 1000);
			return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
		}
		/**
		 * 进度条模型（纯函数，便于自检）：返回 null 表示**不渲染**。
		 * 语义分离是刻意的：
		 *   - `active`  → 填充 = 剩余/总量，标签"剩余 X"，悬浮"剩余 X / 总量 Y"；
		 *   - `pending` → 桶还没建，剩余**不可知**：填充满格、标签"待生效 HH:MM"，
		 *                 悬浮"剩余 —（未生效） / 总量 Y"，绝不把总量冒充剩余；
		 *   - 其余（expired / 读不到 / 非 start-plan）→ 不渲染，避免误导。
		 */
		function quotaBarModel(quota) {
			if (quota === null || typeof quota !== "object" || quota.ok !== true) return null;
			const total = Number.isFinite(quota.totalUnits) ? quota.totalUnits : null;
			const remaining = Number.isFinite(quota.remainingUnits) ? quota.remainingUnits : null;
			if (quota.state === "active") {
				if (total === null || total <= 0 || remaining === null) return null;
				const ratio = Math.max(0, Math.min(1, remaining / total));
				return {
					state: "active",
					ratio,
					label: `赠送额度 剩余 ${fmtUnitsShort(remaining)}`,
					title: `剩余 ${fmtUnitsFull(remaining)} / 总量 ${fmtUnitsFull(total)}`
						+ (quota.model === null ? "" : `　· ${quota.model}`)
						+ (quota.observedAt === null ? "" : `　· 数据 ${String(quota.observedAt).slice(0, 16).replace("T", " ")}`),
					low: ratio <= 0.1
				};
			}
			if (quota.state === "pending") {
				if (total === null || total <= 0) return null;
				return {
					state: "pending",
					ratio: 1,
					label: `赠送额度 待生效 ${fmtClock(quota.effectiveAt)}`,
					title: `剩余 —（未生效） / 总量 ${fmtUnitsFull(total)}　· ${fmtClock(quota.effectiveAt)} 生效`
						+ (quota.planName === null ? "" : `　· ${quota.planName}`),
					low: false
				};
			}
			return null;
		}
		/** 面板里那一行的文字（与 composer 进度条同源，避免两处口径漂移）。 */
		function quotaLineText(quota) {
			const model = quotaBarModel(quota);
			if (model === null) {
				const reason = quota !== null && typeof quota === "object" && typeof quota.reason === "string" ? quota.reason : "不可用";
				return `不可用（${reason}）`;
			}
			return model.title;
		}
		/**
		 * app-server 会话工作目录的**跟随状态**（ZB-42/43 的运行时观测点）。
		 *
		 * 状态文档里的 `workspace` 来自宿主端 `createWorkspaceTracker()`：
		 *   - `source: "session"`       ⇒ 跟随当前会话目录**生效**（宿主 `working_directory` 服务可达）；
		 *   - `source: "config-pinned"` ⇒ 用户用 `appServerWorkspaceFollow: false` 钉死了目录；
		 *   - `source: "fallback"`      ⇒ 没取到会话目录（服务不可达 / 无 agent）⇒ 回落配置目录。
		 * 面板显示它，是因为"到底有没有跟随"原先只能靠翻日志判断。
		 */
		function workspaceLineText(workspace) {
			if (workspace === null || typeof workspace !== "object") return "未知（尚未建立 app-server 会话）";
			const source = typeof workspace.lastSource === "string" ? workspace.lastSource : "unknown";
			const label =
				source === "session" ? "跟随当前会话" :
				source === "config-pinned" ? "固定（配置）" :
				source === "fallback" ? "回落（未取到会话目录）" : "未知";
			const path = typeof workspace.lastPath === "string" && workspace.lastPath !== "" ? workspace.lastPath : "—";
			const tail = source === "fallback" ? "　· 若恒为回落：宿主未暴露 working_directory 服务" : "";
			return `${label} · ${path}${tail}`;
		}
		/**
		 * 从宿主 `modelSelection` 投影读出当前选择（官方 UI 同款数据源）。
		 *
		 * 字段名有**一处实证分歧**，故三个候选全读（顺序即优先级）：
		 *   - `next`     —— `dsh-api-remotes` 里 modelSelection 的 schema 字段；
		 *   - `pending`  —— `dsh-api-session-controller` 实际读的是 `projectionState.pending`；
		 *   - `lastUsed` —— schema 明确形状 `{provider, model, reasoningEffort?}`（已生效档）。
		 * 三者至少一个在场即可用；形状不对一律返回 undefined（调用方据此不渲染）而非抛。
		 * `dsh-connect-trae` 用同一投影做 composer 门禁，是本机可用的先例。
		 */
		function readModelSelection(useProjection) {
			if (typeof useProjection !== "function") return void 0;
			let projection;
			try {
				projection = useProjection("modelSelection") ?? null;
			} catch (error) {
				return void 0;
			}
			if (projection === null || typeof projection !== "object") return void 0;
			const picked = projection.next ?? projection.pending ?? projection.lastUsed;
			if (picked === null || typeof picked !== "object") return void 0;
			const provider = typeof picked.provider === "string" ? picked.provider : "";
			const model = typeof picked.model === "string" ? picked.model : "";
			if (provider === "" && model === "") return void 0;
			return { provider, model };
		}
		/** 投影缺席/形状未知只告警一次（避免每帧刷屏），但**必须可见** —— 否则进度条凭空消失无从排查。 */
		let warnedNoProjection = false;
		function warnProjectionMissingOnce() {
			if (warnedNoProjection) return;
			warnedNoProjection = true;
			console.warn(
				"[dsh-connect-zcode] 读不到宿主 modelSelection 投影（composer 赠送额度条按「不显示」处理）。" +
					"通常是 DSH 升级改了投影形状 —— 请对照 lib/client.js 的 readModelSelection 排查。"
			);
		}
		/**
		 * 输入框下方的赠送额度进度条（槽位 `conversation.composer.dock`，list 型）。
		 * 悬浮（原生 title）显示「剩余/总量」。
		 *
		 * **显示门禁**：只有当前选中的是赠送额度通道（provider = `zcode-appserver`）时才渲染。
		 * 依据是宿主自己的 `modelSelection` 投影（模型选择器写什么、下一次请求用什么，就是它），
		 * 所以不会出现"显示着额度、实际烧的却是 Coding Plan"的错配。
		 *
		 * 刷新：走**共享轮询器**（`subscribeStatusDoc`，60s）——与设置面板共用同一个定时器
		 * 与同一份 in-flight 请求，所以两处显示的额度永远同步，且不会各拉一次。
		 * 定时器只在**有订阅者**时存在，最后一个消费者卸载即撤掉。
		 */
		function ZcodeQuotaBar({ statusRef, useProjection }) {
			const [doc, setDoc] = react.useState(statusRef?.current ?? void 0);
			react.useEffect(() => {
				/* 与面板共用同一个轮询器/定时器（不自己 setInterval）：一处刷新，两处同步更新。 */
				return subscribeStatusDoc({
					onDoc: (next) => {
						setDoc(next);
						if (statusRef !== void 0) statusRef.current = next;
					},
					onError: () => {
						/* 额度展示失败静默：它只是装饰，不能影响输入框 */
					},
				});
			}, [statusRef]);
			/* ⚠️ 钩子必须在任何 return 之前无条件调用（React 规则：不能条件调用钩子）。 */
			const selection = readModelSelection(useProjection);
			if (selection === void 0) warnProjectionMissingOnce();
			/* 门禁：不是赠送额度那条通道 → 整个不渲染。 */
			if (selection === void 0 || selection.provider !== QUOTA_PROVIDER_ID) return null;
			const model = quotaBarModel(doc?.planQuota);
			if (model === null) return null;
			const fillClass = model.state === "pending"
				? "dzc-quota-fill dzc-quota-fill-idle"
				: model.low
					? "dzc-quota-fill dzc-quota-fill-low"
					: "dzc-quota-fill";
			return el("div", { className: "dzc-quota", title: model.title },
				el("span", { className: "dzc-quota-label" }, model.label),
				el("div", { className: "dzc-quota-track" },
					el("div", { className: fillClass, style: { width: `${(model.ratio * 100).toFixed(2)}%` } })),
				el("span", { className: "dzc-quota-pct" }, `${Math.round(model.ratio * 100)}%`)
			);
		}
		//#endregion
		//#region apply
		/** 稳定 browser-plugin 名。 */
		const name = "dsh-connect-zcode-client";
		/**
		 * client 服务：slots（卡注入）+ locale + remote。
		 *
		 * 为什么必须带 locale/remote（2026-10-01 真机实证修复）：面板此前只声明 `slots`，
		 * 结果 `configForms` 软探测恒为 undefined → 面板**永久只读**（"设置命名空间不可写"）。
		 * 机制：`configForms` 由 `@deepseek-ai/dsh-client-ui-settings` 的 client 半提供，
		 * 而它自身的 cordis inject 是 `["remote", "remote.settings"]` —— 组合里必须先有
		 * `remote` 服务，它才会激活并 provide `configForms`。
		 * 本机两个可用参照（均已实证面板可写）：
		 *   - dsh-connect-trae  : inject ["slots","locale"]
		 *   - dsh-workbuddy-connect: inject ["slots","locale","remote","remote.session"]
		 * 取并集（"从已证安全的集合里取需求"），并同步在 package.json 的 dsh.client.inject
		 * 里声明 `@deepseek-ai/dsh-api-remotes`（提供 remote）。
		 * 仍保留 ctx.get 软探测：服务缺席时面板降级只读，绝不因服务缺失而加载失败。
		 */
		const inject = ["slots", "locale", "remote"];
		function apply(ctx) {
			try {
				const softGet = (serviceName) => ctx.get(serviceName);
				const forms = softGet("configForms");
				/**
				 * 设置作用域（trae :1442-1486 同款）：绑定宿主实际服务的命名空间并随镜像重绑。
				 * 镜像就绪前 writable=false，面板只读而不是给出永远存不上的控件。
				 */
				const settingsScope = (() => {
					let current;
					let currentOff;
					let refreshedOnce = false;
					const listeners = new Set();
					const notify = () => {
						for (const listener of [...listeners]) listener();
					};
					const scope = {
						getSnapshot: () => current?.getSnapshot() ?? { status: "unavailable", value: void 0, writable: false },
						subscribe: (listener) => {
							listeners.add(listener);
							return () => {
								listeners.delete(listener);
							};
						},
						set: (field, value) => (current !== void 0 ? current.set(field, value) : Promise.resolve(false))
					};
					const rebind = () => {
						let served;
						let all = [];
						try {
							all = forms?.describe().getSnapshot().view?.namespaces ?? [];
						} catch (error) {
							/* R-16：空 catch 把**异常**伪装成"尚未就绪"——面板只读时的提示文案
							 * 会误导排查方向。configForms 读取失败要留痕。 */
							console.warn("[dsh-connect-zcode] configForms namespaces 读取失败（面板降级只读）：", error?.message ?? error);
						}
						/* R-17：精确命中生产 settingsNs（Loader entry id = cordis.patch.yml 的 id
						 * `zcode-connect`）；原写法 `entry.ns === "zcode"`
						 * 在生产**永不命中**（该值只在 fiber.entry.options.id 缺失的兜底场景出现），
						 * 于是永远走 /zcode/i 模糊分支。模糊分支保留为兜底，但多候选时要报警——
						 * 同装多个含 zcode 的插件会按数组顺序静默误绑。 */
						const exact = all.find((entry) => entry.ns === NS_EXACT);
						const fuzzy = all.filter((entry) => NS_PATTERN.test(entry.ns));
						served = exact ?? fuzzy[0];
						if (exact === void 0 && fuzzy.length > 1) {
							console.warn(`[dsh-connect-zcode] 多个候选设置命名空间命中 /zcode/i，已绑定 "${fuzzy[0].ns}"：${fuzzy.map((e) => e.ns).join(", ")}`);
						}
						const next = served === void 0 || forms === void 0 ? void 0 : forms.get(served.ns);
						if (next !== current) {
							currentOff?.();
							current = next;
							currentOff = current?.subscribe(notify);
							notify();
						}
						if (next === void 0 && !refreshedOnce) {
							refreshedOnce = true;
							try {
								(forms?.describe()).load?.();
							} catch (error) {
								console.warn("[dsh-connect-zcode] configForms load() 失败（设置命名空间可能尚未就绪）：", error?.message ?? error);
							}
						}
					};
					rebind();
					forms?.describe().subscribe?.(rebind);
					return scope;
				})();
				const registerCard = (slotName, key) => {
					try {
						ctx.slots.inject(slotName, () => ctx.slots.register({
							name: slotName,
							key,
							priority: 30,
							inject: () => ({ settingsScope, statusRef: STATUS_CACHE })
						}, ZcodePanelCard));
					} catch (error) {
						console.error(`[dsh-connect-zcode] card slot "${slotName}" failed to register (host provider unaffected):`, error);
					}
				};
				registerCard("plugins.bundle.config", BUNDLE_KEY);
				/**
				 * 输入框下方（模型选择器之下）的赠送额度进度条。
				 * 槽位 `conversation.composer.dock` 是 **list 型** ⇒ 注册描述符必须带 `id`
				 * （同 priority 下唯一），`order` 参与同槽位排序；官方先例：chat 注册
				 * `{ id: "stats", order: 0 }`。宿主只在 composer 变体且已有会话时渲染它。
				 * 注册失败只记录（宿主 provider 不受影响）——与设置卡同一条纪律。
				 */
				try {
					ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
						name: "conversation.composer.dock",
						id: "zcode-quota-bar",
						order: 10,
						priority: 30,
						inject: () => ({ statusRef: STATUS_CACHE })
					}, ZcodeQuotaBar));
				} catch (error) {
					console.error('[dsh-connect-zcode] quota bar slot "conversation.composer.dock" failed to register (host provider unaffected):', error);
				}
			} catch (error) {
				console.error("[dsh-connect-zcode] client panel failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
