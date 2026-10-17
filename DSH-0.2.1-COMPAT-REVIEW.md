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

**C1. §五-1 / §五-2 收益下调（不适用）**：app-server 通道发给 agent 的真实请求体是 `buildContent()` 的**纯文本**（经 `session/send` 发出，`lib/app-server.js:1606`/`:1618`），**没有 `tools` 字段**，且本插件**不注册任何 agent 工具** ⇒ DSH 工具**本来就不在**这个 payload 里，"工具动态移除"对该通道**不适用**；"系统提示词动态更新"同理（自定义 adapter 自己拼 payload，pi-ai 路由能力不经过它）。真实可做的是**在 adapter 侧按需重写 system**——这件事现在就能做，无需 0.2.1。建议把这两条从"收益最大"降为"不适用 / 已可做"。
> **勘误（2026-10-17，经独立复核）**：本条早前把 `lib/app-server.js:668` 的 `JSON.stringify({ system, messages })` 当成"请求体"引证 —— 那其实是 `conversationFingerprint()` 的**指纹载荷**（只用于判断会话历史是否变化），不是发给 agent 的请求体。**结论不变，引证已更正**。

**C2. 新增可优化点（原文缺的）**

| # | 0.2.1 新能力 | 对本插件的用法 |
|---|---|---|
| 1 | **Session 状态记录接口**（实验性） | 把"本会话用的 provider / 令牌到期 / 剩余额度"写进 DSH 会话记录，恢复会话时直接展示 |
| 2 | **`working_directory` 工具 + SDK API** | app-server 通道的 cwd 目前自算，可改为读写官方会话工作目录，避免与宿主漂移 |
| 3 | **插件热重载 + 依赖同步** | 4 个插件都是 junction；改 client 后无需重启（注意：client 插件 HMR 仅在 `pnpm run dev:web` 时自动重载） |
| 4 | **密钥/令牌默认脱敏 + 按需显示** | ~~设置卡片的"令牌有效期"展示可复用官方脱敏~~ **不适用（勘误）**：本插件卡片**不渲染任何令牌/Key**（`lib/client.js` grep `token|apiKey|密钥|令牌` **0 命中**；状态文档零凭据，见 `lib/web-status.js` 的脱敏与只读路由）⇒ 无"自渲染明文"可治理，收益 ≈ 0 |
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

### G. 用 0.2.1 新能力做的正向优化（2026-10-17 本轮）

**已落地：ZB-42 —— app-server 会话工作目录跟随**（唯一真正对症的新能力接入）

| 项 | 内容 |
|---|---|
| 用的新能力 | **`working_directory` 服务**（0.2.1 新增「`working_directory` 工具 + SDK 会话工作目录读写接口」） |
| 旧行为（负向） | `appServerWorkspace` 默认 `homedir()`（`index.js` normalizeConfig）⇒ **ZCode agent 在用户主目录里跑**：与 DSH 会话看到的目录**语义错位**，且 agent 启动会扫该目录树（schema 描述里早有警告） |
| 新行为 | 默认跟随**当前会话**的官方工作目录（`ctx.get('workingDirectory').ensure(agent)`，`ctx.get('agents').get(sessionId)` 解析）；模型用内置 `working_directory` 工具**中途改目录也会跟随**（目录变化 ⇒ 停掉在途回合并重建 app-server 会话）；配置 `appServerWorkspaceFollow=false` 可钉回固定目录，解析器抛错/不可达回落配置值 |
| 改动 | `lib/app-server.js`（`resolveWorkspace` 依赖、`_resolveSessionWorkspace`、`ensureSession` 目录比对与重建、`_configureClient(workspace)`、entry 记 `workspace`）；`index.js`（`appServerWorkspaceFollow` 配置 + 软取解析器 `ctx.get(...)` + 一次性留痕日志） |
| 测试 | `test/selfcheck.mjs` **+9 条断言**：解析值进 `session/create`、子进程 cwd 同步、目录变化重建、同目录复用、旧条目回填不重建、`follow=false` 恒用配置、**解析器抛错回落**、**解析器确实被执行（防"没执行也绿"）**、`ctx.get` 软取静态断言 ⇒ **SELFCHECK 304/304 PASS** |
| 真机验证（待做） | 新会话启动日志应出现 `新建 app-server 会话 <id>（工作目录 <路径>）`；首轮解析留痕 `[dsh-connect-zcode] 会话工作目录解析：session=… → …`。若打印 `(服务不可达/未取到 ⇒ 回落配置目录)` ⇒ 宿主未暴露该服务，需查 `ctx.get('workingDirectory')` 可达性 |
| 未验证 | ①`ctx.get('agents')`/`ctx.get('workingDirectory')` 在本插件（`inject=['llm']`）下的**真实可达性**（自检用 stub 证明逻辑正确，但证明不了可达性）；②目录变化即重建会话会丢 agent 侧上下文（设计取舍，已在日志明示） |

