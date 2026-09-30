window.__ModuleLoader__.load({
	id: "@local/dsh-connect-zcode",
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
		const BUNDLE_KEY = "@local/dsh-connect-zcode";
		/** 设置命名空间匹配（host 的 settingsNs = Loader entry id，zcode-connect）。 */
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
			const [rev, setRev] = react.useState(0);
			/** 未保存的草稿（null = 未编辑，展示跟随已存值）。 */
			const [draftIds, setDraftIds] = react.useState(null);
			const [draftBudgets, setDraftBudgets] = react.useState(null);
			const [draftOverrides, setDraftOverrides] = react.useState(null);
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
				let cancelled = false;
				setStatusError(void 0);
				fetch(STATUS_PATH, { method: "GET", credentials: "same-origin" })
					.then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
					.then((doc) => {
						if (cancelled) return;
						setStatus(doc);
						if (statusRef !== void 0) statusRef.current = doc;
					})
					.catch((error) => {
						if (!cancelled) setStatusError(String(error?.message ?? error));
					});
				return () => {
					cancelled = true;
				};
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
					await writeField(settingsScope, "contextBudgets", next.budgets, canonBudgets);
					await writeField(settingsScope, "modelOverrides", next.overrides, canonOverrides);
					setDraftIds(null);
					setDraftBudgets(null);
					setDraftOverrides(null);
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
			const dirty = draftIds !== null || draftBudgets !== null || draftOverrides !== null;
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
				el("div", { className: "dzc-actions" },
					el("button", { className: "dzc-btn", disabled: ctlDisabled, onClick: () => { setDraftIds(catalog.map((row) => row.id)); clearMessage(); } }, "全选"),
					el("button", { className: "dzc-btn", disabled: ctlDisabled, onClick: () => { setDraftIds([]); clearMessage(); } }, "全不选（=全部显示）"),
					el("button", { className: "dzc-btn", disabled: ctlDisabled, onClick: () => { setDraftIds([]); setDraftBudgets({}); setDraftOverrides({}); clearMessage(); } }, "恢复默认"),
					dirty ? el("button", { className: "dzc-btn", disabled: saving, onClick: () => { setDraftIds(null); setDraftBudgets(null); setDraftOverrides(null); clearMessage(); } }, "放弃修改") : null,
					el("button", { className: "dzc-btn dzc-btn-primary", disabled: ctlDisabled || !dirty, onClick: save }, saving ? "保存中…" : "保存"),
					writable ? null : el("span", { className: "dzc-hint" }, "设置命名空间不可写（尚未就绪），当前只读。"),
					message !== void 0 ? el("span", { className: message.kind === "ok" ? "dzc-msg-ok" : "dzc-msg-error", role: "status" }, message.text) : null
				),
				el("div", { className: "dzc-hint" },
					"生效方式：保存写入插件配置（enabledModelIds / contextBudgets / modelOverrides）；模型目录按「loader/volatile-update」事件重导（与 trae 同机制），宿主未派发该事件时重启 DSH 生效。")
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
						try {
							served = (forms?.describe().getSnapshot().view?.namespaces ?? []).find((entry) => entry.ns === "zcode" || NS_PATTERN.test(entry.ns));
						} catch {}
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
							} catch {}
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
