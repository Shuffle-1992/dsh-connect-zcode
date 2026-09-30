# dsh-connect-zcode

**把 ZCode（Z.ai / 智谱 BigModel Coding Plan）作为模型通道接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）** —— 让 DSH 自己的 agent loop 直接消费你的 ZCode 套餐额度。

一个 DSH 原生 provider 插件：注册 `zcode` provider，模型在 DSH 模型选择器里直接可选。

```
provider id : zcode
线协议       : anthropic-messages
端点         : 由 ~/.zcode/v2/config.json 提供（如 https://open.bigmodel.cn/api/anthropic）
凭据         : 零落盘、零缓存、每次调用现读
```

---

## 它解决什么问题

ZCode 桌面端自带一个 agent（有自己的 loop、子代理、记忆）。但很多时候你**只想要它的模型额度**，用**你自己的** harness —— 复用 DSH 的工具链、会话、审批、团队协作等。

本插件做这件事：从 ZCode 的配置文件里读出套餐凭据，在 DSH 里注册成一个标准 LLM provider。

### 为什么不直接抄 API Key 去调

因为**不同套餐的凭据形态根本不同** —— 这是本项目最核心的发现：

| 套餐类型 | 凭据形态 | 能否直连 |
|---|---|---|
| **Coding Plan**（付费套餐） | `~/.zcode/v2/config.json` 里的**明文一等 API Key**（zhipu 平台 `id.secret` 格式） | ✅ **可以** —— 走标准 Anthropic 兼容端点 |
| **Start Plan**（赠送/活动额度） | 账户 **JWT**，且端点需要 Aliyun 无痕验证码凭证（由 ZCode renderer 逐请求签发） | ❌ **不可** —— 直连返回 `{"code":3007,"msg":"captcha verify failed"}` |

社区里 [dsh-zcode-connector](https://github.com/ZhaoAndy821/dsh-zcode-connector) 等项目断言"ZCode 无可提取 Key"，**那是 Start Plan 形态的限制，不是 ZCode 的普遍限制**。本项目只接 Coding Plan（api-key 形态），并对 start-plan 的 JWT 形态**显式拒绝**而不是静默失败。

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

> ⚠️ 这是一个 **link 式本地插件**（尚未发布到 npm）。安装会改动 DSH profile 配置，请自行确认。

**1. 克隆到稳定位置**

```bash
git clone https://github.com/Shuffle-1992/dsh-connect-zcode.git
cd dsh-connect-zcode
```

**2. 编辑 profile 的 `package.json`**（如 `~/.dsh/profiles/desktop/package.json`）

```jsonc
{
  "dependencies": {
    "@local/dsh-connect-zcode": "link:/absolute/path/to/dsh-connect-zcode"
  },
  "dsh": {
    "profile": {
      "bundles": [ /* … */ "@local/dsh-connect-zcode" ]
    }
  }
}
```

**3. 在 profile 目录执行 `pnpm install`**（link 依赖只建符号链接）

**4. 重启 DSH** —— 模型选择器应出现 `zcode` 分组。

**5. 验证**

```bash
node test/selfcheck.mjs     # 应输出 SELFCHECK PASS：113/113，exit 0
```

---

## 配置

插件 config（`cordis.patch.yml` 或 profile 覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `planKey` | `builtin:bigmodel-coding-plan` | 只接的套餐条目 |
| `contextWindow` | `200000` | 基础上下文窗口（CLI 实测有效 200k；config 名义 1M 不默认采信，仅作官方 Max 档可选） |
| `maxConcurrent` | `2` | 并发推理上界（1..2） |
| `credentialPath` | 空 = `~/.zcode/v2/config.json` | ZCode 配置路径 |
| `switchPath` | `~/.dsh/zcode-dispatch.switch.json` | 冻结开关真值文件（缺文件/损坏 = 开启） |
| `ledgerPath` | `~/.dsh/zcode-runs.jsonl` | 额度台账（追加写） |
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

---

## 自检

```bash
node test/selfcheck.mjs      # 113 断言，exit 0 = 全绿
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

---

## 免责声明

- 本项目**不是** Z.ai / 智谱官方项目，与官方无关联。
- 它通过读取**你本机已登录的 ZCode 客户端配置**来复用你自己的套餐额度。请自行确认这符合
  你所同意的服务条款；相关风险（含账号风控）由使用者自负。
- 本项目**不破解、不绕过**任何验证机制：它只支持凭据本身就是标准 API Key 的套餐形态；
  对需要验证码凭证的形态**明确拒绝**。
- 请勿提交任何凭据。仓库内不含、也不会要求你提供任何密钥。

## License

[MIT](LICENSE)