**第二批（同日）：解耦 / 简化 / 压缩交互可诊断 / 热重载核查**

| 项 | 内容 | 验证 |
|---|---|---|
| **解耦：抽出 `lib/session-workspace.js`** | 原先"优先级"有两份实现（`index.js` 闭包判 `follow`+回落、`lib/app-server.js` 的 `_resolveSessionWorkspace` 又抄一份）。现在：**优先级只有一份纯函数**（`pickWorkspace`）、**宿主服务访问只有一份**（`createWorkspaceResolver`，软取 + 可注入 `getService`）、**留痕只有一份**（`createWorkspaceTracker`）；适配器只消费注入的 resolver 与纯函数，不认识 Cordis。 | 结构核对：模块仅 `import node:os`，无 `ctx.`/Cordis；`index.js` 不再直接调 `workingDirectory.*`；`selfcheck` 增加"优先级只在模块实现""宿主只接线"两条静态断言 |
| **可观测：状态文档新增 `workspace`** | 把工作目录的**最终决策**（路径 / 来源 `session`\|`config-pinned`\|`fallback` / 计数 / 时刻）回报宿主并进入状态文档 —— 这是运行时判断"`ctx.get('workingDirectory')` 到底可不可达"的**唯一**观测点。不含凭据、不缓存目录内容 | `selfcheck`：tracker 计数/最近决策断言 + 状态文档字段断言 |
| **压缩交互（0 风险版）** | app-server 通道下，任何改变历史的操作（**`/compact`**、编辑/回退、恢复草稿）都会让下一轮**重建会话 + 首轮全量拍平重放**（实测单会话 ~880KB）。原先日志只说"历史变化"；现在**点明常见诱因 + 本轮条数 + 属一次性成本尖峰** | `selfcheck`：`conversationFingerprint` 三态语义断言（追加/同输入/前缀或系统提示被改写）+ 日志文案断言 |
| **热重载核查** | 事实：0.2.1-rc.2 激活了 `@deepseek-ai/dsh-hmr`（`include:hmr` active），其服务面含 `watchConfig`/`getLinked`/`reconcileProfile`，事件含 `hmr/reload`/`hmr/change`；本插件为 junction 链接（`ReparsePoint`）⇒ 属 linked 范畴。**实证未完成**：插件状态路由只挂内嵌端口（50818/50819）且需 DSH 连接鉴权（外部请求 401），GUI 本会话无法驱动、desktop 无可读插件日志 | 标为**未验证**；给出 GUI 复跑步骤（改一行 host 日志 → 看面板状态区是否即时刷新；client 半边需 `pnpm run dev:web`） |

**第三批（同日）：独立审查驱动的强制性优化（ZB-43）**

> 触发：一个**只读审查队友**对 HEAD 做全量审查（正确性/耦合/死码/文档漂移/测试缺口/安全面），
> 交付 40+ 条带 `文件:行号` 的发现与 Top-5 清单。以下为本批已落地项。

