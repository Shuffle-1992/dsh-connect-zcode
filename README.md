# dsh-connect-zcode

**把 ZCode（Z.ai / 智谱 BigModel）作为模型通道接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）** —— 让 DSH 直接消费你的 ZCode 套餐额度。

**✅ 支持免费额度模式**：ZCode「Start Plan」的活动赠送额度（如 Weekend Build 的免费 GLM-5.3-Flash）可以直接在 DSH 里用 —— 通过托管官方 agent 代发请求，零破解、零凭据落盘（见 [Start Plan 通道](#start-plan-通道app-server)）。

> ⚠️ 免费额度通道是**模型对话通道**：DSH 的**工具层在这条通道上不参与**（agent 用自己进程内的原生工具）。
> 上哪些能力能用、哪些完全没有（浏览器面板 / Agent Teams / 派发台 / `ask_user_question` / TODO …），
> 以及各类替代做法，见 [**免费额度通道目前缺失的功能速查**](#-免费额度通道zcode-appserver目前缺失的功能速查)。
>
> ✅ **要让 agent 自主用工具干活、又要烧免费额度 ⇒ 用姊妹项目 [派发台（zcode-dispatch）](https://github.com/Shuffle-1992/zcode-dispatch)。**
> 它现在也支持免费额度通道（`account:<family>-start-plan`：面板有**额度条**、agent 派发前能看到剩余额度与窗口剩余时间、
> 台账按 `billing=zcode-plan-gift` 与付费套餐分账），而且**"走 ZCode 自己的工具"在派发台是设计而非缺陷** ——
> 那里本来就是"**独立 ZCode 进程 + 它自己的工具 + 独立会话 + 独立额度**"。
> **已在真机验证**（2026-10-11，见派发台 `tasks/ZB-34-gift-tool-parity.md`）：Write/Edit、Bash、
> 本地 MCP（`node_repl`）、远程 MCP（`web_reader`）**全部可用** —— 即派发台那条免费额度通道的
> **工具执行能力与付费套餐派发实测等同**。
> **一句话选型：纯模型对话 / 要 DSH 自己的工具链 ⇒ 本插件；要 agent 自主执行任务 ⇒ 派发台。**

一个 DSH 原生 provider 插件，**两条互补通道**：

```
provider id : zcode              provider id : zcode-appserver（可选，默认关）
线协议       : anthropic-messages  线协议       : ZCode app-server（stdio JSON-RPC）
谁发模型请求 : DSH 自己             谁发模型请求 : 官方 agent 进程（zcode.cjs）
端点         : ~/.zcode/v2/config.json 的 baseURL
凭据         : 零落盘、零缓存、每次调用现读
适用         : Coding Plan（付费套餐）  适用 : Start Plan / 活动赠送额度（免费额度）
```

> 免费额度通道见 [Start Plan 通道（app-server）](#start-plan-通道app-server)，赠送额度用量会显示在设置面板与输入框下方的进度条里。

---

## 它解决什么问题

ZCode 桌面端自带一个 agent（有自己的 loop、子代理、记忆）。但很多时候你**只想要它的模型额度**，用**你自己的** harness —— 复用 DSH 的工具链、会话、审批、团队协作等。

本插件做这件事：从 ZCode 的配置文件里读出套餐凭据，在 DSH 里注册成一个标准 LLM provider。

### 为什么不直接抄 API Key 去调

因为**不同套餐的凭据形态根本不同** —— 这是本项目最核心的发现：

| 套餐类型 | 凭据形态 | 能否直连 |
|---|---|---|
| **Coding Plan**（付费套餐） | 一等 API Key（zhipu 平台 `id.secret` 格式），存于 `config.json` 或**加密凭据库** `credentials.json` | ✅ **可以** —— 走标准 Anthropic 兼容端点（本插件 `zcode` provider） |
| **Start Plan**（赠送/活动额度） | 账户 **JWT** + 端点要求**逐请求的客户端证明** | ❌ 不能**直连**；✅ 但能**托管官方 agent 代发**（本插件 `zcode-appserver` provider） |

社区里 [dsh-zcode-connector](https://github.com/ZhaoAndy821/dsh-zcode-connector) 断言"ZCode 无可提取 Key"，**那是"不能直连"的限制，不是"用不上"的结论** —— 正确解法是**让官方 agent 去发请求**。

#### 2026-10-10 实测订正：直连的阻断点是**风控 3012**，不是验证码 3007

早期把 Start Plan 直连失败归因为"需要阿里云无痕验证码"（`3007 captcha verify failed`）。本机带齐验证码头再打一次：

| 请求形态 | 上游响应 |
|---|---|
| `POST {plan}/anthropic/v1/messages`，**带**现场解出的 `X-Aliyun-Captcha-Verify-Param` | `HTTP 405 {"code":3012,"msg":"request has been blocked due to unusual activity."}` |
| 同上，**不带**验证码头 | **同样** `405 / 3012` |

⇒ **验证码只是必要条件**：上游还按客户端指纹判定（设备 ID、companion 头、安装序仿真、客户端版本对齐）。要么做完整桌面指纹仿真（如 [dengyie/zcode2api](https://github.com/dengyie/zcode2api)），要么**根本不自己发请求** —— 后者才是本插件选的路线：**托管官方 agent，让二进制自己去签**。

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
> **关于 ④**：DSH **0.2.1 合并了部分内部 UI 包**（`dsh-client-ui-slots` / `dsh-client-ui-primitives` 已不再作为独立包存在）。本插件的客户端代码**不 import 任何 `@deepseek-ai/*` 包**，`inject` 仅作加载顺序声明，故**无影响**（0.2.1-rc.2 实测：`plugins.bundle.config` 与 `conversation.composer.dock` 两个注册点都正常挂载）。该声明保留是为了向后兼容 0.2.0 系列；需要把它当硬门禁时用 `--strict-inject`。
>
> 0.2.1 的 12 项破坏性变更对本插件**0 命中**；升级后实测记录（含 client 插槽 occupant 证据）见 [`DSH-0.2.1-COMPAT-REVIEW.md`](./DSH-0.2.1-COMPAT-REVIEW.md) §F。

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

## 设置面板（T21 显隐 + T22 能力行控件）

DSH 插件设置页的本 bundle 卡片（slot `plugins.bundle.config`，key = 包名）提供**最小可用面板**：

- **模型行布局（T22，一行一模型）**：显隐勾选 + 名称（网关 `display_name`）+ `·官方` 徽标
  + 图片开关 + 200K/1M 单选 + 推理档展示或推理开关：

  ```
  [✓] GLM-5.3       ·官方  图片  ◉200K ○1M   推理档: low / max / high（官方，锁定）
  [✓] GLM-5.3-Flash ·官方  ☑图片 ◉200K ○1M   推理档: low / max / high（官方，锁定）
  [✓] GLM-5.3-FlashX       ☐图片 ◉200K        推理 ☐（未提供官方数据，开关自担）
  ```

- **5.3 系过滤（T22）**：目录（网关与静态表）先按**显式集合**
  `{glm-5.3, glm-5.3-flash, glm-5.3-flashx}` 过滤（大小写不敏感）——网关其余 8 个
  模型（glm-5.2/5.1/5/5-turbo/4.7/4.6/4.5/4.5-air）不再暴露；不用模糊前缀，
  防未来网关多出 `glm-5.3-pro` 之类被误放行。
- **锁定 vs 开关的判定来源（T22）**：ZCode config.json `provider[planKey].models` 段
  （ZCode 官方写入，与 GUI 同源——网关 `/v1/models` 与 bigmodel 标准 API 均零元数据）。
  - **有官方数据**（GLM-5.3 / GLM-5.3-Flash）：`·官方` 徽标；推理档（low/max/high）
    与输入模态**只展示、不可勾改**（disabled 控件）；Flash 的图片随官方 modalities
    **默认勾选且锁定**（官方声明含 image/video，原样保留）；GLM-5.3 官方纯文本，
    图片不可开。
  - **无官方数据**（GLM-5.3-FlashX）：推理与图片提供**开关**（默认关，开启后果自担）。
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
> 所以"**要工具 + 要免费额度**"的组合，答案是派发台而不是本插件的 provider 通道 —— 见文末
> [需要 A 类能力时怎么办](#-免费额度通道zcode-appserver目前缺失的功能速查)。

---

## Start Plan 通道（app-server）

**默认关闭**（`appServer: false`）。开启后额外注册一个 provider `zcode-appserver`，用于消费
**Start Plan / 活动赠送额度**这类**账号型**（非 API Key）额度。

### 它为什么必须"托管一个进程"

Start Plan 的端点 `https://zcode.z.ai/api/v1/zcode-plan/anthropic` 要求**逐请求的客户端证明**。
本机实测：外部 HTTP 直连（哪怕带齐现场解出的验证码头）被上游拦成
`405 / code 3012 unusual activity`；而**官方 agent 二进制自己发出的请求能过**。

所以本通道不是 HTTP 网关，而是：

```
DSH ──► provider "zcode-appserver" ──► 常驻 zcode.cjs app-server（stdio JSON-RPC）
                                          ├─ provider/updateAccountConfig  注入 account:{bigmodel|zai}-start-plan
                                          ├─ session/setMode               权限模式（见下「安全须知」）
                                          ├─ session/setModel              切到 Start Plan 模型
                                          ├─ session/send                  发回合
                                          └─ interaction/requestProviderRuntimeHeaders
                                                └─ 宿主把 zcodejwttoken 递回去，agent 自己算签名
                                                     └──► zcode.z.ai/api/v1/zcode-plan/anthropic
```

三个"错了会**静默失效**"的点（都已在代码里加了对策与断言）：

1. spawn 必须按 GUI 同款设置 `ZCODE_APP_VERSION` / `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` /
   `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` / `ZCODE_BASE_URL`，否则 CLI 落到 `0.0.0-dev` 运行时目录；
2. `basedOnZCodeBuiltinRevision` 必须**逐字符等于** `zcode-builtin:<revision>:<sha256(路径)>`，
   否则 registry 合并守卫**静默跳过**（不报错）；
3. 鉴权 token 必须是共享凭证里的 **`zcodejwttoken`** —— `oauth:*:access_token` 早已过期，回它上游 401。

### 开启方式

```yaml
# cordis.patch.yml（profile 的 patch 层）或设置面板
appServer: true
appServerToolPolicy: allow-all        # 见下「安全须知」；要收紧改 deny-all
zcodeCliPath: 'F:\Program Files\ZCode\resources\glm\zcode.cjs'   # ZCode 装在非系统盘时显式指定
```

> ⚠️ **profile 里可能有同 id 的两条 `- id: <entry>`**（一条你手写、一条插件管理器把本 bundle 的
> `cordis.patch.yml` 物化出来的）。同 id 相遇时**后一条整体覆盖前一条**（不是逐键合并）——
> 写在前一条里的开关**完全不生效，而且没有任何报错**。改配置前先数一数：
>
> ```powershell
> Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Pattern '^- id: zcode-connect$'
> ```
>
> 生效值要写在**最后**那条。详见 [TROUBLESHOOTING §2.9](TROUBLESHOOTING.md)。

开启后模型选择器里会多出一条**独立的** provider 与模型：

```
ZCode Coding Plan          → GLM-5.3-Flash                  ← 付费 Coding Plan 额度
ZCode Start Plan（赠送额度）→ GLM-5.3-Flash（赠送额度）        ← Start Plan / 活动赠送额度
```

**两者是两笔账**（ZCode 桌面端里也是分开列的）：选谁就烧谁的额度，输入框下方的
赠送额度进度条**只在选中「赠送额度」那条时显示**（判据是宿主自己的 `modelSelection` 投影，
即模型选择器写什么、下一次请求就用什么，所以不会出现"显示着赠送额度、实际烧 Coding Plan"的错配）。

### 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `appServer` | `false` | 总开关 |
| `zcodeCliPath` | 空 = 自动探测 | `zcode.cjs` 路径。**ZCode 常装在非系统盘**，自动探测含盘符扫描；仍找不到就显式填绝对路径 |
| `zcodeCliNode` | `node` | 运行 `zcode.cjs` 的 node |
| `zcodeDataBaseDir` | 空 = 用户主目录 | 读 `runtime/provider/**/zcode-builtin.json` 的根 |
| `appServerCredentialStorePath` | 空 = `~/.zcode/v2/credentials.json` | Start Plan token 来源 |
| `appServerAccountProviderId` | 空 = 按 `oauth:active_provider` 自动选 | 注入 `account:bigmodel-start-plan` / `account:zai-start-plan` |
| `appServerModels` | `['GLM-5.3-Flash']` | 暴露给 DSH 的模型（内置目录：GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo；**不含 GLM-5.3**，builtin 未给 start-plan 声明它） |
| `appServerReasoningLevel` | `max` | `session/setModel` 的推理档（low/high/max） |
| `appServerToolPolicy` | `allow-all` | ⚠️ **安全面，见下** |
| `appServerInjectAccount` | `true` | 注入套餐账户（GUI 同款） |
| `appServerWorkspace` | 空 = 用户主目录 | 会话工作目录（勿指向巨型目录树，agent 启动会扫它） |
| `appServerRpcTimeoutMs` | `120000` | 单次 RPC 超时 |
| `appServerTurnTimeoutMs` | `900000` | 单回合超时 |
| `childEnvAllow` | `[]` | 额外透传给子进程的 env 名（默认只放行系统基础变量与 `ZCODE_*`） |

### 面板里能配什么（设置 → 插件 → 本插件）

面板底部有一块**独立的**「赠送额度通道（Start Plan）」区块，与上面 Coding Plan 的模型列表并列：

| 控件 | 写回的配置 | 说明 |
|---|---|---|
| 状态行 | — | `未启用` / `已启用但未注册：<原因>` / `已注册 · CLI=… · 工具策略=…` —— **"模型选项里没有它"时先看这一行** |
| 模型勾选 | `appServerModels` | 勾上的模型出现在选择器的「ZCode Start Plan（赠送额度）」分组下；全不勾 = 回默认单条 `GLM-5.3-Flash` |
| 200K / 1M | `contextBudgets[<id>]` | 与 Coding Plan **共用同一份预算表**（模型 id 不重叠，互不影响） |
| 图片 | — | 显示**当前能力**：接了 DSH `attachments` 服务 → `支持`；否则 `未启用`（如实反映，不写死） |
| 默认思考档 | `appServerReasoningLevel` | 全通道一个值（low / high / max，**档位候选来自官方 `reasoning.variants`**，面板不硬编码）。只在宿主未下发档位时兜底；日常在**输入框的模型选择器**里逐轮切换 |

保存按钮一次写回 `enabledModelIds / contextBudgets / modelOverrides / appServerModels / appServerReasoningLevel`，每项都做**写后回读校验**。

> 面板写入的这些字段都是 **volatile**（DSH 面板可写的硬前提），host 半**活读**——保存后下一次会话生效。

### 思考档（赠送额度的 5.3-Flash 支持思考模式）

官方 `~/.zcode/v2/config.json` 的 `builtin:{bigmodel,zai}-start-plan` 段里，`GLM-5.3-Flash`
声明了 `reasoning.variants = ["low","max","high"]`、`defaultVariant = "max"` —— 与 Coding Plan
**同源同档**。本通道如实把它接上：

| 环节 | 做法 |
|---|---|
| 声明给宿主 | `resolveModel` 返回 `reasoning: { efforts: [{id,name}], defaultEffort }` ⇒ 模型选择器出现思考档（`reasoningFacts` 是适配器与面板的**单一来源**，避免两处漂移） |
| 档位落到 CLI | 宿主按声明校验后从 `request.reasoningEffort` 传回；适配器据此调 `session/setModel{options:{reasoningLevel}}`，**档位变化时复用会话重发**（不是只在建会话时设一次） |
| 读不到官方档位 | 回退到模块常量（同样源自官方声明），**绝不发明档位**；面板的默认档单选也只在候选集合内取值 |
| 兜底默认档 | `appServerReasoningLevel`（面板可改）：宿主没下发档位时用它 |

真机实测（2026-10-10，`node scripts/verify-appserver-channel.mjs --tools allow-all`）：

```
usage 口径=context-used（CLI 回合聚合 input=36904 output=64 调用次数=2；CLI contextUsed=18910）⇒ 上报 DSH input=18910 output=0
块序列     : #0:reasoning #1:text      ← 推理与正文各自独立 index（修复前都在 index 0，互相覆盖）
块不变量   : PASS                     ← 每个 block-end 的负载 == 该 index 已流出文本
模型元数据 : {"inputModalities":["text"],"contextWindow":200000,
              "reasoning":{"efforts":[{"id":"low","name":"Low"},{"id":"max","name":"Max"},{"id":"high","name":"High"}],"defaultEffort":"max"}}
CHUNKS PASS
VERIFY PASS
```

### 图片怎么走（Start Plan 通道）

支持。链路是**文件路径**而不是 base64：

```
DSH 消息里的图片块 {type:"image", attachment:<ref>}
      └─ attachments.imageHostPath(ref)  →  绝对宿主路径（同步方法，返回 string | undefined）
             └─ session/send { content, attachments:[{kind:"image", filename, mimeType, localPath}] }
                    └─ 官方 agent 按路径读取该文件（它自带 Read 工具认得图片）
```

- 为什么用 `localPath` 而不是 `dataBase64`：协议两种都支持，但 agent 是**独立进程**，
  给真实 OS 路径最省事，也避免把大图塞进 JSON-RPC 帧。
- **能力是按需声明的**：只有 `ctx.get("attachments")?.imageHostPath` 可用时才在模型元数据里声明 `image`；
  否则一律声明 `text`（"声明了却拿不到图"会让带图会话整体失败 —— TROUBLESHOOTING §2.7）。
- 图片解析失败**降级为纯文本**并告警；**有图却没物化出附件也一定告警**（2026-10-11 的"静默丢图"
  就是缺这条 —— 物化函数被放进 `options()` 而非顶层注入，见 TROUBLESHOOTING §2.15）。
- 只转发**本轮输入段**（最后一条 assistant 之后的所有 user 消息）里的图：历史图片由
  agent 自己的会话历史承载。⚠️ 不能只看"最后一条 user 消息"—— context-pilot 等注入类插件
  会在用户消息**之后**追加 user 角色消息，把真图顶出扫描范围（2026-10-11 真机事故，
  见 TROUBLESHOOTING §2.17）。
- **真机验证（不经 DSH，零额度可复现）**：

  ```bash
  node scripts/verify-appserver-channel.mjs --tools deny-all \
    --image "$HOME/.dsh/attachments/v1/objects/02/02fd8051…" \
    --prompt "只回答一件事：这张图里最上面那行标题文字是什么？原样引用。"
  # 实测：附件行 = 本轮随消息转发 1 张图片
  #       回复正文 = 图里最上面那行标题文字是：**你要做的**   ← 模型确实读到了图内文字
  ```

### ⚠️ 安全须知（开之前必读）

这个"模型 provider"的真身是一个**以你当前用户权限运行、且带有全套工具执行能力的 agent**：

- `appServerToolPolicy: 'allow-all'`（默认）会把会话切到 `yolo`，并**自动放行** agent 的每一次
  工具请求 —— 它执行 Bash、读写文件、联网**不会弹任何确认**。
- agent 的输入是 DSH 拍平后的整段对话（含网页抓取、工具结果等外部内容）。**不要把不可信
  内容喂进挂着本通道的会话**。
- 想收紧就设 `appServerToolPolicy: 'deny-all'`：留 `build` 模式并一律拒绝工具请求。
  代价是 agent 基本只能纯对话（它本就靠自己的原生工具干活）。
- 子进程 env 按白名单透传（系统基础变量 + `ZCODE_*` + `NODE_EXTRA_CA_CERTS`），
  **不继承 DSH 宿主的全部 env**（防止把其他供应商的密钥漏给它）。
- 鉴权 token 只经**本机 stdio**交给 agent 进程，不发往任何第三方；日志只打长度。

### 与 Coding Plan 通道的能力差异

| | `zcode`（anthropic 直连） | `zcode-appserver`（托管 agent） |
|---|---|---|
| 额度 | Coding Plan | Start Plan / 活动赠送 |
| 并发 | `maxConcurrent`（默认 2） | 一个会话同时 **1 个在途回合**（插件内部排队串行化） |
| 图片输入 | ✅（pi-ai 附件链路） | ✅（DSH 图片 → `localPath` 附件，见下） |
| 工具调用 | DSH 的工具直通模型 | **用 agent 自己的原生工具**，DSH 工具不透传 |
| 冻结开关 / 台账 | ✅ | ✅（同一把开关、同一本台账） |

### 真机验证

```bash
node scripts/verify-appserver-channel.mjs           # 驱动的是生产模块本身
node scripts/verify-appserver-channel.mjs --tools allow-all
node scripts/probe-session-read.mjs                 # 零额度：只验按次上下文读数（见下）
```

⚠️ 会消耗真实额度（一轮对话）。判定看输出末行 `VERIFY PASS/FAIL`，以及
`本轮执行渠道 providerId=… baseURL=…` 是否命中 `zcode.z.ai/api/v1/zcode-plan/anthropic`。
`probe-session-read.mjs` **不发消息、不消耗额度**，只确认 `session/read` 仍下发
`projection.contextUsed`（usage 口径折算的数据源，ZCode 升版时最先失效的就是它）。

> **"已领取" ≠ "已生效"**：活动套餐在 `billing/balance` 里可能是 `status: active`，
> 但 entitlement 带 `effective_at`（本机实测 `ZCode Weekend Build`：`starts_at 20:12` /
> `effective_at 23:00`）。窗口开始前调用会拿到 `code 1005 exceed quota limit` ——
> **那是额度时序，不是通道故障**（判据：`providerId`/`baseURL` 已命中 plan 端点）。

---

## 赠送额度进度条（面板 + 输入框下方）

显示位置（两处同源，口径不会漂移）：

- **设置面板**（设置 → 插件 → 本插件）概览里一行「赠送额度」；
- **输入框下方**（模型选择器之下）一条细进度条 —— **悬浮显示 `剩余 X / 总量 Y`**。
  填充比例 = 剩余/总量；**剩余 ≤10% 变红**；未生效时为灰底满格 + 「待生效 HH:MM」。

### 显示门禁：只在你选中"赠送额度"那条模型时才出现

进度条**不是常显**的 —— 只有当前选中的是赠送额度通道
（provider `zcode-appserver`，即选择器里的 `ZCode Start Plan（赠送额度）`）才渲染：

| 当前选中 | 进度条 |
|---|---|
| `ZCode Start Plan（赠送额度）` 下的任一模型 | **显示** |
| `ZCode Coding Plan` 下的 5.3 Flash（或其它任何 provider） | 不显示 |

判据取自宿主自己的 **`modelSelection` 投影**（官方 UI 同款数据源，`dsh-connect-trae`
的 composer 门禁也用同一招），所以它与"下一次请求实际用哪个模型"永远一致。
投影读不到 / 形状不认识时**整块不渲染并告警一次**（不猜、不误导）。

> 实现细节：投影字段名在 DSH 内部有 `next` / `pending` / `lastUsed` 两套写法，
> 代码三个候选都读（顺序 `next → pending → lastUsed`），避免上游一改就静默消失。

### 数据从哪来（为什么不是实时查询）

**读 ZCode 桌面端自己写的日志**（`~/.zcode/v2/logs/<date>.log` 里它自己的
`billing/balance` 响应），**不自己调上游**：

```
ZCode 桌面端 ──► GET {origin}/api/v1/zcode-plan/billing/balance   （它本来就在轮询）
                        └─► 响应逐次落在 ~/.zcode/v2/logs/<date>.log
                                  └─► 本插件尾部倒读最后一条 ──► 面板 / 进度条
```

原因是**风险**：该端点属 Plan 通道，外部直连实测会被上游风控拦（同类 plan 端点本机实测
`405 / code 3012 unusual activity`）。而客户端本来就在调、结果就在本机日志里 ——
**零新请求、零风控面**。代价是新鲜度取决于桌面端是否在运行（悬浮提示里会带**数据时间**）。

### 三种状态（**刻意不混同**）

| 上游状态 | 显示 |
|---|---|
| 已生效，有余额桶 | 进度条，悬浮 `剩余 X / 总量 Y` |
| **未生效**（`effective_at` 未到，余额桶还没建） | 灰底满格 + `待生效 HH:MM`，悬浮 `剩余 —（未生效） / 总量 Y` |
| 已过期 / 读不到日志 / 非 start-plan | **整块不渲染** |

> ⚠️ 「未生效」**不会**拿 `grant_units` 冒充"剩余" —— 那会在面板上显示成"一分没用"的假象。
> 这是本项目对"静默误导"的一贯取舍：**宁可不显示，也不给错数字**（自检里有专门断言守着）。

### 刷新机制

两处显示**共用一个轮询器**（单定时器 + 单 in-flight 请求）：

| 时机 | 行为 |
|---|---|
| 组件挂载 | 立即拉一次状态文档 |
| **每 60 秒** | 自动刷新；面板与进度条**同步**更新 |
| 面板从 summary 切到 page / 设置命名空间变更 | 重订阅并立即拉一次 |
| 最后一个消费者卸载 | **撤掉定时器**（不留后台空转） |

> 为什么必须"共用"而不是各拉各的：除了省一半请求，更要紧的是**一致性** —— 各自持有
> 状态副本时，进度条刷新不会让面板重渲染，同一个额度会在两处显示成**不同时刻**的值
> （用户看到的是"两个数对不上"）。自检里有单定时器 / 单 fetch 源的结构断言守着。

上游余额本身是分钟级刷新的，宿主每次 GET 又只做一次**有界尾部读**（64KB 块倒读、命中即止），
所以 60s 一次的代价可以忽略。

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
2. usage（input/output token）由网关返回、从事件流提取，取不到时台账记 `null`。
   **app-server 通道额外做口径折算**（第 17 条）：CLI 给的是"整回合 N 次调用之和"，
   直接上报会让宿主把上下文占用算成 N 倍。
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

### ⚠️ 免费额度通道（`zcode-appserver`）**目前缺失的功能**速查

> 一句话：**模型对话、思考档、图片、流式、额度进度条、费用台账都能用；但 DSH 的"工具层"
> 在这条通道上不参与**。原因是架构边界 —— agent 是官方 CLI 的**独立进程**，工具在它自己
> 进程内执行，DSH 只负责注入账户、转发消息、翻译事件流（这也是它零破解、零凭据落盘的原因）。
> 下面按"有没有等价替代"分三类。实测依据见 TROUBLESHOOTING §2.18（同会话按通道统计：
> 直连通道 DSH 工具调用 792 次，免费额度通道 **0 次**）。

**A. 完全没有对应能力（在这条通道上做不到）**

| 能力 | 受影响的 DSH 工具 | 影响 |
|---|---|---|
| 浏览器面板 / 批注 / 截图 | `browser_*`（browser-kit 全部） | 你在 DSH 里开的浏览器窗口、页面批注、截图能力都用不上 |
| Agent Teams（多代理协作） | `spawn_teammate` / `send_message` / `wait_agent` / `list_agents` / `interrupt_agent` / `team_task_*` | 无法组队、无法共享任务板 |
| 派发台 | `zcode_dispatch` | 无法在**通道会话里**再派发任务给 ZCode —— 但"**用派发台消费免费额度**"完全可行：派发台自己也支持该通道（见下方「需要 A 类能力时怎么办」第 1 条） |
| 工作流编排 | `workflow` | 无多子代理扇出 |
| 后台任务 | `job_list` / `job_output` / `job_kill` | 无托管后台作业 |
| 定时提醒 | `schedule_*` | 无定时/周期提醒 |
| 交付物卡片 | `present` | 不能生成可点击打开的文件卡片 |
| 中途提问 | `ask_user_question` | 模型**无法在做任务途中问你** —— 只能一次问清，或直接猜 |
| TODO 可视化 | `todo_write` | 聊天窗里不再有 TODO 清单进度 |
| 目标管理 | `create_goal` / `update_goal` / `get_goal` | 无目标态与自动续跑 |
| 技能加载 | `skill` | 模型读不到 DSH 的技能目录 |
| 依赖自检 | `load_workspace_dependencies` | 无内置的 Python/Node 依赖路径注入 |

**B. 能力有等价物，但**旁路 DSH**（agent 用自己的原生工具做）**

| 能力 | agent 实际用什么 | 代价（重要） |
|---|---|---|
| 读写改文件 | 它自己的 Read / Write / Edit | **不走 DSH 的沙箱策略与文件版本守卫**（不会有 `FS_STALE_VERSION` 保护），也不进 DSH 的工具调用记录与聊天窗展示 |
| 跑命令 | 它自己的 Bash | 同上；**不受 DSH 的审批/拦截约束**（本通道默认 `yolo`，见「安全须知」） |
| 找文件/搜内容 | 它自己的 Glob / Grep | 结果不回流到 DSH 的工具结果面板 |
| 联网 | 它自己的 WebSearch / WebFetch | 与 DSH 的 `web_search` / `web_fetch` 是两套实现，结果形态不同 |

**C. 宿主侧机制的差异（不是工具，但你会感觉到）**

| 机制 | 现状 |
|---|---|
| context-pilot 的**决策卡 / 工具教学** | **不转发给模型**（它教的是 `compact_context` / `set_reasoning_effort` 等本通道不存在的 DSH 工具）。侧栏用量行、面板这些**客户端**功能照常；压缩改由**宿主引擎/强制线**驱动，模型无法主动"智能压缩" |
| DSH 图片 | 只转发**最后一条 assistant 之后**的用户消息里的图；历史图靠 agent 自己的会话承载 |
| 并发 | **单会话同时只允许一个在途回合**，吞吐低于直连；撞锁有自愈阶梯（含硬重启），但要等 |
| 首轮成本 | 切换通道后的**第一轮要把整段对话拍平成文本**（实测单个会话到过 ~880 KB 文本）；之后只发当轮真实用户消息 |
| 上下文窗口 | agent 自己的窗口约 200K，与 DSH 声明的窗口**是两套**；DSH 侧压缩不会改变 agent 侧上下文 |
| 官方 MCP 服务器 | 桥接进程拿不到桌面端签名头（`Official MCP auth headers unavailable`），`node_repl` / `image_search` 等**连不上**；agent 可能在这些坏工具上打转，拖到本地超时（默认 15 分钟） |
| 模型目录 | 只能在官方 start-plan 段声明过的模型里选（如 GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo）；写未声明的模型会 `setModel` 失败 |

**需要 A 类能力时怎么办**（按推荐顺序）：

1. **要「agent 自主用工具干活」、又想烧免费额度 ⇒ 用姊妹项目 [派发台（zcode-dispatch）](https://github.com/Shuffle-1992/zcode-dispatch)**：它**也支持免费额度通道**（与本通道同源的「托管官方 agent」方案，通道 id `account:<family>-start-plan`；面板有**额度条**、agent 派发前能读到剩余额度与窗口剩余时间、台账按 `billing=zcode-plan-gift` 与付费套餐分账）。而且那里的语义**本来就是对的** —— 派发 = **独立 ZCode 进程做它自己的事**（用它自己的原生工具、独立会话、独立额度），所以「工具是 ZCode 自己的」**不是缺陷而是设计**，本节说的「DSH 工具层不参与」在派发台上根本不存在。**这是把免费额度用在「真干活」上的正确姿势**（配套：单写者文件锁 / 用量台账 / 暂停分类 / 自动降级链 / 任务落地自动唤醒）。
2. 需要 **DSH 自己的工具链**（浏览器面板 / 批注 / 截图 / Agent Teams / 交付卡片 / `ask_user_question` …）⇒ **改用直连通道**（provider `zcode`，走 Coding Plan / API Key 形态，
DSH 工具全部可用），或者把任务拆开——需要浏览器/组队/交付卡片的步骤放在直连通道做，
单纯"烧免费额度"的对话与代码问答放在本通道。

---

### app-server 通道（`zcode-appserver`，默认关）

11. **DSH 的工具不会透传给 agent**：模型实际是"用 agent 自己的原生工具干完活再把结果讲给你"，
    所以 DSH 侧的 `pwsh` / `fs-local` / `browser_*` / `todo_write` / `ask_user_question` 等工具
    在这条通道上**不会被调用**（真机实测：同一次会话里直连通道的回合共 792 次 DSH 工具调用，
    赠送额度通道的回合 **0 次**）；adapter 会把模型误写的 `<antml:…>` 伪调用文本拦下
    （并在聊天窗留一条拦截说明）。**后果**：agent 只能用自己的原生工具（Bash/Read/Write/Edit…），
    DSH 侧的副作用（TODO、浏览器面板、向用户提问、子代理）在这条通道上不会发生 ——
    需要这些能力时请用直连通道（`zcode`）或让 agent 直接跑命令。
    同理，**context-pilot 的决策卡与"工具教学"在本通道不转发**（它教的是 `compact_context` /
    `set_reasoning_effort` 这类 DSH 侧工具，agent 无法调用；占用数字也是 DSH 会话的，与 agent
    自己的上下文窗口无关）。本通道的压缩仍由宿主自身的引擎/强制线驱动，不受影响。
    见 TROUBLESHOOTING §2.17。
12. **图片输入**：已支持 —— DSH 的图片附件经 `attachments.imageHostPath(ref)` 取**绝对宿主路径**，
    以 app-server 的 `{kind:'image', filename, mimeType, localPath}` 附件随消息转发（见「图片怎么走」）。
    仅当宿主 `attachments` 服务在位时才声明 `image`（否则一律 `text`）；服务缺席时面板会显示「图片：未启用」。
13. **单会话同时只允许一个在途回合**（app-server 的硬约束）。插件内部做了排队串行化、撞锁
    自愈（补发 `session/stop` 后重试）与会话失效重建，但**吞吐仍低于直连通道**；长任务建议
    按会话分摊。
14. **Start Plan 的是账号型额度**：额度与"是否生效"由服务端按窗口授予，`status: active`
    不等于可消费（见上文 `effective_at`）。窗口未开始时表现为 `code 1005 exceed quota limit`。
15. 通道打通依赖 ZCode 的 `app-server` 子协议（`session/create` → `setModel` → `send` →
    `session/event`）与 `basedOnZCodeBuiltinRevision` 的算法。**ZCode 升版后若改协议，本通道会失效**
    —— 启动/回合日志里的 `已注入 …（providerCount=… status=…）` 与
    `本轮执行渠道 providerId=…` 就是第一手判据。
16. **赠送额度进度条的数据新鲜度**取决于 ZCode 桌面端是否在运行/轮询（见
    「赠送额度进度条」一节）：它是**读客户端日志**而非实时查询上游 —— 这是为规避
    Plan 通道风控（3012）付出的代价。悬浮提示里的「数据 HH:MM」就是这条日志的时刻。
17. **usage 口径已折算**（`lib/app-server.js` 的 `deriveReportedUsage`）：CLI 的
    `turn.completed.usage` 是**本回合 N 次模型调用之和**（`modelRequestCount` 即次数），
    而宿主的 usage 是**单次请求**口径（tokenMeter 拿它当 `contextPressure` 锚点）。
    单调用回合原样上报；多调用回合改读 CLI 的 `session/read → projection.contextUsed`
    （按次上下文读数），读不到则按次数取均值。**若不折算，1M 窗口会被算成 708%**，
    表现为弹窗顶部 100%/~7.1M 与同弹窗的启发式明细（~24.9K）自相矛盾，并连续触发压缩
    —— 完整取证与三条判据见 TROUBLESHOOTING §2.10。
18. **思考档已接上并真机验证**（见上文「思考档」）：`resolveModel` 按官方 `reasoning.variants`
    声明 `reasoning.efforts`，档位变化时重发 `session/setModel`。面板的「默认思考档」只在
    宿主未下发档位时兜底；**日常切换用输入框的模型选择器**（宿主的档位选择器）。
19. **流式块按类型拆分**（修「内容被覆盖」）：推理与正文各自独立 index + 显式 `block-start`，
    每块用自己的累计文本收尾；CLI 的最终答案**只在没出现在流出内容里时**作为新块追加
    （流恢复 / 伪调用标记拦截等场景），不再整体替换已流出内容。判据：验证脚本的
    `CHUNKS PASS`（见「真机验证」）。机制与坑位见 TROUBLESHOOTING §2.11。
20. **usage 只在可信时下发**（修「弹窗 0%」）：宿主把这个 usage 当上下文压力锚点，
    **报 0 等于把占用清零**（实测一次 561 秒未落定的回合让弹窗从 40% 掉到 0%，
    而同一弹窗的明细仍有 383K）。现在：全零 / 拿不到读数 / 本地标题 ⇒ **不发 usage 块**
    （宿主退回启发式估值）；回合末落定（中止/超时）⇒ 改用 CLI 的按次上下文当锚点
    （真实读数，能把已被清零的锚点自愈回来）。见 TROUBLESHOOTING §2.13。
21. **`defaultReasoningEffort` 默认 `none` 表示"自动"**（修「档位选择器里多一个 `Default`」）：
    宿主在模型未声明 `defaultEffort` 时会补一个 "Provider default" 项。本插件现在按
    "当前暴露模型是否全都支持同一档"自动决定 provider 默认档（优先 max→high→low）：
    全支持 ⇒ 自动设（`Default` 项消失，且与官方 `defaultVariant=max` 一致）；
    混入非推理模型（如未开推理开关的 FlashX）⇒ 不设（避免其请求硬失败）。面板保存后即时重算。
    见 TROUBLESHOOTING §2.14。
22. **官方 MCP 工具在桥接进程里不可用**：CLI agent 会看到 ZCode 配置里的官方 MCP 服务器
    （`node_repl` / `image_search` 等），但它们需要**桌面端才有的官方签名头**
    （CLI 日志：`Official MCP auth headers unavailable` → `MCP server connection failed`）。
    实测后果：代理可能在这些坏工具上反复重试，把一轮拖到本地超时（默认 15 分钟，
    `appServerTurnTimeoutMs`）。MCP 相关失败**不是通道故障**；若频繁遇到，请在 ZCode 里
    关掉这些插件，或把这类任务交给直连通道（`zcode`）。
23. **超时/中止后的会话自愈**：回合未落定时会补发 `session/stop`；若下一轮仍撞
    `A prompt is already running for this session`，按阶梯升级恢复（stop+1.5s → stop+6s →
    **硬重启 CLI 子进程并重建会话**），不再把用户这一轮直接判死。见 TROUBLESHOOTING §2.16。

---

## 免责声明

- 本项目**不是** Z.ai / 智谱官方项目，与官方无关联。
- 它通过读取**你本机已登录的 ZCode 客户端配置**来复用你自己的套餐额度。请自行确认这符合
  你所同意的服务条款；相关风险（含账号风控）由使用者自负。
- 本项目**不破解、不绕过**任何验证机制：`zcode` 通道只接凭据本身就是标准 API Key 的套餐形态；
  `zcode-appserver` 通道则**完全不动验证链路** —— 它托管的是官方 agent 本体，请求由官方二进制
  自己签发（本插件只在本机 stdio 上把 token 递给它）。两条通道都不伪造设备指纹、不模拟验证码。
- 请勿提交任何凭据。仓库内不含、也不会要求你提供任何密钥。

## License

[MIT](LICENSE)
