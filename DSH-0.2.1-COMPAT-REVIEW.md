# dsh-connect-zcode — DSH 0.2.1-rc.1 兼容与优化评估

> 生成：2026-10-17 ｜ 作者：标准模式 DSH 会话
> **基线**：DSH `0.2.0-rc.2`（当前运行，**尚未更新**）→ **目标**：`0.2.1-rc.1`
> 排查方式：静态代码扫描（排除 `node_modules` / `test`）+ 官方包对比（npm `0.2.1-rc.1` vs 当前 `app.asar` 内 `0.2.0-rc.2`）+ 本机实测

---

> **【审核更新 · 2026-10-17 独立复核】** 由另一方（DSH 会话）逐条核对上游与本机后补充。
> **原文档主体准确**：12 项变更、peer/pi-ai 范围、工具规则仅首轮注入、不读 DSH 凭据服务——均已在真机/上游侧复核通过。
> 但有 **3 处需要修正**、**6 处可补充的优化点**，其中"P0"的定性建议下调。

### A. 已独立核实的上游事实

- `dsh-v0.2.1-rc.1` **已于 2026-10-17T05:22Z 发布**（GitHub Release，`prerelease=true`，**尚非稳定版**）；中间还经过 `alpha.3`(10-14) / `alpha.4`(10-15) / `alpha.5`(10-16)
- `compare rc.1...master` = **identical（ahead 0 / behind 0）** ⇒ rc.1 就是最新内容
- 本机运行端仍是 **`@deepseek-ai/dsh-desktop-runtime@0.2.0-rc.2`**（从 `app.asar` 的 `dsh/package.json` 读出，与本文基线一致）
- 本文 §三 的 12 项变更**全部**能在 rc.1 release notes 的「其他变更 / Chores」段找到原文（含 agent-instructions `dshHome`、Azure 改名、pi-ai 1.0.2）

### B. 3 处修正

**B1. `engines.dsh` 不是 P0，建议降为 P1（建议项）**
- 官方原文是「未声明时**沿用原有规则**」⇒ **不补不会挡升级**（本文 §四 自己也写了"不补不会立刻坏"）
- 更要紧：本机 4 个插件都是 **junction 链接安装**（`node_modules/dsh-connect-zcode` → `F:\My Code\dsh-connect-zcode`，`ReparsePoint` 已核）⇒ **安装器根本不走兼容判定**，对本机现状**零影响**；补 `engines.dsh` 只在"将来打包分发给别人"时有意义
- 结论：**P0 = 0**；`engines.dsh` 归入"建议、可随时补、零风险"

**B2. `engines.dsh` 的建议区间可用 —— 但原因是 DSH 开了 `includePrerelease`**
- 标准 semver 实测：`satisfies('0.2.1-rc.1', '>=0.2.0-rc.2 <0.3.0-0')` = **false**（预发布陷阱）
- 但读 `@deepseek-ai/dsh-app-boot@0.2.1-rc.1` 的 `evaluatePluginCompatibility`（npm 包 `lib/index.js`）实现，判定用的是
  `satisfies(runtimeVersion, range, { includePrerelease: true })` ⇒ **预发布版本会被匹配**
- 所以**不需要**改成 `>=0.2.1-rc.1`；**直接沿用 `">=0.2.0-rc.2 <0.3.0-0"` 即可** ✓

**B3. 「peer 范围已覆盖 0.2.1-rc.1 ✅」不严谨（仅对 npm 分发场景）**
- peer 校验由 pnpm 做，按 semver **默认**语义（无 `includePrerelease`）：实测 `satisfies('0.2.1-rc.1', '>=0.1.7-rc.1 <0.3.0-0')` = **false**
- 本机没问题是因为 **junction 安装跳过 pnpm 校验**；将来若走 **npm 分发**，现有 peer 区间会对 0.2.1-rc.1 报 peer 警告 ⇒ 届时需改成含 0.2.1 预发布比较器的区间（如 `>=0.2.1-rc.1 <0.3.0-0`）
- **本轮不必改**

### C. 优化项的修正与新增