| # | 发现（审查） | 修复 | 验证 |
|---|---|---|---|
| **1.1 P1** | **历史判据把"正常追加"当"历史改写"**：`sentFingerprint` 存整数组 hash，而 DSH 每轮传全量派生历史 ⇒ 第 2 轮起**每轮重建 + 全量重放** | 新增 `lib/history-guard.js`：`makeHistorySnapshot` + **`isPureAppend`（前缀校验）**；`stream()` 只在"前缀被改写或整体变短"时重建；删除重复的 `conversationFingerprint` 实现 | ✅ **新增"自然两轮"端到端断言**（旧实现必失败）：`creates=1 / sends=2`，且续轮内容只含最新用户消息；`/compact`（前缀改写）仍重建（`creates=2`）。⚠️ **真机两轮日志**可最终裁决（审查已标未验证） |
| **1.8 P1** | `dispatch()` 对**服务端请求**无 try/catch：异常从 stdout `data` 回调冒成未捕获异常，**可能打挂宿主** | 加 try/catch + 回写 JSON-RPC 错误，日志过 `redactSecrets` | 语法 + 既有 323 断言全绿 |
| **1.5 P2** | `suppressDeath = true` 后若 `restart/ensureSession` 抛错则**永久为真** ⇒ 之后真实死亡不再唤醒在途流（只能等 900s） | 改 `try { … } finally { suppressDeath = false }` | 同上（行为收敛，无断言依赖） |
| **1.6 P2** | 硬重启后只删当前 key ⇒ **其它会话**条目指向已死进程，下一轮先失败一次 | 硬重启分支改 `this.sessions.clear()` | 同上 |
| **1.3 P2** | 目录比对是裸 `!==`；大小写/尾斜杠/来源差异会被当成"目录变更"白白重建 | `lib/session-workspace.js` 新增 **`normalizeWorkspacePath()`**（`resolve`+`normalize`+win32 小写），比较与下发都用归一值 | ✅ 纯函数表新增"大小写/尾斜杠视为同目录"；ZB-42 断言改用归一值 |
| **3.2 / 1.7 P2** | `_configureClient(workspace)` 连调两次（第一次必被覆盖）；`appServerInjectAccount:false` 仍白等 2s | 删重复调用；`injectAccount` 返回是否真的注入，`sleep` 改为条件执行 | 自检 323 全绿 |
| **6.2 P2** | `turn.failed` 的 `payload.error.message` **原样**进日志且渲染到会话（上游可能回显 `zcodejwttoken`） | 统一过 `redactSecrets` + 截断 400 字符 | 自检现有"零明文"断言仍绿 |
| **4.x** | 文档漂移：`index.js:256` 已过期（实测 261）；README 配置表漏 `credentialFallback` / `defaultReasoningEffort`；README 与 1.1 行为矛盾 | 本批一并修正（README 配置表补齐、行为说明改写） | — |

**审查结论中的明确"不做"（附理由，避免后人重复尝试）**：
- **1.2**（旧 app-server 会话从不 `session/close`）：需先确定 ZCode CLI 3.14.5 是否有该 RPC（**未验证**）；短期以日志/计数观测替代。
- **1.4**（队列超时静默放行 ⇒ 可能双流并行）：改"真等待"会触及回合时序，属行为变更 ⇒ 留待单独一批（需真机两份证据）。
- **1.10**（账号家族漂移不重注入）、**1.12**（每回合重复读目录/凭据库 IO）、**6.1**（`keyFingerprint` 收紧为哈希指纹）、**3.3**（死字段 `lastChannel`）、**3.5**（`dispose` 未清 `activeStreams`）⇒ **已在「第四批」落地**（见下）。

**第四批（同日）：审查 backlog 续做（ZB-44）**

| # | 发现 | 修复 | 验证 |
|---|---|---|---|
| **1.10 P2** | 复用会话时只比 model/level，**不看账号家族** ⇒ 换账号（bigmodel ↔ zai）后缓存会话仍用旧 provider，而面板/目录已按新家族算档位（ZB-43 让"复用"成为常态后，这条从潜在变实际） | 条目记录 `accountProviderId`；复用前比对，变化则**重新注入账户 + setModel** 并更新条目 | ✅ 运行时双向断言：家族变化 ⇒ `setModel=1`；家族与档位都没变 ⇒ **零额外 RPC** |
| **1.12 P2** | `stream()` 每轮调 `_catalog()` **两次**（每次都读官方元数据 + 现读账号家族 = 同步磁盘 IO + 解密凭据库） | 取一次复用 | 静态（单次调用点） |
| **6.1 P2** | `keyFingerprint` 打印 `head=前8*** tail=***后4`（49 字符 key 露 12 个明文字节进宿主日志） | 改为 `sha256:<前12位十六进制>`，**零明文字节** | ✅ 既有断言改写 + 新断言（正则校验格式且不含片段） |
| **3.3 / 3.5** | 死字段 `client.lastChannel`（只写不读）；`dispose()` 收尾后未清 `activeStreams` | 删字段；`activeStreams.clear()` | ✅ 静态断言 |

**第五批（同日）：审查 1.2 根治（ZB-45）—— 旧会话真正销毁**

