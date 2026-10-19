# dsh-connect-zcode

**把 ZCode（Z.ai / 智谱 BigModel）作为模型通道接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）** —— 让 DSH 直接消费你的 ZCode 套餐额度。

**只保留 Coding Plan 通道**（provider `zcode`，anthropic-messages 线协议，**DSH 自己发模型请求**；
凭据零落盘、每次调用现读）。

> 原「Start Plan / 活动赠送额度」通道（托管 `zcode.cjs app-server` 代发请求）因**接入不完整**，
> 已于 2026-10-17 **下线并从代码中删除**（适配器 / 额度读取 / 进度条 / 面板区块 / 相关配置项全部移除）。
> 需要"agent 自主执行任务 + 免费额度"的场景，用姊妹项目
> [派发台（zcode-dispatch）](https://github.com/Shuffle-1992/zcode-dispatch)。

一个 DSH 原生 provider 插件，**两条互补通道**：

```
provider id : zcode
线协议       : anthropic-messages
谁发模型请求 : DSH 自己
端点         : ~/.zcode/v2/config.json 的 baseURL
凭据         : 零落盘、零缓存、每次调用现读
适用         : Coding Plan（付费套餐）
```

---

## 它解决什么问题

ZCode 桌面端自带一个 agent（有自己的 loop、子代理、记忆）。但很多时候你**只想要它的模型额度**，用**你自己的** harness —— 复用 DSH 的工具链、会话、审批、团队协作等。

本插件做这件事：从 ZCode 的配置文件里读出套餐凭据，在 DSH 里注册成一个标准 LLM provider。

### 为什么不直接抄 API Key 去调

因为**不同套餐的凭据形态根本不同** —— 这是本项目最核心的发现：

| 套餐类型 | 凭据形态 | 能否直连 |
|---|---|---|
| **Coding Plan**（付费套餐） | 一等 API Key（zhipu 平台 `id.secret` 格式），存于 `config.json` 或**加密凭据库** `credentials.json` | ✅ **可以** —— 走标准 Anthropic 兼容端点（本插件 `zcode` provider） |
| **Start Plan**（赠送/活动额度） | 账户 **JWT** + 端点要求**逐请求的客户端证明** | ❌ 不能直连（上游风控 3012）；该通道**已下线**（接入不完整） |

> **历史注记**：Start Plan 直连实测被上游风控拦成 `HTTP 405 {"code":3012,"msg":"request has been blocked due to unusual activity."}`
> （带不带验证码头都一样）—— 这也是当初改用"托管官方 agent 代发"的原因。该通道已于 2026-10-17 下线，
> 排查过程保留在 [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) 第一章（仅作历史参考）。
> **Coding Plan 的 Key 有两个存放位置**（这很关键，见「故障排查」）：
> - `~/.zcode/v2/config.json` → `provider["builtin:bigmodel-coding-plan"].options.apiKey`（**明文**）
> - `~/.zcode/v2/credentials.json` → `account-provider:coding-plan:...:api-key`（**加密** `enc:v1`）
>
> **OAuth 重新登录后，ZCode 只更新后者、不回写前者** —— 于是读 `config.json` 的工具集体 401。

> 实测（Coding Plan）：`GET /v1/models` 与 `POST /v1/messages`（`max_tokens:1`）均 **HTTP 200**；
> 认证头 **`x-api-key` 单头即充分**，`anthropic-version` 非必需。

---

## 前置条件

1. **ZCode 桌面端已登录 Coding Plan**
   在 ZCode 里执行 `/login bigmodel-coding-plan`（OAuth 或手工粘贴 Key 均可）。
   校验：`~/.zcode/v2/config.json` → `provider["builtin:bigmodel-coding-plan"]` 的
   `enabled: true` 且 `options.apiKey`（非 `ey` 开头的 JWT）、`options.baseURL` 非空。

2. **DSH 桌面端**（Electron）正常运行。
   插件运行时从宿主 `app.asar` 内嵌 `node_modules` 动态解析 `pi-ai` / `dsh-llm-pi-ai` / `dsh-llm`。
   若解析不到，用环境变量 `ZCODE_CONNECT_MODULES_ROOT` 指向含这些包的 `node_modules` 根，或
   用 `ZCODE_CONNECT_DSH_RESOURCES` 指定 DSH 的 resources 目录，改后重启 DSH。

---

## 安装

**从 GitHub 仓库安装（推荐）**——本包**未发布到 npm**，请用 pnpm 的 git 规格：

```bash
dsh plugin --profile desktop add github:Shuffle-1992/dsh-connect-zcode
```

> 用 `web` profile 的把 `--profile desktop` 换成 `--profile web`。
> 需要固定版本时用 git 标签：`add github:Shuffle-1992/dsh-connect-zcode#v0.4.0`。

### 从源码安装（开发者）

```bash
git clone https://github.com/Shuffle-1992/dsh-connect-zcode.git
dsh plugin --profile desktop add /absolute/path/to/dsh-connect-zcode
```

手动 link 式安装（不用 dsh CLI 时）：编辑 profile 的 `package.json`
（如 `~/.dsh/profiles/desktop/package.json`）：

```jsonc
{
  "dependencies": {
    "dsh-connect-zcode": "link:/absolute/path/to/dsh-connect-zcode"
  },
  "dsh": {
    "profile": {
      "bundles": [ /* … */ "dsh-connect-zcode" ]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install`（link 依赖只建符号链接），重启 DSH ——
模型选择器应出现 `zcode` 分组。

### 验证

```bash
node test/selfcheck.mjs     # 应输出 SELFCHECK PASS：N/N，exit 0（N 随断言增加而变，不写死）
```

### DSH 版本兼容性（0.2.1 适配）

本插件在 `package.json` 声明了 **`engines.dsh: ">=0.2.0-rc.2 <0.3.0-0"`** —— DSH 0.2.1 起，
第三方插件的版本兼容性**优先按 `engines.dsh` 判断**（DSH 的判定使用 `includePrerelease` 语义，
预发布版本如 `0.2.1-rc.1` 也能匹配，故无需为每个 rc 改区间）。

**升级 DSH 前后各跑一次兼容自检**（离线、零依赖、不读凭据、不 spawn）：

```bash
node scripts/compat-check.mjs                      # 自动探测本机 DSH（读 app.asar）
node scripts/compat-check.mjs --dsh-version 0.2.1-rc.1   # 升级前**预演**目标版本
node scripts/compat-check.mjs --json               # 机器可读
node scripts/compat-check.mjs --self-test          # 只跑内置 semver 自测
```

输出末行 `COMPAT PASS` 即兼容（exit 0）；`COMPAT FAIL` 会指明失败项。检查项：

| # | 检查 | 说明 |
|---|---|---|
| ① | `engines.dsh` | 当前 DSH 是否落在声明区间（按 DSH 的真实判定语义） |
| ② | `engines.node` | 当前 Node 是否在支持区间 |
| ③ | `peerDependencies` | 同时报告 pnpm 默认语义与 DSH 语义（见下方说明，**不单独判失败**） |
| ④ | `dsh.client.inject` | 声明模块在**当前 DSH 运行时**能否解析（包或路径）；0.2.1 合并内部 UI 包后可能报 ⚠️，见下方说明 |
| ⑤ | 清单契约 | `dsh.bundle.patch` 文件存在、`cordis.patch.yml` 为标准 `insert` 结构、`exports` 含 `./package.json`（0.2.1 子路径规则） |
| ⑥ | semver 自测 | 内置判定器对 10 组经 Node semver 7.8.4 实测过的用例（防自检自身算错） |

> **关于 ③**：`peerDependencies` 的区间是按"稳定版语义"写的（`>=0.1.7-rc.1 <0.3.0-0`），在 pnpm 的**默认**语义下对预发布 DSH 版本会显示"不满足"——本机是 **junction 链接安装**、DSH 自身的兼容判定又使用 `includePrerelease` 语义，因此**不构成阻塞**；脚本以 ℹ️ 报告该差异而不是判失败。
>
> **关于 ④**：DSH **0.2.1 合并了部分内部 UI 包**（`dsh-client-ui-slots` / `dsh-client-ui-primitives` 已不再作为独立包存在）。本插件的客户端代码**不 import 任何 `@deepseek-ai/*` 包**，`inject` 仅作客户端**加载顺序**声明，故**无影响**（0.2.1-rc.2 实测：`plugins.bundle.config` 注册点正常挂载）。> 这两条死条目**评估后保留**：DSH 0.2.0 系列仍以独立包提供它们，而"删除后是否影响 `slots` 服务激活"无法离线验证 —— 为一条信息性警告冒面板挂载风险不划算。> 该声明需要当硬门禁时用 `--strict-inject`。
>
> 0.2.1 的 12 项破坏性变更对本插件**0 命中**；升级后实测记录（含 client 插槽 occupant 证据）见 [`DSH-0.2.1-COMPAT-REVIEW.md`](./DSH-0.2.1-COMPAT-REVIEW.md) §F。

#### 用 0.2.1 新能力做的正向优化

| 优化 | 用的新能力 | 行为变化与验证 |
|---|---|---|
| **热重载（迭代提速）** | `hmr` 服务（`include:hmr` 已激活，含 `hmr/reload`/`hmr/change` 事件与 `getLinked`/`reconcileProfile`） | 本插件是 **junction 链接**的本地插件，属其 "linked" 范畴 ⇒ host 半边改动**理论上免重启**；**实证未做**（本会话无法驱动 GUI：插件状态路由只在内嵌端口且需 DSH 连接鉴权）——请在 GUI 里验证一次：改一行 host 日志 → 看面板「状态」区是否立即刷新（client 半边是手写预构建 bundle，需 `pnpm run dev:web` 才会自动重建）。**不改代码也有保证**：`test/selfcheck.mjs` 离线覆盖逻辑、`scripts/compat-check.mjs` 覆盖声明兼容性。 |

> 逐条候选评估（含**明确不做**的项：Session 状态记录、密钥脱敏、pi-ai 工具动态增删…）见 [`DSH-0.2.1-COMPAT-REVIEW.md`](./DSH-0.2.1-COMPAT-REVIEW.md) §G。

---

## 配置

插件 config（`cordis.patch.yml` 或 profile 覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `planKey` | `builtin:bigmodel-coding-plan` | 只接的套餐条目 |
| `contextWindow` | `200000` | 基础上下文窗口（CLI 实测有效 200k；config 名义 1M 不默认采信，仅作官方 Max 档可选） |
| `maxConcurrent` | `2` | 并发推理上界（1..2） |
| `credentialPath` | 空 = `~/.zcode/v2/config.json` | ZCode 配置路径 |
| `switchPath` | `~/.dsh/dispatch.switch.json` | 冻结开关真值文件（缺文件/损坏 = 开启） |
| `ledgerPath` | `~/.dsh/dispatch-runs.jsonl` | 额度台账（追加写） |
| `enabledModelIds` | `[]` | **模型显隐勾选（设置面板写入）；空 = 全部显示**，非空 = 只显示列出的 id |
| `contextBudgets` | `{}` | **上下文预算（T22，面板写入）**：模型 id → 官方 Max 档值（1000000）；缺省 = 200K |
| `modelOverrides` | `{}` | **无官方数据模型的开关（T22，面板写入）**：`{reasoning?, image?}`；官方数据锁定的模型忽略此项 |

环境变量（覆盖默认值）：

| 变量 | 作用 |
|---|---|
| `ZCODE_CONNECT_SWITCH_PATH` | 冻结开关路径 |
| `ZCODE_CONNECT_LEDGER_PATH` | 台账路径 |
| `ZCODE_CONNECT_MODULES_ROOT` | 宿主 LLM 栈的 `node_modules` 根 |
| `ZCODE_CONNECT_DSH_RESOURCES` | DSH 的 `resources` 目录（asar 兜底） |

---

#### 上下文窗口到底是谁声明的（200K vs 1M）

这三个数字来源不同，**不要混为一谈**（2026-10-17 实测核对）：

| 数字 | 谁说的 | 怎么来的 |
|---|---|---|
| **1M**（`limit.context=1000000`） | **ZCode 自己** | `~/.zcode/v2/config.json` 的 `provider[planKey].models` 段（ZCode 客户端维护）；网关 API **不声明**上下文长度 |
| **200K**（插件默认） | **本插件** | `contextWindow` 配置默认值（保守）；依据是项目早期实测「CLI 会话在 200k 附近开始压缩」。**CLI 里并没有 `200000` 这个常量** |
| 实际可用上限 | **上游** | 只能靠真实长上下文请求探测：`GET /v1/models` 不返回 context 字段（已实测），报错时才可能带上限 |

> **注意**：默认值只在"没有手动选档"时生效。面板里把模型切到 **1M**（写入 `contextBudgets`）后，
> 插件给 DSH 声明的 `contextWindow` 就是 1,000,000 —— **此时已经是在用 1M，不需要改代码**。

**谁在执行这个限制**：Coding Plan 通道是 `插件 → pi-ai → 网关 HTTP`，**CLI 完全不参与**。插件只是把
`contextWindow`（默认 200K；面板勾 1M 时为官方声明值）**声明给 DSH**，DSH 据此决定何时压缩/拒绝请求。所以：

- 选 **200K**：DSH 接近 200K 就压缩 —— 保守，不会撞上游；
- 选 **1M**：DSH 按 1M 管理、不会提前压缩 —— 若上游实际只有 200K，表现为「接近 200K 后上游报错/截断」，DSH 侧不会预警。

> **用户实测（2026-10-17）**：在 1M 档下实际使用过，未见问题（但未做 >200K 的边界实测 ⇒ 严格说只证明"1M 声明没立刻被拒"）。
> 想钉死边界时跑 `node scripts/probe-context-limit.mjs`（**需额度**：一次约 20.5 万输入 token；
> 成功 ⇒ 窗口 ≥ 该值；失败报错里通常直接写明真实上限）。
> 零成本复核：`node scripts/probe-context-declared.mjs`（只发 `GET /v1/models`，不推理、不耗额度）——
> 打印网关响应里所有与 context/window/token 相关的字段（实测：**一个都没有**）。

---

## 设置面板（T21 显隐 + T22 能力行控件）

> 想让**自己的插件**也有一块能正确显示、且保存真生效的面板？见 [`PANEL-HOWTO.md`](./PANEL-HOWTO.md)（清单 / 信封 / 槽位 / settingsNs 四处必配，外加「面板一直不显示」10 条排查表）。

DSH 插件设置页的本 bundle 卡片（slot `plugins.bundle.config`，key = 包名）提供**最小可用面板**：

- **模型行布局（T22，一行一模型）**：显隐勾选 + 名称（网关 `display_name`）+ `·官方` 徽标
  + 图片开关 + 200K/1M 单选 + 推理档展示或推理开关：

  ```
  [✓] GLM-5.3       ·官方  图片  ◉200K ○1M   推理档: low / max / high（官方，锁定）
  [✓] GLM-5.3-Flash ·官方  ☑图片 ◉200K ○1M   推理档: low / max / high（官方，锁定）

  ```

- **5.3 系过滤（T22）**：目录（网关与静态表）先按**显式集合**
  `{glm-5.3, glm-5.3-flash}` 过滤（大小写不敏感）——网关其余 9 个
  模型（glm-5.2/5.1/5/5-turbo/4.7/4.6/4.5/4.5-air）不再暴露；不用模糊前缀，
  防未来网关多出 `glm-5.3-pro` 之类被误放行。
- **锁定 vs 开关的判定来源（T22）**：ZCode config.json `provider[planKey].models` 段
  （ZCode 官方写入，与 GUI 同源——网关 `/v1/models` 与 bigmodel 标准 API 均零元数据）。
  - **有官方数据**（GLM-5.3 / GLM-5.3-Flash）：`·官方` 徽标；推理档（low/max/high）
    与输入模态**只展示、不可勾改**（disabled 控件）；Flash 的图片随官方 modalities
    **默认勾选且锁定**（官方声明含 image/video，原样保留）；GLM-5.3 官方纯文本，
    图片不可开。
  - **无官方数据**（未来的新模型）：推理与图片提供**开关**（默认关，开启后果自担）。
- **200K / 1M（T22）**：每行默认 200K；**仅官方声明 1M 上下文（`limit.context=1000000`
  高于基础档）的模型**才出现 1M 单选。勾选写入 `contextBudgets`，host 侧
  `applyContextBudgets` **只允许切到该模型官方声明的 Max 档**（trae :246-251 同语义）——
  无官方 Max 档的模型无论写什么值都不生效，面板也不提供 1M 选项（用户无路径写入）。
  ⚠️ **实测差异**：1M 是 ZCode config 的官方声明值；CLI 实测有效窗口 200k、压缩发生在
  200k 附近（T18/PROTOCOL §5.2）——照官方值上，面板内已注明此差异。
- **显隐勾选（T21）**：语义与 trae 一致——**`enabledModelIds` 空 = 全部显示**
  （默认全开）——没配置过的用户照常看到全部模型，不会因为升级而突然一个模型都没有；
  非空 = 只显示列出的 id。快捷操作：「全选」「全不选（=全部显示）」「恢复默认」
  （后两者等效，都写回空数组；区别仅在「全选」会把当前目录逐个显式列出——此后新增的
  动态模型默认**不**显示）。
- **概览区**：模型总数 / 已启用数 / **上下文预算（N 个模型已切 1M，T22）** /
  provider 注册态 / 开关状态 / 端点 host / 最近一次调用摘要。
- **开关联动**：冻结期（开关 `enabled:false`）面板顶部显示醒目提示
  「套餐冻结中：provider 调用与派发均被拒」。
- **保存**：一次写入 `enabledModelIds` + `contextBudgets` + `modelOverrides` 三个字段，
  每个**写后回读校验**（`set()` resolve ≠ 真存进去了，trae 实证教训），失败给可操作错误；
  有官方数据的模型上的覆盖条目（无效配置）保存时清理并在结果消息中提示条数
  （状态路由缺席时面板不做不可判定的清理，防误删用户配置）。

只读状态（冻结态/台账/注册态/全量目录+能力事实）经 host 半的**回环路由**
`GET /plugins/dsh-connect-zcode/status` 提供：GET-only、Host 与 Origin 都必须回环、
响应零凭据（端点只出 host、台账出站脱敏；能力事实为静态目录信息，不含凭据）。
该路由缺席时面板自动降级：概览显示「未知」，勾选列表回退静态表（3 个 5.3 系，
无徽标/无 1M 选项），保存不受影响。

**写入后如何生效**：保存写入插件配置（volatile 字段）；host 半监听
`loader/volatile-update` 事件重导模型目录（与 trae 同机制）。**该联动尚未真机实测**——
若宿主在面板保存后不派发该事件，则需重启 DSH 生效（以 Lead 实测结论为准，此处按机制如实说明）。
另：动态发现的新模型要在面板出现，前提是状态路由已返回过一次目录（面板以最近一次目录为准）。

面板文案为中文常量（最小面板不做 i18n；少依赖一个 locale 服务，少一分启动失败面）。

### 字段映射（T22：ZCode 官方元数据 → trae 目录行形状）

| ZCode config `models` 段 | 目录行 / pi 行字段 | 说明 |
|---|---|---|
| （键，大小写不敏感匹配网关 id） | `id` / `official` | 官方命中 = `official:true`（锁定态来源） |
| `limit.context` | `maxContextWindow`（仅当高于基础档） | 1M 选项判定来源；经 `applyContextBudgets` 生效 |
| `limit.output` | `maxTokens` | 128000（与原 FALLBACK 一致） |
| `reasoning.variants` | `reasoningEfforts` + `thinkingLevelMap` | 枚举映射：`low→light`、`xhigh→extra_high`、**`max→high`** |
| `reasoning.defaultVariant` | （不落 pi 行） | DSH 侧档位选择由宿主管理，插件不预设 |
| `modalities.input` | `input`（官方行锁定，原样保留） | Flash = `["text","image","video"]`（video 为官方声明、未实测） |
| （无官方数据） | `contextWindow=200000`、`input:['text']` | 推理开 → `reasoningEfforts:{high:'high'}`（单档，宁缺勿滥） |

**`max→high` 映射决策**：trae :233 的枚举映射函数是 `low→light`、`xhigh→extra_high`、
**其余一律→high**——ZCode 的 `max` 不在显式枚举表，落 else 臂即 `high`。选它而非
`xhigh→extra_high`：这是 trae 自身代码对未知档位的既有处置，`high` 是 5.3 系已实证的
wire 枚举值，不发明新映射。

---

## 设计要点

- **凭据零落盘、零缓存、零日志**：每次调用现读 ZCode 配置，返回值只在内存。
  ⇒ 你在 ZCode 里换 Key，本插件**自动跟随**，无需重启、无需改配置。
- **双来源凭据 + 验活回退（方案 B，2026-10-01）**：ZCode 在 **OAuth 重新登录**后会把新
  API Key **只写进加密凭据库** `~/.zcode/v2/credentials.json`、**不回写 `config.json`**，
  于是所有读 `config.json` 的程序一起 401（**连 ZCode 自己的 Agent CLI 也 401**）。
  本插件因此支持第二来源：`config.json` 优先，**验活失败**时自动回退到凭据库候选
  （解密 `enc:v1` → 逐把验活 → 取第一把通过的）。**必须验活才切换**；全部失败则沿用原值。
- **不发送任何不应发送的东西**：除套餐端点外无出站请求；登记台账前对错误摘要做**密钥形态脱敏**。
- **额度冻结开关**：`switchPath` 文件里 `enabled:false` ⇒ 每次实际调用前抛错拒绝
  （连 `GET /v1/models` 也不发）。默认路径不存在 ⇒ 视为开启，未部署开关的场景零配置可用。
- **并发预算 N=2**：超限在插件侧排队，**不自动升限**。
- **client 半（T21）与防拒启不变量**：`package.json` 的 `dsh.client` 声明与 `lib/client.js`
  **必须同生同灭**——声明了 client 却缺文件/加载失败，DSH 会**拒绝启动**
  （`ClientPackageCompositionError`，启动后几秒自行退出）。因此：`lib/client.js` 是自足的
  预构建 bundle（`__ModuleLoader__.load` 信封，与 trae 同款；无构建步骤、无外部 import），
  其 `apply()` 整体 try/catch、失败只 `console.error` 绝不抛；自检含
  「manifest 与文件一致性」断言守护该不变量。
- **volatile 写入门禁**：`enabledModelIds` / `contextBudgets` / `modelOverrides` 三个面板
  写入字段均带 schemastery `.volatile()` 标记——
  0.1.7 的设置写入门禁要求条目含 volatile 字段，缺了它面板每次写入都被**静默拒绝**
  （`set()` 照样 resolve，trae 实证注释）。若运行时 schemastery 解析不到而走了手写降级
  schema，面板保存会收到明确报错（降级路径无法表达 volatile 标记，属已知限制）。
- **启动安全**：`apply()` 同步不抛；注册以「凭据有效」为前提，凭据不可用时**不注册任何入口**、
  只留可操作错误日志，绝不拖垮宿主。

## 故障排查：报「身份验证失败 / 密钥无效」

> **一句话结论**：这**几乎总是 ZCode 侧的凭据同步问题，不是本插件的 bug**。
> 典型场景：你在 ZCode 里**退出登录 → 删密钥 → 改用 OAuth 重新授权**，此后
> **ZCode 只把新 Key 写进加密凭据库、不回写 `config.json`**，而 `config.json` 里留着
> **已失效的旧 Key** ⇒ 一切读 `config.json` 的程序集体 401，**连 ZCode 自己的 Agent CLI 也一样**。

### 第 1 步：判断是不是 ZCode 侧的问题

- **ZCode 桌面端自己还能正常对话吗？** 若 GUI 也不通 → 在 ZCode 里重新登录。
- **看两个文件的修改时间**（最快的判据）：
  - `~/.zcode/v2/credentials.json`（凭据库，随登录更新）
  - `~/.zcode/v2/config.json`（插件与 CLI 读它）

  若前者很新、后者停在很早以前 ⇒ **基本可判定是失配**。

### 第 2 步：跑恢复工具（推荐，一次修好所有工具）

```bash
node scripts/sync-key-to-config.mjs --dry-run   # 只诊断，不写入
node scripts/sync-key-to-config.mjs             # 验活通过才写回（写前自动备份）
```

典型输出（真机实测）：

```
[sync-key] 现状 key head=a4b54fc1*** tail=***p4vU → ❌ 无效（HTTP 200 但 body: code=1000 身份验证失败。）
[sync-key]   候选 bigmodel-team-coding-plan        head=a4b54fc1*** → ❌ HTTP 200 但 body: code=1000 身份验证失败。
[sync-key]   候选 bigmodel-individual-coding-plan  head=852f2f9d*** → ✅ 11 个模型
[sync-key] 选定：bigmodel-individual-coding-plan
[sync-key] 已备份 → config.json.bak-dsh-<时间戳>
[sync-key] 回读校验：✅ 一致
```

> 💡 **为什么建议"把密钥写回 `config.json`"**：该工具修的是 **`config.json` 本身**，
> 而 ZCode CLI、其他项目、任何读 `config.json` 的工具**都依赖它** —— 所以这一步能
> **一次性恢复全部工具**。插件内建回退（方案 B）只覆盖本插件自己。
> **遇到问题先跑它止血，再谈别的。**

该工具的安全边界：**只在验活通过后才写入**；全部候选都无效则**拒绝写入**（绝不做无依据修改）；
写前自动备份、写后回读校验；**全程不打印 key 原文**（只打指纹）。

> ⚠️ **验活的陷阱（务必记住）**：bigmodel 网关对**失效 key** 的 `GET /v1/models`
> 也返回 **HTTP 200**，body 却是 `{"code":1000,"msg":"身份验证失败。","success":false}`。
> **只看状态码会把无效 key 判为有效** —— 判断必须校验响应体
> （`data` 非空 且 `success !== false`）。

### 第 3 步：仍不通时

见 **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** —— 那里系统整理了本插件开发过程中
**在真机上踩过的全部坑**（含误判、假绿、以及每个坑的判据与修法）。

---

## 与「派发模式」的关系

ZCode 有两条消费路径，**互补而非替代**：

| | 派发模式（外部脚本） | **provider 模式（本插件）** |
|---|---|---|
| 谁执行 agent loop | ZCode 自己（子代理扇出、目标自续跑、项目记忆） | **DSH 自己** |
| 适用 | 无人值守长任务、批量委派 | 交互式对话、DSH 工具链/团队协作 |
| 额度 | 同一个套餐资源包 | 同一个套餐资源包 |

> ⚠️ 两者**共享同一份额度**。注意套餐有**滚动窗口上限**：撞顶时所有经该套餐的调用一律
> `HTTP 429`（`[1308] 已达到 5 小时的使用上限`），直到窗口重置。

> **落地形态（推荐）**：上表的"派发模式"现在有现成实现 —— 姊妹项目
> [**派发台（zcode-dispatch）**](https://github.com/Shuffle-1992/zcode-dispatch)：DSH 插件 + 悬浮面板 +
> agent 工具 `zcode_dispatch`，把任务派给**独立 ZCode 进程**（它用自己的原生工具、独立会话），
> 并带单写者文件锁、用量台账、暂停分类（额度耗尽/未开通/需签名）、自动降级链、任务落地自动唤醒。
> **它同样支持免费额度通道**（`--provider start-plan` / 通道 `account:<family>-start-plan`，
> 台账 `billing=zcode-plan-gift` 与付费套餐分账；面板有额度条，agent 派发前能看到剩余额度）。
> 所以"**要工具 + 要免费额度**"的组合，答案是派发台而不是本插件的 provider 通道（本插件只做纯模型通道）。

---

## 自检

```bash
node test/selfcheck.mjs      # 全绿=exit 0（断言数见输出末行，勿在文档里写死）
```

纯静态 / 单元测试：**不产生任何网络请求**（`fetch` 全程投毒）、**不读真实凭据内容**
（凭据与官方元数据均用 tmp fixture）、产物零明文扫描。T21 新增：manifest 与 client 文件一致性
（防拒启生命线）、client 半 stub 行为断言（apply 不抛、卡注册、双视图渲染）、过滤语义与
状态文档单测。T22 新增：5.3 系显式集合过滤（11→3）、官方元数据归一/合并/锁定、
用户开关与上下文预算（非官方 Max 档写入被忽略）、trae 形状完整性（每行正整数
contextWindow + `reasoningEfforts` 枚举映射含 `max→high`）、host 管线（带预算/开关的
provider.models 输出）、面板行控件（锁定 disabled、1M 按官方数据显隐、`·官方` 徽标）。

---

## 已知限制

1. 上下文窗口：基础档保守声明 200k（CLI 实测有效窗口）；1M 为 ZCode config 官方声明值，
   仅官方 Max 档模型可选（勾选后 `contextWindow` 按官方值声明，实测有效窗口仍以 CLI 为准）。
3. 模型能力声明（T22）：官方行按 ZCode config `models` 段如实声明（Flash 的
   `input` 含 image/video——**video 为官方声明、未实测**；无官方数据的行默认纯文本，
   推理/图片由用户开关显式开启）。推理档的 wire 下发（thinkingLevelMap / effort 枚举）
   与图片上传链路**均未真机实测**——若网关拒绝对应参数，以运行时表现为准回退。
4. 端点 `baseURL` 在激活时读取一次；套餐端点变更需重启 DSH。
5. 推理链路已于 T20 在真机（DSH 桌面端）跑通；**设置面板（T21）与模型元数据/行控件
   （T22）尚未真机验证**——面板出现、三项保存、`loader/volatile-update` 联动、
   官方徽标/1M 档/锁定控件的实际渲染，待重启后由 Lead 确认。
6. 面板勾选列表以「最近一次目录快照」为准：状态路由不可用时回退静态表（3 个 5.3 系，
   无徽标/无 1M 选项，保存时的无效条目清理暂停以防误删），动态发现的模型要等状态恢复
   才出现在面板里（模型选择器不受此影响，仍按 host 过滤后的目录显示）。
7. 面板文案中文常量，无 i18n。
8. 网关未来新增的 5.3 系模型（如 `glm-5.3-pro`）不在显式集合内，**不会**自动暴露；
   需更新 `GLM53_FAMILY`（lib/model-meta.js）——这是防误放行的刻意取舍。
   网关返回数量与保留数量的差异会打进日志（`目录发现` 前缀），便于发现上游已新增模型。
9. **每次推理调用都会先做一次凭据验活**（零落盘零缓存红线的直接推论）：正常路径
   额外 1 次轻量 `GET /v1/models` 往返（约 100–500ms，相对流式推理总时长占比很小）；
   若 `config.json` 里的 Key 已失效且凭据库回退开启，最坏为 **1+N 次串行验活
   （每次超时 8s）** 后才沿用原值——失效期的表现是"每次对话先卡若干秒"。这是红线的
   既定代价（不缓存 Key 本身），**不建议用缓存修**：缓存会引入"Key 被吊销后仍可用 N 秒"
   的新窗口。可用 `credentialFallback: false` 关掉回退以缩短最坏路径（代价是不再自动跟随
   凭据库）。
10. 宿主升级后 `dsh-llm-pi-ai` / `pi-ai` 的读取点若变化，会导致附件/图片/凭据能力**静默失效**。
    启动日志会输出宿主栈版本（`宿主 LLM 栈：pi-ai=… / dsh-llm-pi-ai=…`）并做 C5 形状自检
    （未通过时告警），**升级 DSH 后请先看这两行**。

## 免责声明

- 本项目**不是** Z.ai / 智谱官方项目，与官方无关联。
- 它通过读取**你本机已登录的 ZCode 客户端配置**来复用你自己的套餐额度。请自行确认这符合
  你所同意的服务条款；相关风险（含账号风控）由使用者自负。
- 本项目**不破解、不绕过**任何验证机制：`zcode` 通道只接凭据本身就是标准 API Key 的套餐形态，
  不伪造设备指纹、不模拟验证码。（原「托管官方 agent」通道已下线并删除。）
- 请勿提交任何凭据。仓库内不含、也不会要求你提供任何密钥。

## License

[MIT](LICENSE)