**C1. §五-1 / §五-2 收益下调（不适用）**：app-server 通道的请求体是
`JSON.stringify({ system, messages })`（`lib/app-server.js:668`，**没有 `tools` 字段**），且本插件**不注册任何 agent 工具** ⇒ DSH 工具**本来就不在**这个 payload 里，"工具动态移除"对该通道**不适用**；"系统提示词动态更新"同理（自定义 adapter 自己拼 payload，pi-ai 路由能力不经过它）。真实可做的是**在 adapter 侧按需重写 system**——这件事现在就能做，无需 0.2.1。建议把这两条从"收益最大"降为"不适用 / 已可做"。

**C2. 新增可优化点（原文缺的）**

| # | 0.2.1 新能力 | 对本插件的用法 |
|---|---|---|
| 1 | **Session 状态记录接口**（实验性） | 把"本会话用的 provider / 令牌到期 / 剩余额度"写进 DSH 会话记录，恢复会话时直接展示 |
| 2 | **`working_directory` 工具 + SDK API** | app-server 通道的 cwd 目前自算，可改为读写官方会话工作目录，避免与宿主漂移 |
| 3 | **插件热重载 + 依赖同步** | 4 个插件都是 junction；改 client 后无需重启（注意：client 插件 HMR 仅在 `pnpm run dev:web` 时自动重载） |
| 4 | **密钥/令牌默认脱敏 + 按需显示** | 设置卡片的"令牌有效期"展示可复用官方脱敏，避免自渲染明文 |
| 5 | **工具调用"准备阶段"进度** | （对派发台更相关）面板"当前工作"可复用官方进度事件，替代自建心跳 |
| 6 | **`/compact` 手动压缩 + 极简模式自动压缩** | ⚠️ **跨插件风险**：context-pilot 自己在 pre-step 压缩，需确认与官方压缩不冲突（本插件无影响） |

### D. 执行建议（本轮）

- **不需要改任何插件代码**：12 项变更对**本插件** 0 命中（rc.1 仍是 prerelease）
- 唯一必要的兼容性改动：声明 `engines.dsh`（已执行，见 §E）
- **等稳定版**发布后再按 §六 清单实测

### E. 执行记录（2026-10-17，**已完成兼容性改动**）

本轮只做"新版兼容性"相关改动，**不碰任何功能逻辑**：

| 改动 | 文件 | 说明 |
|---|---|---|
| 声明 `engines.dsh` | `package.json` | `"dsh": ">=0.2.0-rc.2 <0.3.0-0"`（DSH 判定含 `includePrerelease`，预发布版可匹配） |
| 版本号 | `package.json` | `0.5.0 → 0.5.1`（兼容性发布） |
| 兼容自检脚本 | `scripts/compat-check.mjs`（新增） | 离线、零依赖：engines.dsh / engines.node / peers 报告 / **inject 内部模块在运行时的存在性** / 清单契约 / semver 自测（10 组对照 Node semver 7.8.4 实测）；`--dsh-version` 可**升级前预演**，`--json` 可机读 |
| npm scripts | `package.json` | `check:compat` / `check:compat:self-test` |
| 文档 | `README.md` | 新增「DSH 版本兼容性（0.2.1 适配）」节 + 自检查项表 |

**验证结果（改完即跑）**：
- `node scripts/compat-check.mjs` → 当前 `0.2.0-rc.2`：**COMPAT PASS**（0 失败 / 0 警告）
- `node scripts/compat-check.mjs --dsh-version 0.2.1-rc.1` → **COMPAT PASS**（并提示该版本在标准 semver 默认语义下不满足，仅影响 npm 分发场景）
- `node scripts/compat-check.mjs --self-test` → **10/10**
- `node test/selfcheck.mjs` → **SELFCHECK PASS：295/295**

**未做（按约定留给下一阶段）**：C2 里的 6 项功能优化（Session 状态记录 / working_directory / 热重载 / 令牌脱敏 / 工具进度 / `/compact` 冲突排查）—— 等 DSH 更新完成后再做。

**升级后的操作**：更新 DSH → `node scripts/compat-check.mjs` 应仍为 `COMPAT PASS` → 再按 §六 做真机功能验证。