| # | 发现 | 处理 |
|---|---|---|
| **1.2 P2** | 丢弃本地映射时只补发 `session/stop`（通知"放弃回合"）⇒ 会话在 agent 进程里仍以 `desktop-continuous` 订阅**继续存活**，反复重建（目录变更 / 历史改写 / 失效恢复）会持续堆积 | 先**离线探明协议面**：`zcode.cjs`（14.4 MB）里 `session/*` 共 **22 个**方法，**含 `session/close`** ✓（`session/close` 字符串实测存在）。据此新增 `closeSession(entry, reason)`（best-effort：失败只告警不影响主流程），并在**目录变更重建**与**历史改写重建**两处调用 |

- 验证：`selfcheck` **330/330**（新增两条运行时断言：重建前 `session/close` 带**旧** sessionId）
- 未验证：`session/close` 的**参数形状**按兄弟方法（`session/stop`/`session/read`）推断为 `{ sessionId }`；
  best-effort 语义下即使形状不符也只是告警，不会破坏主流程（真机日志可确证）

**第六批（同日）：审查 2.2 + 1.4（ZB-46）**

| # | 发现 | 修复 | 验证 |
|---|---|---|---|
| **2.2 P2** | 赠送通道"模型 id 归一 + 上下文预算覆盖 + 兜底"在**三处**各写一遍（发现回调行 / 面板状态行 / 适配器 `_catalog`）⇒ 任何一处改口径都会让"面板显示 / 宿主看到 / 实际发送"静默漂移；另发现状态行少了一处非整数元数据兜底 | 新增 `lib/gift-catalog.js`：`normalizeGiftModelIds` / `giftContextWindow` / `giftMaxTokens`（**只统一共同口径**，各处差异字段仍留调用点；常量复用 `model-meta` 单一来源，不新造字面量）；三处 + `resolveAppServerCatalog` 全部改用 | ✅ 纯函数表（id 归一 3 例、上下文口径 5 例）+ 静态核对"旧的各自口径代码已清零" |
| **1.4 P1** | 同一会话排队等上一轮最多 60s，**超时后静默放行** ⇒ 两轮并行 → 后一轮撞 `already running` → 撞锁恢复阶梯**硬重启子进程**，把前一轮也杀掉 | `settleWithin` 改为返回"是否落定"；队列上界改为**回合超时**（上一轮的合法上界），仍不释放则**明确报错且不发送**（先释放尾锁）；排队 >60s 打 warn。宁可一次可重试的失败，也不并行污染会话 | ✅ 端到端断言：上一轮永不结束 ⇒ 抛"排队超时"且**零 `session/send`** |

**第七批（同日）：3.1 冗余导出清理（ZB-47）** —— 11 处 `export` 只在本文件内部使用（`runtimePlatformDir` / `HOST_INJECTED_TEACHING_KIND` / `TOOL_RULE_HEAD` / `BRIDGE_NOTE` / `STATIC_MODEL_NAMES` / `readPackageVersionNear` / `defaultZcodeLogDir` / `findNewestBalanceLine` / `parseBalanceLine` / `parseLineTimestamp` / `redactStatusText`），全仓库（含 test/scripts）外部引用 0 ⇒ 去掉 `export` 关键字（避免"导出但没人用"的假 API）。`selfcheck` 334/334、`compat-check` PASS。

**第八批（同日）：真机事故 ZB-48 —— `Async config validation is not supported`**

> 另一个会话在 toggle 插件时报：`zcode-connect (dsh-connect-zcode): TypeError: Async config validation is not supported`
> （DSH 0.2.1-rc.2 起**不再支持异步 Config 校验**）。

**根因（两层，均已核实）**：
1. `@deepseek-ai/schemastery` **3.18.5 把入口从 `lib/index.js` 改成 `lib/index.mjs` / `lib/index.cjs`**，
   而 `lib/host-modules.js` 的候选文件是**静态清单**（只列 `lib/index.js` / `dist/index.js` / `index.js`）
   ⇒ 候选全部落空 ⇒ Config **悄悄降级**成手写 schema（探针实测可复现"入口不可达"）。
2. 手写降级 schema 的 `'~standard'.validate` 当时写成 **`async`** ⇒ DSH 0.2.1 直接抛 TypeError（每次 toggle 必现）。

**修复（两道防线，互为兜底）**：
- `lib/host-modules.js`：解析改为**清单驱动**（新增 `manifestEntries()`，读包自己的 `package.json` 的
  `exports['.'].import/require/default` + `module` + `main` 再加载）；静态清单保留为兜底并补 `.mjs/.cjs`。
