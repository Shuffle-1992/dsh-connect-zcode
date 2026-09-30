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
node test/selfcheck.mjs     # 应输出 SELFCHECK PASS：47/47，exit 0
```

---

## 配置

插件 config（`cordis.patch.yml` 或 profile 覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `planKey` | `builtin:bigmodel-coding-plan` | 只接的套餐条目 |
| `contextWindow` | `200000` | 保守上下文窗口（CLI 实测有效 200k；config 名义 1M 不采信） |
| `maxConcurrent` | `2` | 并发推理上界（1..2） |
| `credentialPath` | 空 = `~/.zcode/v2/config.json` | ZCode 配置路径 |
| `switchPath` | `~/.dsh/zcode-dispatch.switch.json` | 冻结开关真值文件（缺文件/损坏 = 开启） |
| `ledgerPath` | `~/.dsh/zcode-runs.jsonl` | 额度台账（追加写） |

环境变量（覆盖默认值）：

| 变量 | 作用 |
|---|---|
| `ZCODE_CONNECT_SWITCH_PATH` | 冻结开关路径 |
| `ZCODE_CONNECT_LEDGER_PATH` | 台账路径 |
| `ZCODE_CONNECT_MODULES_ROOT` | 宿主 LLM 栈的 `node_modules` 根 |
| `ZCODE_CONNECT_DSH_RESOURCES` | DSH 的 `resources` 目录（asar 兜底） |

---

## 设计要点

- **凭据零落盘、零缓存、零日志**：每次调用现读 ZCode 配置，返回值只在内存。
  ⇒ 你在 ZCode 里换 Key，本插件**自动跟随**，无需重启、无需改配置。
- **不发送任何不应发送的东西**：除套餐端点外无出站请求；登记台账前对错误摘要做**密钥形态脱敏**。
- **额度冻结开关**：`switchPath` 文件里 `enabled:false` ⇒ 每次实际调用前抛错拒绝
  （连 `GET /v1/models` 也不发）。默认路径不存在 ⇒ 视为开启，未部署开关的场景零配置可用。
- **并发预算 N=2**：超限在插件侧排队，**不自动升限**。
- **无 client 半 / 无 UI**：v1 不声明 `dsh.client` —— 声明了却缺 `lib/client.js` 会让 DSH
  **拒绝启动**（`ClientPackageCompositionError`），不声明即规避。
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
node test/selfcheck.mjs      # 47 断言，exit 0 = 全绿
```

纯静态 / 单元测试：**不产生任何网络请求**（`fetch` 全程投毒）、**不读真实凭据内容**
（用 tmp fixture）、产物零明文扫描。

---

## 已知限制

1. `contextWindow` 保守声明 200k（CLI 实测有效窗口）；网关侧真实上限未测。
2. usage（input/output token）由网关返回、从事件流提取，取不到时台账记 `null`。
3. 模型条目只声明 `input: ['text']` 与 `reasoning: false`（宁缺勿滥：虚报会在请求中途被网关拒绝）。
4. 端点 `baseURL` 在激活时读取一次；套餐端点变更需重启 DSH。
5. **真机推理链路尚未端到端验证**（本项目完成时该插件尚未在 DSH 内激活过，仅有 stub 自检）。

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