### F. 升级后验证记录（2026-10-17，已更新到 **DSH 0.2.1-rc.2**）

**上游**：`dsh-v0.2.1-rc.2` 发布 2026-10-17T08:16:33Z；`rc.1 → rc.2` 仅 **9 个提交**（DeepSeek-V4.1-Flash-1017 适配 + DeepSeek Search/Fetch API），**无新增破坏性变更** ⇒ §三 的 12 项比对结论继续成立。

**① 兼容自检**（`node scripts/compat-check.mjs`）→ **COMPAT PASS（0 失败 / 1 警告）**：`engines.dsh` ✅（0.2.1-rc.2 命中）、清单契约 ✅、semver 自测 10/10 ✅。

**② 插件加载状态**（`plugin_manager list_plugins`）✅ host 半边：
```
entryId: include:zcode-connect  moduleName: dsh-connect-zcode  enabled: true  fiberPhase: active
```

**③ 客户端半边实测**（client `Slots.listSubTree`）✅ **两个注册点都挂上了**：
| 槽位 | occupant |
|---|---|
| `plugins.bundle.config` | `{ registrant: dsh-connect-zcode-client, key: dsh-connect-zcode, active: true }` |
| `conversation.composer.dock` | `{ registrant: dsh-connect-zcode-client, id: zcode-quota-bar, order: 10, active: true }` |

**④ 新发现：0.2.1 合并了部分内部 UI 包（不影响本插件）**
- `@deepseek-ai/dsh-client-ui-slots` 与 `@deepseek-ai/dsh-client-ui-primitives` **在 0.2.1 全 asar 中已不存在**（306 个 `@deepseek-ai` 包里没有；renderer bundle 中也无该 id）
- 但**客户端半边照常挂载** ⇒ 原因：`lib/client.js` **不 import 任何 `@deepseek-ai/*` 包**（grep 0 命中），`dsh.client.inject` 只是**加载顺序声明**
- **决定：inject 列表保持现状，不改** —— 旧名在 0.2.0-rc.2（本插件声明的最低版本）里是真实存在的包，删掉会破坏向后兼容；留着在 0.2.1 上已被证明无害
- 自检脚本 ④ 相应从"判 FAIL"改为 **⚠️ 警告 + 实测指引**（需要硬门禁时加 `--strict-inject`）

**⑤ 待办：真机功能验证**（§六 清单，需要一次真实模型调用）：
- UI 侧：`/model` 里应能看到 zcode 分组与模型；设置页应能看到本插件卡片与额度条
- 通道侧：`node scripts/verify-appserver-channel.mjs`（**会消耗一次真实额度**；Start Plan 的 300M 活动窗口已于 10-12 09:00 结束，若报 `1005 exceed quota limit` 属**额度时序**而非故障）

---

## 一、结论速览

| 项 | 结论 |
|---|---|
| 破坏性冲突 | **0 项** |
| 必须处理 | **1 项** —— 缺 `engines.dsh` 声明 |
| 已确认兼容 | peer 范围与 pi-ai 范围**均已覆盖 0.2.1-rc.1** |
| 建议优化 | **5 项**，其中「工具动态移除」最对症 |
| 更新后风险 | **低**，但它是 4 个插件中**唯一直接站在 LLM 路由层**的，工具的 schema 语义变化需留意 |

---

## 二、插件现状（含证据）

### 包与注册

| 项 | 值 | 证据 |
|---|---|---|
| 包名 / 版本 | `dsh-connect-zcode` / `0.5.0` | `package.json` |
| 解析路径 | `node_modules/dsh-connect-zcode` → `F:\My Code\dsh-connect-zcode`（junction） | 实测 |
| 入口 | `.` → `./index.js`（57 KB） | `package.json` exports |
| 客户端 | `./client` → `./lib/client.js` | 同上 |
| bundle patch | `./cordis.patch.yml`（insert `id: zcode-connect`, `name: dsh-connect-zcode`） | `cordis.patch.yml` |
| `engines` | **仅 `node: "^22.19.0 \|\| >=24.0.0"`** —— 无 `dsh` | `package.json` |