- `index.js`：`fallbackConfigSchema().validate` 改为**同步**（并导出仅供自检断言"同步"这一事实）。

**验证**：
- 新增 `scripts/probe-host-modules.mjs`（**离线**读 asar 头，零额度、不启动 DSH）→ **PROBE PASS**：
  `schemastery → lib/index.mjs（manifest）`（正是修复前落空的那条）、`dsh-llm → lib/index.js（manifest）`、
  `dsh-llm-pi-ai → lib/index.js（manifest）`、`pi-ai → dist/index.js（manifest）`；
- `selfcheck` **337/337**（+3：全链路无 `async validate`、降级校验返回**非 Promise**、清单驱动实现存在）；
- `compat-check` **COMPAT PASS**。

**待真机确认**：重载插件 / 重启 DSH 后再 toggle，该 TypeError 应消失；若仍出现，请把报错文本发来（届时说明还有第三处异步校验点）。

**最终 backlog（未做，附理由）**：**5.4/5.5**（`suppressDeath` 错误路径、账号家族漂移的**更多**断言 —— 行为已修，1.10 的断言已覆盖主路径，边界断言可后续补）；真机三项（1.1 两轮裁决 / workspace 字段 / HMR）待有额度。

**独立复核结论（另一只读分析，2026-10-17）——候选逐条：**

| 候选 | 结论 | 理由 |
|---|---|---|
| ② 工作目录跟随 | ✅ **已落地**（收益最高） | 见上 |
| ③ 插件热重载 | ✅ 可用、**零代码** | `hmr` 服务与 `hmr/reload` 事件存在；host 半边改完免重启即生效（client 半边是手写预构建 bundle，是否在 HMR watch 路径**未验证**）⇒ 建议先实测一次并写进 README |
| ⑧ `/compact` 与 app-server 交互 | ⚠️ 有真实交互，先做 0 风险版 | 手动压缩改变历史 ⇒ `conversationFingerprint` 变化 ⇒ **重建会话 + 首轮全量拍平重放**（实测单会话 ~880KB 的尖峰）；建议先补一条可诊断日志 + README 说明，再评估"不重建" |
| ① Session 状态记录 | ❌ 暂不做 | 实验性接口，且 `practices.md` 明确「不要用新 `type` 追加会话事件；`appendPluginRecord()` 仅保留给 DSH 实验包，且迁移时为 best-effort」⇒ 会污染会话日志，收益不抵风险 |
| ④ 密钥脱敏 / ⑤ 官方凭据来源提示 | ❌ 不适用 | 本插件**零敏感渲染**（见上「勘误」），且官方凭据服务看不到 `~/.zcode/v2/config.json`，与本插件"凭据零落盘零缓存"红线冲突 |
| ⑥ pi-ai 系统提示词/工具动态增删 | ❌ 不适用 | 真实请求体是纯文本（`buildContent`），不含 `tools`；插件不注册任何 agent 工具 |
| ⑦ 工具"准备阶段"进度 | ❌ 不适用 | 本插件不注册工具；app-server 通道 DSH 工具调用实测为 0 次 |

**文档勘误（本轮自查 + 复核发现）**：① §C1 早前把 `conversationFingerprint` 的指纹载荷当成"请求体"引证（结论不变，引证已更正）；② §五-5 称本插件卡片已自建"令牌有效期"面板（与代码不符，已更正）；③ §五-4/5 相应从"建议优化"下调为"不适用"。

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

~~与本插件的设置卡片功能重叠（它已自建"账号、令牌有效期、剩余积分、模型优惠"面板）。可评估是否把**凭据来源/检测状态**部分交给官方展示，减少重复。~~
> **勘误（2026-10-17，经独立复核）**：原文称本插件卡片已自建"账号、**令牌有效期**、剩余积分、模型优惠"面板 —— **与代码不符**。本插件卡片实际展示的是：provider 注册态 / 冻结开关 / 端点 host（仅 host，不含路径与凭据）/ 赠送额度 / 最近一次调用；`lib/client.js` 对 `token|apiKey|密钥|令牌` **0 命中**，状态文档亦零凭据（`lib/web-status.js`）。⇒ 与官方"凭据来源/检测状态"**功能不重叠**，本条优化不成立（保持本插件"凭据零落盘、零渲染"的红线）。

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