### peerDependencies（全部为**开口向上到 `<0.3.0-0`**）

```json
"@deepseek-ai/dsh-client-ui-primitives": ">=0.1.7-rc.1 <0.3.0-0",
"@deepseek-ai/dsh-llm":                  ">=0.1.7-rc.1 <0.3.0-0",
"@deepseek-ai/dsh-llm-pi-ai":            ">=0.1.7-rc.1 <0.3.0-0",
"@deepseek-ai/dsh-settings":             ">=0.1.7-rc.1 <0.3.0-0",
"@deepseek-ai/schemastery":              ">=3.18.4 <4.0.0",
"@earendil-works/pi-ai":                 ">=0.85.1",
"react":                                 "^18.2.0"
```

**判定：`0.2.1-rc.1` 落在所有 `>=0.1.7-rc.1 <0.3.0-0` 区间内 ✅**
**判定：`@earendil-works/pi-ai ">=0.85.1"` 覆盖 0.2.1 的 `1.0.2` ✅**

### 关键接口清单

| 接口 | 位置 | 说明 |
|---|---|---|
| `ctx.llm.registerAdapter([PROVIDER_ID], adapter)` | `index.js:708` | Coding Plan 走 anthropic 通道 |
| `ctx.llm.registerAdapter([APPSERVER_PROVIDER_ID], appServerAdapter)` | `index.js:888` | Start Plan 走 app-server 通道 |
| `ctx.llm.registerModelDiscovery(settingsNs, discover)` | `index.js:741` | 模型发现 |
| `ctx.llm.registerConfigurableProviders(directoryEntries)` | `index.js:911` | 可配置提供方目录 |
| `settingsCtx.settings.configure({ auto: true }, ctx.fiber)` | `index.js:1036` | 设置 |
| `registerCard("plugins.bundle.config", BUNDLE_KEY)` | `lib/client.js:966` | 插件卡片，key = **bundle 包名** |
| 凭据路径 | `index.js:249` 默认 `~/.zcode/v2/config.json`；`543/552/565/581/954` 使用点 | **自有凭据文件，非 DSH 凭据服务** |

### app-server 通道的对话构造（**与 0.2.1 改动直接相关**）

| 行为 | 位置 | 代码 |
|---|---|---|
| 把 system 拍平成文本 | `lib/app-server.js:526`、`:531` | `parts.push(\`# 系统提示\n${system.trim()}\`)` |
| 整个会话拍平成单一 payload | `lib/app-server.js:668` | `JSON.stringify({ system: system ?? '', messages: messages ?? [] })` |
| 工具规则常量 | `lib/app-server.js:677`（`TOOL_RULE_HEAD`）、`:683`（`BRIDGE_NOTE`） | 提示模型"唯一可用的是你的原生工具，DSH 的工具在本运行时不存在" |
| **仅首轮注入** | `lib/app-server.js:1561` | `const head = session.firstTurn ? \`${TOOL_RULE_HEAD}\n${base}${BRIDGE_NOTE}\` : base \|\| '（继续）';` |

---

## 三、兼容性排查（逐条对照 0.2.1 开发者变更）

| # | 0.2.1 变更 | 是否命中 | 证据 / 结论 |
|---|---|---|---|
| 1 | 移除 `./invariant` 导出 | ❌ | 0 命中 |
| 2 | 子路径插件不再读独立 `package.json` | ❌ | 按**包名**注册；已显式导出 `./package.json` |
| 3 | 兼容性优先按 `engines.dsh` 判断 | ⚠️ **命中** | 只有 `engines.node` → P0 |
| 4 | 输入区统计拆为 `activity` / `usage` | ❌ | 本插件注册的是 `plugins.bundle.config`（插件管理页卡片）。命中的 `stats` 词条在 `lib/client.js:971`，经核为**注释**：引用官方先例 `{ id: "stats", order: 0 }` 来说明 `conversation.composer.dock` 是 list 型槽位；**实际注册的 id 是 `zcode-quota-bar`**，不覆盖官方 stats 行 |
| 5 | 移除工具展示 `both` 模式 | ❌ | 0 命中 |
| 6 | Agent Team 消息直投 Inbox | ❌ | 0 命中 |
| 7 | 子代理 child ID 统一 | ❌ | 0 命中 |
| 8 | Python PTC 沙箱服务 | ❌ | 0 命中 |
| 9 | 移除 agent-instructions 逐行 `dshHome` | ❌ | 0 命中。`lib/app-server.js:564` 的 `agent-instructions` 是**注释里罗列的 DSH 扩展条目名**（`agent-instructions` / `skill-catalog` / `model-selection`），非 API 调用 |
| 10 | pi-ai 更新至 1.0.2 | ✅ **已覆盖** | peer `>=0.85.1` 开口向上，1.0.2 满足 |
| 11 | Azure provider 改名 | ❌ | 0 命中 |
| 12 | API Key 读取优先级变更（Web/桌面优先已保存凭据） | ❌ | 扫描 `dsh-credentials` / `ctx.credentials` / `credentialService` **0 命中**；本插件读**自有** `credentialPath`（默认 `~/.zcode/v2/config.json`），不经 DSH 凭据服务 |

### ⚠️ 需留意但不构成冲突

0.2.1 的「工具立即返回 child ID」属于**工具结果契约**范畴。本插件不注册 agent 工具（它注册的是 **LLM adapter**），因此**不受影响**；但若后续想用「工具动态增删」，那正是 §五-1 的机会。

---

## 四、需要处理的项

### P1（原标 P0，已按审核降级）—— 补 `engines.dsh`（**建议项，零风险，不做也不挡升级**）

> **审核注（2026-10-17）**：本机为 junction 安装、安装器不走兼容判定，且官方明确"未声明时沿用原有规则"⇒ 不补不会坏、也不会挡升级；补的意义在"将来打包分发"。区间用 `">=0.2.0-rc.2 <0.3.0-0"` 有效（DSH 判定开了 `includePrerelease`，见 B2）。

官方原文：

> 第三方插件的版本兼容性优先按 `engines.dsh` 判断；未声明时沿用原有规则。**插件作者需检查声明是否覆盖支持的 DSH 版本。**

本插件**已经有 `engines` 字段**，只需**补一个键**：

```json
"engines": {
  "node": "^22.19.0 || >=24.0.0",
  "dsh": ">=0.2.0-rc.2 <0.3.0-0"
}
```

**影响评估**：不补不会立刻坏（peer 范围已覆盖，走原规则可放行）；补上后兼容判定显式化。

---

## 五、0.2.1 新功能带来的优化机会

### 1. 用「工具动态移除」替代提示词劝阻 ⭐ **收益最大**

**0.2.1 原文**：

> pi-ai 路由支持按模型能力处理会话中的系统提示词更新，以及**工具的动态新增和移除**。

**本插件现状**：app-server 通道下，模型的**唯一**可用工具是它自己的原生工具；DSH 的工具清单在它那边不存在。当前靠**自然语言劝阻**（`lib/app-server.js:677`）：

```js
export const TOOL_RULE_HEAD = '【工具规则 · 最高优先级】你运行在 ZCode agent 运行时，唯一可用的工具是你的原生工具…'
```

源码注释还专门解释了为什么要"首尾各一道（首因 + 近因）"—— 因为**提示词劝阻本质不可靠**。

**可做的改造**：用「工具动态移除」能力**直接把这批工具从请求里移除**，让模型"看不见"而不是"被劝住"。

**收益**：从**启发式劝阻**变成**结构性保证**，可靠性量级不同；同时可省掉 `TOOL_RULE_HEAD` + `BRIDGE_NOTE` 两段提示词的 token。

**⚠️ 前提**：该能力描述在 **pi-ai 路由**层。本插件的 app-server 通道是**自定义 adapter**（不走标准 pi-ai 工具链路），所以这条**能否落地需先确认 adapter 侧是否有对应入口** —— 属待验证机会。

**证据**：`lib/app-server.js:677–690`、`:1561`；0.2.1 Release Notes「新增功能」段。

---

### 2. 用「系统提示词动态更新」替代首轮一次性注入

**本插件现状**：`lib/app-server.js:1561`

```js
const head = session.firstTurn ? `${TOOL_RULE_HEAD}\n${base}${BRIDGE_NOTE}` : base || '（继续）';
```

**只有首轮**注入完整规则；后续轮次退化为 `base || '（继续）'`。

**可做的改造**：0.2.1 支持"按模型能力处理会话中的**系统提示词更新**"→ 可在规则需要重申时按模型能力动态重注，而不是赌"首因 + 近因"够用。

**收益**：与 §1 同源，减少规则漂移。

---

### 3. 复用官方「自定义模型推理等级」UI

**0.2.1 原文**：

> 自定义模型 API 支持通过 UI 配置各模型的推理等级，无需手动修改配置文件。

**本插件现状**：自己实现 `defaultReasoningEffort`（`index.js:178`、`:256`）、`reasoning` / `thinkingLevelMap` 映射（`index.js:424–427`）、档位选择器与能力面板。

**可做的改造**：评估能否**复用官方 UI**，省掉自建面板的维护成本。

**⚠️ 前提**：官方那条讲的是"**自定义模型 API**"（用户在 UI 里加的模型），本插件是**注册 provider**（`registerConfigurableProviders`）。两者是否同一入口**未确认**。

---

### 4. pi-ai 1.0.2 的适配器修复

**0.2.1 原文**：`pi-ai 更新至 1.0.2，包含上游模型目录更新和适配器修复。`

本插件的 Coding Plan 通道走**标准 anthropic 通道**（`ctx.llm.registerAdapter`），很可能直接受益于上游适配器修复。**零改造成本**，只需更新后回归验证。

---

### 5. 凭据来源提示与 API Key 按需显示

**0.2.1 原文**：

> 模型设置更清楚地提示凭据来源和检测状态，支持按需显示输入的 API Key。

与本插件的设置卡片功能重叠（它已自建"账号、令牌有效期、剩余积分、模型优惠"面板）。可评估是否把**凭据来源/检测状态**部分交给官方展示，减少重复。

---

## 六、更新后验证清单（可复跑）

```powershell
# 1) 两个 provider 都注册成功
#    CodePlan  : provider = builtin:bigmodel-coding-plan
#    StartPlan : provider = zcode-appserver
#    期望：模型选择器里出现两个分组

# 2) 模型发现可用
#    期望：/model 弹窗里能看到 enabledModelIds（glm-5.3 / glm-5.3-flash）

# 3) app-server 通道首轮规则注入正常
#    期望：首轮回复不出现"模型去调 pwsh/fs-local 之类不存在的工具"
#    证据点：lib/app-server.js:1561

# 4) 工具规则仍生效（发一个需要读文件的任务）
#    期望：模型用**原生** Bash/Read，不模仿 DSH 工具格式

# 5) 卡片仍渲染
#    证据：lib/client.js:966 registerCard("plugins.bundle.config", BUNDLE_KEY)

# 6) 凭据读取正常（不因 DSH 凭据优先级变更而失效）
#    期望：能读到 ~/.zcode/v2/config.json 的令牌
```

**通过判据**：以上每步有可复跑证据。任一失败时优先检查 peer 解析（`pnpm install` 是否会因 peer 范围变化而改动链接）。

---

## 附：证据来源与不确定性

| 结论 | 证据强度 |
|---|---|
| 12 项变更中仅 `engines.dsh` 命中 | **强**（全库扫描 + 逐项读码判定） |
| peer 范围覆盖 0.2.1-rc.1、pi-ai 覆盖 1.0.2 | **强**（`package.json` 字面 + semver 判定） |
| 不读 DSH 凭据服务 | **强**（`dsh-credentials` 等 0 命中 + 自有 `credentialPath`） |
| 工具规则仅首轮注入 | **强**（`lib/app-server.js:1561`） |
| 「工具动态移除」可替代提示词劝阻 | **中→弱**（能力已确认存在，但**自定义 adapter 的接入入口未确认**） |
| 官方推理等级 UI 可复用 | **弱**（官方那条讲"自定义模型 API"，与本插件的 provider 注册是否同一入口**未确认**） |

### 未做改动声明

本文档**只做排查**，未修改任何插件代码或配置。
