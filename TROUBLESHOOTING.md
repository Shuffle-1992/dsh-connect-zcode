# 故障排查与踩坑记录（TROUBLESHOOTING）

本文件记录开发/使用 **dsh-connect-zcode** 过程中**在真机上实际踩过**的坑。
每条都给出：**现象 → 根因 → 判据 → 修法**，便于他人快速定位、避免重踩。

> 这些坑分三类：**ZCode 侧**（凭据/登录）、**DSH 侧**（插件机制）、**通用工程**（测试/工具）。
> 其中若干条与"ZCode 接入 DSH"这一主题直接相关，即使你不用本插件也有参考价值。

---

## 目录

- [一、凭据与登录](#一凭据与登录)
  - [1.1 OAuth 重登后 `config.json` 凭据失配（连 ZCode CLI 都 401）](#11-oauth-重登后-configjson-凭据失配连-zcode-cli-都-401)
  - [1.2 ⚠️ 网关对失效 key 也返回 HTTP 200](#12-️-网关对失效-key-也返回-http-200)
  - [1.3 加密凭据库 `enc:v1` 的格式与解密](#13-加密凭据库-encv1-的格式与解密)
  - [1.4 Coding Plan vs Start Plan：为什么社区说"取不到 Key"](#14-coding-plan-vs-start-plan为什么社区说取不到-key)
  - [1.5 Start Plan 到底能不能用：app-server 通道的六个坑](#15-start-plan-到底能不能用app-server-通道的六个坑)
- [二、DSH 插件机制](#二dsh-插件机制)
  - [2.1 声明了 `dsh.client` 却缺 `lib/client.js` → DSH 拒绝启动](#21-声明了-dshclient-却缺-libclientjs--dsh-拒绝启动)
  - [2.2 设置面板全灰不可点：`configForms` 没被激活](#22-设置面板全灰不可点configforms-没被激活)
  - [2.3 面板"看起来保存成功"实则回弹：缺 volatile 标记](#23-面板看起来保存成功实则回弹缺-volatile-标记)
  - [2.4 宿主包必须走 asar 候选链；asar 内部不能用 `existsSync` 探测](#24-宿主包必须走-asar-候选链asar-内部不能用-existssync-探测)
  - [2.5 深色主题出现白块：token 名写错 + 浅色回退值](#25-深色主题出现白块token-名写错--浅色回退值)
  - [2.6 插件列表不显示描述：字段写错位置](#26-插件列表不显示描述字段写错位置)
  - [2.7 声明了图片能力却没给 resolveAttachments](#27-声明了图片能力却没给-resolveattachments--带图会话整体失败)
  - [2.8 面板报 HTTP 404：schemastery 没有 enum，静默降级致插件不激活](#28-面板报状态不可用http-404schemastery-没有-enum静默降级导致插件整体不激活)
  - [2.9 同 id 的 patch 条目：后一条整体覆盖前一条](#29-profile-里同-id-的-patch-条目后一条整体覆盖前一条注释式默认值其实是真配置)
  - [2.10 agent 型通道的 usage 口径：回合聚合被当单次调用](#210-agent-型通道的-usage-口径把-cli-的回合聚合当单次调用上报--dsh-上下文占用虚高-n-倍)
  - [2.11 流式正文与思考同 index 混发 → 内容互相覆盖](#211-流式正文与思考同-index-混发--面板里内容互相覆盖最后被整体替换)
  - [2.12 pwsh 整文件编码往返写坏源码；未提交文件无法用 git 恢复](#212-用-pwsh-做整文件编码往返把源码写坏未提交的文件无法用-git-恢复)
  - [2.13 provider 报「零 usage」会把上下文占用清零](#213-provider-报零-usage-会把上下文占用清零弹窗-0明细却有几万)
  - [2.14 模型档位选择器里多出一个 `Default` 项](#214-模型档位选择器里多出一个-default-项)
- [三、通用工程](#三通用工程)
  - [3.1 用 `fetch` 后调 `process.exit()` 会崩（Windows）](#31-用-fetch-后调-processexit-会崩windows)
  - [3.2 "换个位置就红"的测试是资产](#32-换个位置就红的测试是资产)
  - [3.3 过紧的断言会保护 bug](#33-过紧的断言会保护-bug)
  - [3.4 静态回退表要与远端同形](#34-静态回退表要与远端同形)
  - [3.5 门禁命令的 exit code 禁止经管道取值](#35-门禁命令的-exit-code-禁止经管道取值)

---

## 一、凭据与登录

### 1.1 OAuth 重登后 `config.json` 凭据失配（连 ZCode CLI 都 401）

**现象**

在 ZCode 里**退出登录 → 删除密钥 → 改用 OAuth 重新授权**后，调用模型报
「身份验证失败 / 密钥无效」。

**关键判据（先做这一步）**

**ZCode 自己的 Agent CLI 也 401**：

```bash
node "F:\Program Files\ZCode\resources\glm\zcode.cjs" -p "hi" --cwd . --mode edit
# → Error: Turn execution failed ... statusCode: 401 {"type":"1000"}
```

CLI 也挂 ⇒ **不是插件问题**，是 ZCode 侧凭据状态问题。

**根因**

ZCode 有**两个凭据存放位置**：

| 位置 | 形态 | 谁在读 |
|---|---|---|
| `~/.zcode/v2/config.json` → `provider["builtin:bigmodel-coding-plan"].options.apiKey` | **明文** | ZCode CLI、本插件、第三方工具 |
| `~/.zcode/v2/credentials.json` → `account-provider:coding-plan:...:api-key` | **加密 `enc:v1`** | ZCode 桌面端自己 |

**OAuth 重新登录后，ZCode 只更新后者、不回写前者**。而 `config.json` 里留着**已删除的旧 Key**
⇒ 所有读 `config.json` 的程序集体 401。

**最快的判据**：比对两个文件的修改时间。凭据库随登录更新，`config.json` 却停在很早以前
（实测：凭据库 `10-01 04:28`、`config.json` `09-17 16:38`）⇒ 基本可判定失配。

**修法（推荐：把有效密钥写回 `config.json`）**

```bash
node scripts/sync-key-to-config.mjs --dry-run   # 只诊断
node scripts/sync-key-to-config.mjs             # 验活通过才写回（写前自动备份）
```

**为什么推荐写回 `config.json`**：它修的是**共用文件**，所以
**ZCode CLI、其他项目、任何读 `config.json` 的工具一次全好**；
而插件内建回退（方案 B）只覆盖本插件自己。**先跑它止血。**

工具的安全边界：

- **只在验活通过后才写入**；全部候选无效 → **拒绝写入**（不做无依据修改）
- 写前自动备份 `config.json.bak-dsh-<时间戳>`；写入用「临时文件 + rename」原子替换
- 写后**回读校验**；不一致则提示可用备份还原
- **全程不打印 key 原文**（只打 `head=xxxxxxxx*** tail=***xxxx` 指纹）

> 明文写入 `config.json` 是 **ZCode 自身的设计**（它本来就明文存 Key），本工具不新增暴露面。
> 但请知悉该文件含明文凭据，**勿提交入库**。

---

### 1.2 ⚠️ 网关对失效 key 也返回 HTTP 200

**这是本项目最容易踩、后果最隐蔽的坑。**

**现象**

用**失效**的 key 调 `GET /v1/models`：

```
HTTP 200
{"code":1000,"msg":"身份验证失败。","success":false}
```

用**有效**的 key：

```
HTTP 200
{"data":[{"id":"glm-4.5",...}, ...]}
```

**根因**：bigmodel 网关把认证失败也包装成 **HTTP 200**，只在 body 里给 `code:1000`。

**后果（严重）**

任何"只看状态码"的验活逻辑，都会把**无效 key 判为有效** ⇒

- 凭据回退逻辑形同虚设（"回退"到另一把同样无效的 key，或误判当前 key 可用）
- 工具报告"一切正常"但实际仍然 401
- 早期探测脚本输出 `modelsListable:true` 但 `messagesOk:false` 的矛盾，根源即此

**正确判定（三者同时满足才算通过）**

```js
const res = await fetch(`${baseURL.replace(/\/+$/, '')}/v1/models`, {
  method: 'GET',
  headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  signal,
});
if (!res.ok) return false;                        // 401 等
const body = await res.json();
if (body?.success === false) return false;        // ← 关键：200 也可能是认证失败
if (body?.code !== undefined && body.code !== 200) return false;
return Array.isArray(body?.data) && body.data.length > 0;
```

> **通用教训**：**HTTP 状态码不等于业务结果**。对接任何网关都要看响应体，
> 尤其是"认证/鉴权"这类会被中间层改写状态码的场景。

---

### 1.3 加密凭据库 `enc:v1` 的格式与解密

从 `zcode.cjs` 反编译实证（**非猜测**）：

```
格式  ：enc:v1:<iv base64url>.<tag base64url>.<data base64url>
算法  ：AES-256-GCM
密钥  ：sha256(secret)            // 32 字节
iv    ：12 字节（base64url 解码后校验）
tag   ：16 字节
secret：优先 env ZCODE_CREDENTIAL_SECRET（trim 后）
        否则 "zcode-credential-fallback:<platform>:<homedir>:<username>"
        （Node: os.platform() / os.homedir() / os.userInfo().username）
```

Node 实现：

```js
import { createDecipheriv, createHash } from 'node:crypto';
import { homedir, platform, userInfo } from 'node:os';

const ENC_PREFIX = 'enc:v1:';

function resolveSecret() {
  const fromEnv = process.env.ZCODE_CREDENTIAL_SECRET?.trim();
  if (fromEnv) return fromEnv;
  let user = 'unknown';
  try { user = userInfo().username; } catch {}
  return `zcode-credential-fallback:${platform()}:${homedir()}:${user}`;
}

function decrypt(value) {
  try {
    if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return null;
    const parts = value.slice(ENC_PREFIX.length).split('.');
    if (parts.length !== 3) return null;
    const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16 || data.length === 0) return null;
    const key = createHash('sha256').update(resolveSecret()).digest();
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch { return null; }
}
```

**键名结构（实测，7 段、两个 `account:`）**

```
account-provider:coding-plan:account:<planId>:account:<accountId>:api-key
例：account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:12345678901234567:api-key
```

- 只收 `account-provider:coding-plan:` 开头、`:api-key` 结尾的键
- 解密后的值须匹配 zhipu API Key 形态 `/^[0-9a-f]{32}\.[A-Za-z0-9]{16}$/`（**实测长度恒为 49**）
- **同一账号可能有多把 key**（individual / team）——**必须逐把验活**，不能取第一把
- **形态校验失败要留诊断**：该正则是硬过滤，ZCode 若换 key 形态会让候选**静默变空**。
  本插件在过滤点输出 `形态校验未通过（键 <planId>）：长度=<N>（期望 49…）`（只报长度，零明文），
  让"被过滤"这件事可见。

> **稳定性提示**：这依赖 ZCode 的内部实现，**版本升级可能变化**。
> 本插件把它设计为**尽力而为的第二来源**：解密失败一律降级回 `config.json`，绝不抛。

---

### 1.4 Coding Plan vs Start Plan：为什么社区说"取不到 Key"

**不同套餐的凭据形态根本不同** —— 这是本项目最核心的发现：

| 套餐类型 | 凭据形态 | 能否直连 |
|---|---|---|
| **Coding Plan**（付费套餐） | 一等 API Key（zhipu `id.secret` 格式），明文存于 `config.json` 或加密存于凭据库 | ✅ **可以** —— 走标准 Anthropic 兼容端点 |
| **Start Plan**（赠送/活动额度） | 账户 **JWT**；端点 `zcode.z.ai/api/v1/zcode-plan/anthropic` 要求 **V4 客户端请求签名** | ❌ **不可**（见下方 2026-10-01 实测） |

社区项目（如 `dsh-zcode-connector`）断言"ZCode 无可提取 Key、只能 CDP 驱动 GUI"，
**那是 Start Plan 形态的限制，不是 ZCode 的普遍限制**。

本插件只接 Coding Plan（api-key 形态），并对 start-plan 的 JWT 形态**显式拒绝**而非静默失败：

```
该条目是 start-plan 账户 token 而非 API Key，本插件不支持：
请改用 builtin:bigmodel-coding-plan（api-key 形态）的登录条目。
```

#### 2026-10-01 补充实测：Start Plan 的真实阻断点是**V4 请求签名**，不是验证码

之前把原因记为"Aliyun 无痕验证码"（T18 时期的观察）。用**无头 CLI 实跑**后拿到更精确的根因：

| 路径 | 结果 |
|---|---|
| 裸 HTTP `GET {plan}/v1/models` | **404**（该 plan 端点没有 models 路由） |
| 裸 HTTP `POST {plan}/v1/messages`（`x-api-key` 或 Bearer） | **401**（路由存在、鉴权被拒） |
| **无头 CLI**（真实 runner + start-plan 置 enabled 的沙箱） | `ClientRequestSigningV4Error: **Client signing credential must contain one separator**`（`resolveCredential`→`ensurePrivateKey`→`getKeyOrSendUnsigned`），`kind: invalid-config`，4.1s 失败 |
| **对照组**（同沙箱 + coding-plan） | **exit 0** ⇒ 方法学有效，上条是真实结论 |

解读：`zcode.z.ai` 的 plan 端点要求**客户端请求签名 V4**，签名凭据必须是 `id.secret`
（**恰好一个分隔符**）；而 Start Plan 只签发 **JWT（两个点）** ⇒ 形态结构性不兼容。
ZCode 自家的 `account:*-start-plan` provider（`apiKey:'' + apiKeyRequired:true`）说明这类凭据
**根本不在 `config.json` 里**，而由账号/OAuth 侧解析（加密库中可见 `zcodejwttoken` /
`oauth:bigmodel:access_token` / `oauth:active_provider`）——即 GUI 才走得通的那条路。

#### 第二轮实验：走 CLI 自己的账号路径（全量账号态沙箱）

既然纯注入不行，再验"CLI 自己的账号解析路径能否用 Start Plan"：
把**整个 `~/.zcode` 账号态**复制进沙箱（`v2` 含 `runtime/provider/**/zcode-builtin.json` 等，
跳过 987MB 的 `cli/`），重定向 `USERPROFILE`，并用 `ZCODE_CREDENTIAL_SECRET` 还原凭据库解密
（fallback secret 含 `homedir`，重定向后会失效）。
⚠️ 第一次只复制 `config.json + credentials.json` 时 CLI 报 `ZCode Built-in missing` ——
缺的是 `v2/runtime/provider/<平台>/<版本>/endpoint-*/zcode-builtin.json`。

| 测试 | 沙箱 config 状态 | 结果 |
|---|---|---|
| A | 原样 | **exit 0**，响应正常 |
| B | **只**启用 start-plan（coding-plan/bigmodel 禁用） | **exit 0** |
| C | **全部** provider 禁用 | **exit 0** |

三例都成功 ⇒ **`config.json` 的 enabled 开关根本不约束 CLI 的账号路径**。
那到底扣了谁的额度？查 GUI 周期刷新的 `billing/balance` 日志：

```json
{"entitlement_id":"zcode-v3-start-plan-trust-1001","show_name":"GLM-5.3-Flash",
 "total_units":100000000,"used_units":0,"remaining_units":100000000}
```

**Start Plan `used_units` 始终为 0** —— 跑完 A/B/C 三例后仍未消耗。
而 `coding-plan-cache.json` 显示 `builtin:bigmodel-coding-plan: available`、
`builtin:zai-start-plan: unavailable (coding_plan_not_entitled)`。
⇒ CLI 走账号路径时用的是**账号里 available 的那个（付费 Coding）套餐**，
**从不路由到 Start Plan**。

**最终结论**：派发台的无头 CLI **用不了 Start Plan**（三重独立证据：注入→V4 签名不兼容；
账号路径→Start Plan 额度零消耗；ZCode 自评→start-plan 对 CLI 不可用）。
Start Plan 是 **GUI（renderer）专属**的授权路径。**实用建议**：派发/provider 一律用 Coding Plan；
Start Plan 额度请在 ZCode 桌面端使用。

> **通用教训**：**别把单一账号形态的结论当成普遍结论**。
> 排查"能不能接"时，先分清对方有几种凭据形态、你手上是哪一种；
> 以及"**401/404 只是表象，要看客户端为此做了什么额外工作**"（这里是请求签名）。
> 另有方法论两点：① **归因要看"谁被消耗了"**（余额/用量），而不是"跑通了"——
> 测试 B/C 都"成功"，但成功并不等于用了目标通道；② **对照组不可省**：
> 第一版注入配方连已知可用的 coding-plan 也失败，没有对照就会得出错误结论。

> ⚠️ **2026-10-10 再订正**：上面"Start Plan 是 GUI 专属、用不了"的结论**只对"自己发 HTTP"成立**。
> 正确解法是**托管官方 agent 进程**（`zcode.cjs app-server`），让二进制自己去签 —— 本插件已实现为
> `zcode-appserver` provider。归因也要改：直连的阻断点是**风控 3012**，不是验证码 3007。
> 详见 [§1.5](#15-start-plan-到底能不能用app-server-通道的六个坑)。

---

### 1.5 Start Plan 到底能不能用：app-server 通道的六个坑

**能。但"能"的前提是：不要自己发那个 HTTP 请求。**

#### 先订正归因：直连的真阻断点是 3012，不是 3007

`POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`，本机 2026-10-10 实测：

| 请求形态 | 响应 |
|---|---|
| 带现场解出的 `X-Aliyun-Captcha-Verify-Param`（280 字节，结构 `certifyId/sceneId/isSign/securityToken`）+ 完整身份头 | `HTTP 405 {"code":3012,"msg":"request has been blocked due to unusual activity."}` |
| 不带验证码头（对照） | **同样** `405 / 3012` |

⇒ 早期把原因记成"缺验证码（3007）"**只对了一半**：验证码是必要不充分条件，上游还看**客户端指纹**
（设备 ID、companion 头、安装序仿真、客户端版本对齐）。3012 同时是**账号风控信号** ——
社区实现（`zcode2api`）识别到它会把账号标 `DISABLED` 保护。**别拿主账号反复裸试。**

> **教训**：**"我缺了 X"与"X 是充分条件"是两件事。** 补上 X 后仍失败，说明真正的判据还在别处；
> 此时最省力的做法不是继续补齐仿真，而是**换一条不需要仿真的路**（这里是托管官方进程）。

#### 正解：托管 `zcode.cjs app-server`

```
DSH → provider zcode-appserver → 常驻 zcode.cjs app-server（stdio JSON-RPC）
      ├─ provider/updateAccountConfig   注入 account:{bigmodel|zai}-start-plan
      ├─ session/setModel               切到 Start Plan 模型
      ├─ session/send                   发回合
      └─ interaction/requestProviderRuntimeHeaders ← 宿主把 zcodejwttoken 递回去
             └─ agent 自己算签名 ──► zcode.z.ai/api/v1/zcode-plan/anthropic   ← 过 WAF
```

本机实测（生产模块 `scripts/verify-appserver-channel.mjs`）：
`已注入 account:bigmodel-start-plan（providerCount=1 status=received）` →
`应答鉴权（token 204 字符）` → `本轮执行渠道 providerId=account:bigmodel-start-plan baseURL=https://zcode.z.ai/api/v1/zcode-plan/anthropic`，
全程 **7.2s**、无 3007 / 无 3012。

#### 坑 A：`oauth:active_provider` 必须**解密**后再用（静默注入错家族）

**现象**：明明账号是 `bigmodel` 家族，插件却注入了 `account:zai-start-plan`；
**且不报任何错** —— `status:received` 照样返回，请求照样打到 plan 端点。

**根因**：凭据库里 `oauth:active_provider` 与 `zcodejwttoken` 一样是 `enc:v1:` 密文。
直接读 raw 会拿到密文串，于是 `activeProvider === 'bigmodel'` 永远不成立，静默回落到默认家族。

**修法**：统一走 `decryptCredentialValue`（它对非密文原样返回，两种存储形态都安全）。

**判据**：启动日志 `已注入 account:<家族>-start-plan` 必须与 `oauth:active_provider` 一致。

> **连带教训（自检侧）**：这条 bug 最初**通过了自检** —— 因为 fixture 里把
> `oauth:active_provider` 写成了明文。**fixture 形态与真实存储不一致 = 假绿**，
> 与 §3.3「过紧/过松的断言会保护 bug」同构。修法是让 fixture **也加密**。

#### 坑 B：ZCode 可能装在**非系统盘**，只查 `%ProgramFiles%` 探测不到

**现象**：`appServer: true` 了，但模型列表里没有 `zcode-appserver`，且只有一行 warn。

**根因**：本机 ZCode 装在 `F:\Program Files\ZCode\`，而 `%ProgramFiles%` 是 `C:\Program Files`。

**修法**：探测链里加**盘符扫描**（C..H × 常规安装位），并保留 `zcodeCliPath` 显式配置为最高优先。
**判据**：启动日志 `app-server 通道已注册：… CLI=<路径>`。

#### 坑 C：`basedOnZCodeBuiltinRevision` 算错 → 注入被**静默跳过**

registry 合并守卫做**逐字符相等**比较：`zcode-builtin:<release.revision>:<sha256(resolve(路径))>`。
差一个字符注入就被丢弃，**不报错**。

**两个必须同源的点**：spawn 时给的 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 与算 basedOn 用的
`activeFilePath` 必须是**同一个文件**（还要按 GUI 同款设 `ZCODE_APP_VERSION` 等四个 env，
否则 CLI 落到 `0.0.0-dev` 运行时目录，两边对不上）。

**判据**：`providerCount` 只证明"收到"，真正的确证是回合里
`session.updated.providerId` —— 即日志的 `本轮执行渠道 providerId=…`。

#### 坑 D：app-server 的回合锁**不会自己释放**

一轮被中止 / 超时 / 静默丢弃后，下一轮直接撞 `A prompt is already running for this session`。
**修法**：只要本轮没正常结束（超时/中止/发送失败/`turn.failed`），`finally` 一定补发
`session/stop`；被回"already running"就补刀 + 1.5s 后重试一次；被回"session not found"
（进程重启/会话回收）就丢弃缓存条目、新建会话并按首轮语义重放整段对话。

> 注意 `session/stop` 是**通知**（无响应），别等它的 result。

#### 坑 E：`status: active` ≠ 额度可用

活动套餐在 `billing/balance` 里可能是 `status:"active"`，但 entitlement 带 `effective_at`：

```json
{"plan_id":"zcode-v3-start-plan-1010","name":"ZCode Weekend Build","status":"active",
 "starts_at":1791634329,"ends_at":1791766800,
 "entitlements":[{"show_name":"GLM-5.3-Flash","grant_units":300000000,"period":"one_time",
                  "effective_at":1791644400}]}
```

`effective_at`（= 界面上的"待生效 23:00"）之前调用 → 上游 `code 1005 exceed quota limit`。
**判据**：`providerId`/`baseURL` 已命中 plan 端点、且失败码是 1005 ⇒ **是额度时序，不是通道故障**。

#### 方法论小结

1. **归因要先排除"充分性"**：补上缺失项仍失败 ⇒ 缺的不是那个；
2. **能托管官方客户端就别仿真它** —— 后者的维护成本是按上游风控策略走的；
3. **"静默跳过"类守卫必须用终点证据核对**（这里是 `providerId`），中间态回执（`status:received`）不算数；
4. **fixture 必须与真实存储同形**（密文就写密文），否则 bug 会在自检里长期假绿。

---


## 二、DSH 插件机制

### 2.1 声明了 `dsh.client` 却缺 `lib/client.js` → DSH 拒绝启动

**现象**：`package.json` 的 `dsh.client` 声明了 client 半，但 `exports["./client"]`
指向的文件不存在或加载失败 ⇒ **DSH 启动后几秒自行退出**（`ClientPackageCompositionError`）。

**修法 / 不变量**：

- `dsh.client` 声明与 `lib/client.js` **必须同生同灭**（一次交付、同时存在）
- `lib/client.js` 必须是**自足的预构建 bundle**（`window.__ModuleLoader__.load` 信封，
  无构建步骤、无外部 `import`；唯一外部依赖是宿主提供的 `react`）
- client 半的 `apply()` **整体 try/catch**，失败只 `console.error`，**绝不抛**
- **自检里加"manifest 与文件一致性"断言**守护该不变量

### 2.2 设置面板全灰不可点：`configForms` 没被激活

**现象**：面板渲染正常，但**所有控件灰掉、无法勾选**，提示"设置命名空间不可写，当前只读"。

**根因链（逐层实证）**：

1. 面板用 `ctx.get("configForms")` 软探测拿设置服务 → 恒为 `undefined`
2. `configForms` 由 `@deepseek-ai/dsh-client-ui-settings` 的 client 半 `super(ctx, "configForms")` 提供
3. **但该包自身的 cordis inject 是 `["remote", "remote.settings"]`**
   ⇒ 组合里必须先有 `remote` 服务，它才会激活并 provide `configForms`
4. 若插件 client 只声明 `inject = ["slots"]`、且 `dsh.client.inject` 未含提供 `remote` 的
   `@deepseek-ai/dsh-api-remotes` ⇒ **整链没起来**

**修法**（取本机两个"已证可用"参照的并集，不发明）：

```jsonc
// package.json → dsh.client.inject（对齐 dsh-connect-trae 的完整清单）
"inject": [
  "@deepseek-ai/dsh-api-remotes",        // ← 提供 remote，configForms 的前置
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-locale"
]
```

```js
// lib/client.js
const inject = ["slots", "locale", "remote"];   // trae = ["slots","locale"]
                                                 // workbuddy = ["slots","locale","remote","remote.session"]
```

**判据**：面板能勾选且保存后回读保持 = 通了；只读提示出现 = `configForms` 未解析到。

### 2.3 面板"看起来保存成功"实则回弹：缺 volatile 标记

**现象**：面板保存后提示成功，但重开面板**值回到原样**；而 `set()` 调用**照样 resolve**。

**根因**：DSH 0.1.7 的设置写入门禁要求条目里**存在 volatile 字段**，否则每次写入被
**静默拒绝**（`Plugin entry "x" has no volatile fields`），而 `set()` 依然返回成功。

**修法**：给面板写入的 config 字段打 schemastery `.volatile()` 标记。

> **连带坑**：`schemastery` 若因解析失败而走了**手写降级 schema**，则**无法表达 volatile 标记**
> ⇒ 面板保存必然失效。所以 schemastery 必须走宿主候选链正确加载（见 2.4）。

### 2.4 宿主包必须走 asar 候选链；asar 内部不能用 `existsSync` 探测

**坑 A：link 插件的裸 import 解析不到宿主包**

link 式插件（`link:` 依赖）的真实路径在用户目录下，Node 按真实路径向上查 `node_modules` ——
**宿主的 `@deepseek-ai/*` / `@earendil-works/*` 不在该链上**（它们在 DSH 的 `app.asar` 内嵌
`node_modules` 里）。裸 `await import('@deepseek-ai/schemastery')` 会失败 → 静默降级 →
引发 2.3 的面板写入失效。

**修法**：维护一条候选根链动态加载宿主包（`process.resourcesPath` 推导
`app.asar/dsh/node_modules` 等），并对"降级即功能静默失效"的包特别标注。

**坑 B：asar 是归档文件，不能用 `existsSync` 探测内部**

`D:\DeepSeek\resources\app.asar` 是 **100+ MB 的归档文件**（不是目录），
`existsSync('.../app.asar/dsh/node_modules/xxx')` **恒为 false** ⇒ 会误判成"宿主依赖缺失"。

**正确探测**：读归档头部 JSON 索引：

```js
const buf = readFileSync(asarPath);
const headerSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'));
// 然后按 header.files 树逐段查找
```

**真机可核验判据**：Cordis Inspect 查该插件 Config，若投影出的字段带 `x-cordis.volatile`
⇒ 走的是 schemastery 主路径（手写 fallback 不可能产出该标记）；不带 ⇒ 走了降级。

### 2.5 深色主题出现白块：token 名写错 + 浅色回退值

**现象**：面板在**浅色主题正常**，**深色主题**下卡片变**白底**、正文低对比。

**根因**：CSS 里用了**不存在的 token 名**，`var()` 取不到值 → 落到**浅色回退值**：

| 曾用的错名（不存在） | 真实 token |
|---|---|
| `--dsw-alias-text-primary` | `--dsw-alias-label-primary` |
| `--dsw-alias-border` | `--dsw-alias-border-l1` / `-l2` |
| `--dsw-alias-fill-primary` | `--dsw-alias-bg-layer-1` |
| `--dsw-alias-fill-secondary` | `--dsw-alias-bg-layer-2` |
| `--dsw-alias-state-error-secondary` | （不存在） |

⇒ 概览卡片回退 `#fafafa`、正文回退 `#1f2329` —— 深色主题下就是白底黑字块。

**两条不变量**：

1. **回退值必须主题无关**：`transparent` / `rgba(128,128,128,·)` / `currentColor` / `inherit`。
   **绝不用**具体浅色值（`#fff`/`#fafafa`/`#e5e7eb`…）
2. **token 名不要凭记忆写** —— 用 `cordis_inspect_query`（client `Theme.listTokens`）查实测清单

本机实测可用 token（15 个）：
`--dsw-alias-{bg-base,bg-layer-1,bg-layer-2,bg-overlay,border-l1,border-l2,brand-primary,label-primary,label-secondary,state-error-primary,state-idle-primary,state-success-primary,state-warn-primary}`、`--dsw-specific-sidebar-fill`

> **教训**：**"浅色主题看着没问题"不能作为 UI 通过的依据** —— 回退值恰好是浅色时，
> 浅色主题会掩盖 token 名错误。**双主题都必须验。**

### 2.6 插件列表不显示描述：字段写错位置

**现象**：插件列表里本插件**没有描述行**，而其他插件都有。

**根因**：DSH 读**顶层** `description` / `displayName` 字段，而不是 `meta.description`。

```jsonc
{
  "name": "dsh-connect-zcode",
  "displayName": "DSH Connect ZCode",        // ← 顶层
  "description": "把 ZCode … 接入 DeepSeek Harness…",  // ← 顶层（DSH 读这里）
  "meta": { "title": "…", "description": "…" }          // ← 这个 DSH 不读
}
```

### 2.7 声明了图片能力却没给 `resolveAttachments` → 带图会话整体失败

**现象**（很有迷惑性）：

- **新会话（纯文本）**调用该 provider 的模型 **完全正常**
- 但**带图片/附件上下文**的会话里切到该模型，报：

  ```
  本轮运行失败 pi-ai image input requires the durable attachment service
  ```

**根因**

模型条目声明了 `input: ["text", "image"]`（本插件的 GLM-5.3-Flash 官方 modalities 含
image/video），但 `createProvider()` **没传 `resolveAttachments`**。

pi-ai 遇到图片输入时，需要该服务把**图片引用**换成**可请求的字节**
（`attachments.readImageRequest(ref, target)`）；服务缺席时它**直接抛错** ⇒
**整个会话**的模型调用失败。纯文本会话不触发该路径，故"新会话能用、旧会话不能用"。

**修法（两段式 —— 缺一不可）**

**第 1 段：`resolveAttachments`，且必须挂在 adapter options 上**

```js
new mods.PiAiAdapter({
  profiles, auth, resolveApiKey,
  resolveAttachments: () => ctx.get('attachments'),   // ← 挂这里
})
```

- **挂载点是关键**：dsh-llm-pi-ai 读的是 `this.config.resolveAttachments`，而 `this.config`
  就是 `PiAiAdapter` 构造函数收到的 options（`:1753-1755`）。**挂到 `createProvider({...})`
  会静默无效**，带图请求照样抛同一个错。
  trae `:433-437` 与 DSH 自家注册内置 provider `:2569-2573` 都挂在 adapter options 上。
- **为什么软取**：`attachments` 缺席时返回 `undefined`，纯文本场景照常工作，
  **不扩大启动失败面**（trae 的 host 半 `inject` 同样只有 `["llm"]`）
- **已知边界**：宿主若真的没有 `attachments` 服务（非 Desktop 环境），
  图片输入仍会失败 —— 这是 pi-ai 的硬要求，插件无法绕过；
  此时应在该模型上关掉图片能力（本插件面板的图片开关，仅对**无官方数据**的模型可改）

**第 2 段：profile 必须带图片请求预算**（否则修好第 1 段后会撞上**下一个**错）

第 1 段修好后，带图请求会改报：

```
本轮运行失败 Image request width must be a positive integer.
```

根因：pi-ai 用 `profile.requestImagePixelBudget` / `profile.requestImageMaxBytes` 组装
`requestImagePolicy`，再交给 `requestImageTarget` 算目标宽高；`dsh-attachment-local` 用
`checkedInteger` 校验 width/height/maxBytes 为正整数。

⚠️ **注意 `?? {}` 的陷阱**：pi-ai 写的是
`const requestImagePolicy = images.requestImagePolicy ?? {maxPixels: 4194304, maxBytes: 1048576}` ——
但调用方若传了个**对象**（哪怕字段全是 `undefined`），默认值就**不生效**，
于是 `maxPixels: undefined` → 宽高算不出 → 报错。

修法（trae `REQUEST_IMAGE_BUDGETS` 同款同值，数值即 DSH 自身默认，不自创阈值）：

```js
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,   // 20MB base64 上界
  requestImagePixelBudget: 4194304, // 像素预算（= pi-ai 默认 maxPixels）
  requestImageMaxBytes: 1048576,    // 单图字节（= pi-ai 默认 maxBytes）
};
const profile = { /* … */ ...REQUEST_IMAGE_BUDGETS };
```

> **通用教训**：**"能力声明 + 服务接线"只是第一步，还要把该能力用到的预算/策略参数补齐**。
> 这类缺失会以"下一个看似无关的错误"形式出现（本例：`durable attachment service`
> → `Image request width`），一次只修一个表象容易来回折腾 —— **照抄一个已跑通的同类实现
> （trae）的全部相关字段**，比逐个试错快得多。
> 另：**`?? 默认值` 对"传了空字段的对象"无效**，这也是静默失败的常见来源。

> **通用教训（前段）**：**"部分会话正常、部分会话失败"往往指向"某种输入形态触发了未接的能力"**，
> 而不是凭据或网络问题。先看失败会话与正常会话的**输入差异**（图片/文件/长上下文）。

### 2.8 面板报「状态不可用（HTTP 404）」：schemastery 没有 `enum`，静默降级导致插件整体不激活

**现象**

面板顶部出现：

```
状态不可用（HTTP 404）。勾选保存不受影响；能力徽标与 1M 档以目录恢复后为准。
```

同时 **provider 从模型列表里消失**（因为插件整个没激活）。

**根因链（逐环实证）**

在 Config schema 里写了 `z.enum([...])`：

```
Schema.enum : undefined        ← schemastery 3.18.4 根本没有这个方法
Schema.union: function         ← 正确的枚举写法
```

于是构造 schema 时抛 `TypeError: Schema.enum is not a function`：

1. 被 `loadConfig()` 的 `catch` 吞掉 → **静默降级**为手写 fallback schema
2. DSH 的 config 投影判定 `!isNativeConfigSchema(config)`
   （`dsh-tool-cordis`：`if (!isNativeConfigSchema(config)) return { status: 'unsupported' }`）
3. 入口 `status = unsupported` → **插件整体不激活**
4. 没有 provider 注册 → 模型列表没有它；**状态路由从未注册 → 面板 404**

**为什么自检没抓到**

开发目录解析不到宿主 schemastery → `loadConfig` 在**构造 schema 之前**就 `if (!z) throw` 走了降级
⇒ 那行 `.enum` **根本不执行**。**降级路径把错误完全掩盖了。**

**修法（三件事一起做）**

1. **用真实存在的 API**：`z.union(['none','low','high','max'])`（schemastery 的枚举写法）
2. **让降级可见**：`catch` 里必须 `console.warn` 出原因 —— 否则"插件凭空消失"极难定位
3. **加 API 面绊线**（自检）：扫描源码里所有 `z.<method>(`，断言都在**实测白名单**内
   （真实静态方法：`extend resolve from lazy natural percent date regExp arrayBuffer is any never
   const string number boolean bitset function array dict tuple object union intersect transform`）
   - 扫描前**必须剥注释**（注释里可能写着 `z.enum(...)` 的说明文字 → 误报）
   - 正则要允许**换行链式**（`z` 与 `.union(` 常分行，否则漏检 → 绊线形同虚设）

**判据**：Cordis Inspect 查该插件 Config，`status` 应为 `schema`；
若是 `unsupported` ⇒ Config schema 不是原生 schemastery（十有八九是构造时抛错降级了）。

> **通用教训**：**"容错降级"会让错误静默化**。降级可以保留（可移植性），但**必须打日志**；
> 否则一个 API 拼写错误会伪装成"插件消失 + 面板 404"这种毫无线索的故障。

---

### 2.9 profile 里同 id 的 patch 条目：**后一条整体覆盖前一条**（"注释式默认值"其实是真配置）

**现象**（2026-10-10 真机）：在 profile 的 `cordis.patch.yml` 里给本插件设了
`appServer: true` 并**重启了 DSH**，模型选择器里依然没有新 provider，**且没有任何报错**。

**根因**：文件里有**两个** `- id: zcode-connect` 条目 ——

| # | 来源 | 位置 |
|---|---|---|
| ① | 用户手写（含 `appServer: true`、机器专有 `switchPath`/`ledgerPath`） | 文件中部 |
| ② | **插件管理器把 bundle 自带的 `cordis.patch.yml` materialize 出来的** | **文件末尾** |

加载器按 id 合并，**②整体覆盖①**（⚠️ 不是逐键深合并）。于是①里的键全部无效，
真正生效的是②——而②带着 bundle patch 里写的 `appServer: false`。
那个 `false` 本来是当**"注释式默认值"**写的（想提示"默认关"），
**它不是注释，是一条真配置**，把用户设的 `true` 整个压掉了。

**三条免重启判据（照做就能分辨"配置没生效"还是"注册失败"）**：

```bash
# ① 读派生的有效值（本插件的状态路由；换成你的插件自己暴露的只读面）
curl -s http://127.0.0.1:19387/plugins/dsh-connect-zcode/status | ...
#    → 看 enabledModelIds / frozen 这类只有配置能影响的字段

# ② 拿"只可能来自用户条目"的键做对照（本例 switchPath / ledgerPath）
#    若它们表现成默认值（~/.dsh/...）⇒ 用户条目被整条覆盖了

# ③ 数一数同 id 条目有几个
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Pattern '^- id: zcode-connect$'
```

本例实证：status 报 `frozen=False`，而①指定的 switch 文件写着 `enabled:false`；
台账写在 `~/.dsh/zcode-runs.jsonl` 而非①指定的项目路径 ⇒ **①整条是死的**。

**修法**：
1. 生效值写进**末尾**那条（谁在最后谁生效）；
2. **bundle patch 里不要钉开关的默认值** —— 交给 schema（`Config` 默认值）即可；
3. 给被覆盖的那条加注释指路，免得下一个人继续改错地方。

> **通用教训**：配置系统的**合并语义**必须用**可区分的证据**测出来，别假设是逐键深合并。
> 本例的判别物是"只出现在一条里的 `switchPath`/`ledgerPath`"——有了它，"哪条生效"就是
> 可观测事实，而不是猜测。另外：**patch 这种"默认值层"会被下游工具物化成真配置**，
> 写进默认值层的东西就不是建议、而是实际行为 —— 想表达"默认关"，请留给 schema 的 default。

---

### 2.10 agent 型通道的 usage 口径：把 CLI 的「回合聚合」当「单次调用」上报 ⇒ DSH 上下文占用虚高 N 倍

**现象**（2026-10-10 真机，`zcode-appserver` 通道 / DSH 1M 窗口）：

- 原生上下文弹窗顶部显示「上下文已用 **100%** ~**7.1M** / 1M」，而**同一个弹窗**里的启发式
  明细只有 系统提示词 ~2.2K / 工具定义 ~15.2K / 对话消息 ~7.5K（合计 ~24.9K）——**自相矛盾**；
- 同一轮里**连续触发两次压缩**（`已压缩 194 条历史记录（约 107714 tokens）` +
  `已压缩 452 条历史记录（约 248289 tokens）`），每次都在超大估算上跑，用户体感"分析了很久"；
- context-pilot 的用量行读的是同一个 tokenMeter 读数，于是它自己也报 708%，强制线（75%）
  被反复击穿 —— 插件与引擎**一起**误判。

**根因（两层，缺一不可）**：

1. **CLI 侧**：`turn.completed.usage` **不是**一次调用的用量，而是**本回合全部模型调用之和**。
   `zcode.cjs` 里 `ZO(events)` 收集本回合每条 `ModelComplete` 的 usage，再交给 `Jgr(...)`
   用 `reduce` 逐桶相加，并附 `modelRequestCount`（= 本回合模型调用次数）。
2. **DSH 侧**：`usage` 是**单次请求**口径 —— `dsh-token-meter` 直接拿它当 `contextPressure`
   的锚点（`pressureFrom(usage) = inputTokens + cacheReadTokens + cacheWriteTokens`），
   `measure().totalTokens` 也在 `usageTokens(usage) ≥ 启发式估值` 时取它当 baseline。
   ⇒ N 次调用的**和**直接变成了"当前上下文"。

**两条免跑模型的判据（零额度）**：

```powershell
# ① 插件账本：单调用回合 vs 多调用回合的 input 差一个数量级
Get-Content "$env:USERPROFILE\.dsh\zcode-runs.jsonl" | Select-String 'appserver' | Select-Object -Last 6
#    实测：117207 / 220089（与 rollout 里那一笔逐字相同）  vs  3871622（10 分钟长回合）

# ② CLI 自己的**按次**记录（每次模型调用一条，含 provider usage）
Get-ChildItem "$env:USERPROFILE\.zcode\cli\rollout\model-io-*.jsonl" | Sort-Object LastWriteTime -Descending | Select-Object -First 3
#    单次调用 in=220089 ⇒ 与①里那个大值一比，倍数就是 modelRequestCount（≈17）
```

**修法**（已实现于 `lib/app-server.js`：`deriveReportedUsage` + `_readSessionContext`）：

| 场景 | 上报 DSH 的值 | 理由 |
|---|---|---|
| `modelRequestCount ≤ 1` | CLI 聚合值**原样**（含 cache 分桶） | 单调用回合的聚合值**就是**按次值（判据①逐字相同），且不多花 RPC |
| 多调用 + 有 `contextUsed` | `{inputTokens: contextUsed, outputTokens: 0}` | `contextUsed` 是 CLI 按次维护的读数（每条 `ModelComplete` 覆写成该次 `input+output`），output 已含在内，再报一次就是重复计 |
| 多调用 + 读不到 `contextUsed` | 各桶按 `modelRequestCount` 取**均值** | 轮内上下文单调增长 ⇒ 均值 ≤ 末次值：**宁可偏小，绝不虚高** |
| `contextUsed > 回合聚合总量` | 不采信，退回均值 | 口径漂移护栏（防某版把 `contextUsed` 换成会话累计值） |

账本 `~/.dsh/zcode-runs.jsonl` **仍记回合聚合**（真实消耗，多调用回合 = N 次之和），
两者不混用；每轮日志会打一行 `usage 口径=<basis> … ⇒ 上报 DSH input=…` 供取证。

**零额度验证 `session/read` 形状**（不发消息 ⇒ 不消耗额度）：

```powershell
node scripts/probe-session-read.mjs
# → projection 键含 contextUsed / contextWindow / totalTokenCount（新会话：0 / 200000）
# → 若 CLI 不再下发 contextUsed，插件会自动退回"按次数取均值"，并打 warn（不会虚高）
```

**真机多调用回合验证**（会消耗少量额度；判据看 `usage 口径=` 那一行）：

```powershell
node scripts/verify-appserver-channel.mjs --tools allow-all `
  --prompt "用 pwsh 读取 package.json 的 version，然后只回复：版本=<值>"
# 实测输出：usage 口径=context-used（CLI 回合聚合 input=36974 output=126 调用次数=2；
#           CLI contextUsed=18977 window=200000）⇒ 上报 DSH input=18977 output=0
#           ——— 聚合 36974 没有泄漏到宿主侧（差 2 倍；17 次调用的长回合差 17 倍以上）
```

**③ 最直接的一条：DSH 自己的投影缓存**（弹窗顶部百分比就是它算的），一条命令读数：

```powershell
$f = Get-ChildItem "$env:USERPROFILE\.dsh\storages\session_projcache\sessions\*.json" |
     Sort-Object LastWriteTime -Descending | Select-Object -First 1
(Get-Content $f -Raw | ConvertFrom-Json).record.rows.contextPressure.val
# → {surfaceTokens, contextWindow, pressureTokens, sampledSurfaceTokens}
```

判据：**`pressureTokens` 应与 `surfaceTokens` 同量级**（差值 ≈ 最后一次调用的 output，
正常 < 5%）。实测对照：

| 时刻 | pressureTokens | surfaceTokens | 比值 | 弹窗 |
|---|---|---|---|---|
| 修复前（17 次调用的长回合刚跑完） | ~7,060,000 | ~160,000 | **44×** | 100%（~7.1M / 1M） |
| 修复后（当前 deepseek 会话，同一实现路径） | 224,133 | 162,137 | **1.4×** | 22% |

`pressureTokens` 的算法是 `uncachedInputTokens + cacheReadTokens + cacheWriteTokens`
（缓存里 `last.buckets` 就是原始三项：实测 `261 + 223872 + 0 = 224133`）——
所以"上报什么 usage"直接决定这个数，与启发式的 `surfaceTokens` 一旦背离 N 倍，
弹窗就会自相矛盾、压缩线也会被误击穿。

> **通用教训**：把"外部 agent 的运行结果"映射进宿主契约时，**先确认两边同名指标的口径与量纲**，
> 再谈取值。本例的判别物是「账本里逐回合的 input」与「CLI 每次调用的 input」——
> 两者在单调用回合**逐字相同**、在多调用回合**差 N 倍**，这才让口径结论成为事实而非猜测。
> 另外：**同名不同义时，宿主不会报错**——它只会安静地把你给的数字当成另一个东西用
> （这里是"上下文占用"），症状出现在离 bug 很远的地方（压缩行为、耗时、进度条）。

---

### 2.11 流式正文与思考**同 index 混发** → 面板里内容互相覆盖、最后被整体替换

**现象**（2026-10-10 真机，用户在赠送额度通道上实测）：回答过程中聊天窗里
**思考与输出都有，但一直互相覆盖**（刚出现的文字转眼被替换），最后整段内容又变了一次。

**根因（宿主源码取证，两层都要看）**：宿主与 GUI 都以 **chunk 的 `index` 为块键** ——

1. `dsh-llm/lib/types/assembler.js` 的 `BlockAssembler`：`ensure(index, blockType)`
   **只在 index 不存在时**才定块类型，之后 `text-delta` 与 `reasoning-delta` 会**拼进同一个块**；
   而 `block-end` 一到就 `partial.block = chunk.block`（"First close wins"）——
   **用收尾负载整体替换**该 index 已累积的内容。
2. `dsh-client-ui-chat/lib/client.js` 的 `updateChunk`：
   `blocks[i] = { kind, text: (previous?.kind === <同类> ? previous.text : "") + delta }`
   ⇒ 同一 index 上换一次类，**上一类的全部内容当场丢弃**。

所以"把 reasoning-delta 与 text-delta 都发在 index 0、再用最终文本收尾"这种写法必然表现为覆盖：
思考与正文互相清空，最后被最终答案替换。

**修法**（`lib/app-server.js` 的块编排）：

| 规则 | 理由 |
|---|---|
| **换块类型就换新 index**，并显式 `block-start {index, blockType}` | 类型与 index 一一对应，GUI 不再互相丢弃 |
| 每块用**自己的累计文本**收尾（`block-end` 负载 == 已流出文本） | 收尾不再替换出不同内容 |
| CLI 的最终 `response` 只在**没出现在流出内容里**时作为**新块追加** | 流恢复 / 伪调用标记拦截导致"正文没流出"时不丢答案，也不覆盖已流出内容 |
| 两者都为空时仍产出一个空文本块 | 与旧行为一致，避免宿主拿到"零块"消息 |

**判据**（真机，`scripts/verify-appserver-channel.mjs` 已内置）：

```
块序列     : #0:reasoning #1:text     ← 修复前是 reasoning 与 text 混在同一个 index
收尾块     : #0(138字) #1(5字)
块不变量   : PASS                     ← 每个 block-end 的负载 == 该 index 已流出文本
CHUNKS PASS
```

自检侧用**假 transport 驱动真实 `stream()`** 断言同一组不变量（含"正文未流出时追加最终答案"），
所以这次修复不是靠肉眼看 GUI 才算过。

> **通用教训**：流式协议里 `index` 往往是**块的唯一键**，不是"顺手填个 0"。把两种语义的内容
> 复用一个 index，等于让渲染层每帧二选一 —— 症状（闪烁 / 覆盖 / 内容变短）离根因很远。

---

### 2.12 用 pwsh 做「整文件编码往返」把源码写坏；未提交的文件无法用 git 恢复

**现象**（2026-10-10，本仓库自身）：为改 3 处调用执行了一条
`(Get-Content lib\app-server.js -Raw) -replace '...' | Set-Content lib\app-server.js -Encoding utf8`
之后：**中文全变乱码**、文件从 1617 行缩到 1451 行（连**换行**与个别 ASCII 字符都被吞）、
`node --check` 报语法错误、自检直接崩。

**根因**：读的一端按**系统 ANSI(GBK)** 解码 UTF-8 文件、写的一端按 UTF-8 编码 ⇒ 双向编码往返；
GBK 会把某些字节当双字节字符的尾字节**吃掉**（含 `\n` 与 ASCII）。更糟的是该文件当时
**尚未纳入 git**（`git status` 里是 `??`）⇒ `git checkout` 无从恢复。

**恢复方法（本例已验证，值得记住）**：DSH 会话日志完整记录了每一次 `write` / `edit` 工具调用。

```powershell
# ① 会话日志是**多帧 zstd**（zlib.zstdDecompressSync 只解第一帧；流式解码器不续帧）⇒ 扫魔数逐帧解
node $env:TEMP\restore\extract-log.mjs "<session.v4.jsonl.zstd>" out.jsonl
# ② 按**时间**重放 write/edit（不是 seq：编辑跨会话），callId 去重
node $env:TEMP\restore\rebuild-merged.mjs rebuilt.js session-父.jsonl session-子.jsonl
# ③ 交叉验证：node --check → 自检全绿 → 关键标识符计数与损坏版逐项对齐 → 乱码扫描(U+FFFD=0)
```

本例重建结果：1622 行、`node --check` 通过、**自检 281/281**、14 项标识符计数与损坏版一致。
两个坑：日志里存在**当年就失败**的编辑尝试（old_string 必然不命中，跳过即可）；
**最后一次 pwsh 改写不在日志里**（只有工具调用才有记录）⇒ 重建后要按已知清单手工补回。

**纪律（从此照此执行）**：

1. **禁止**用 pwsh / `Set-Content` 做整文件改写；要改就用 harness 的 `edit` 工具，或**显式 utf8**
   的 node 脚本（`readFileSync(p,'utf8')` / `writeFileSync(p,s,'utf8')`）。
2. **新建文件先做一次提交**（哪怕只本地、不推送）—— 未跟踪文件损坏 = 不可恢复。
3. 大改动前用 `git status` 确认目标文件**已被跟踪**；`??` 就是"没有安全网"的信号。

---

### 2.13 provider 报「零 usage」会把上下文占用**清零**（弹窗 0%，明细却有几万）

**现象**（2026-10-11 真机，用户在赠送额度通道上实测）：弹窗顶部「上下文已用 **0%** ~0 / 1M」，
而**同一个弹窗**的启发式明细还有「对话消息 ~383K」；侧栏用量行仍报 40%。两者自相矛盾。

**取证**（零额度，三个文件交叉）：

```powershell
# ① 插件账本：出现一行"未落定"的回合，input/output 都是 0
Get-Content "$env:USERPROFILE\.dsh\zcode-runs.jsonl" | Select-Object -Last 3
#   → {"…","input":0,"output":0,"exit":"app-server turn not settled","elapsedMs":561368}
# ② DSH 自己的投影缓存：压力锚点被写成 0
#   → contextPressure.val = {surfaceTokens:…, contextWindow:1000000, pressureTokens:0, …}
```

**根因**：宿主的 `dsh-token-meter` 把每次 assistant 消息的 usage 当
`contextPressure` 的锚点（`pressureFrom(usage) = inputTokens + cacheReadTokens + cacheWriteTokens`）。
适配器在"回合未落定"时**照样发了一个零值 usage 块** ⇒ 锚点被写成 0 ⇒ 占用显示 0%。
（对照：不发 usage 时宿主退回自己的启发式估值，明细那 383K 就是它算出来的。）

**修法**（`lib/app-server.js`）：

| 场景 | 上报 |
|---|---|
| 回合落定且有真实读数 | 按 `deriveReportedUsage` 折算后上报（§2.10） |
| 回合落定但全零 / CLI 没给 usage | **不发 usage 块**（宿主退回启发式估值） |
| 回合**未落定**（中止 / 超时） | 读 CLI 的**按次上下文**（`session/read → projection.contextUsed`）当锚点 —— 它描述"最后一次完成的模型调用"，中止时仍是真实读数；**既能避免清零，也能把已被清零的锚点自愈** |
| 未落定且读不到 | 不发 usage 块（宁缺勿错） |
| 本地生成的会话标题（`purpose=session-title`） | 不发 usage 块（无真实上游用量） |

自检侧用**假 transport 驱动真实 `stream()`**覆盖了这五种情形（usage 相关的 4 条断言：
未落定→用按次上下文、未落定+读不到→不发、全零→不发、本地标题→不发）。

> **通用教训**：**零不是"没有数据"**。任何会被下游当作"测量值"的字段，
> "拿不到"必须表达成**缺席**（不产生该事件/字段），而不是 0 —— 0 是一个具体结论，
> 下游会照它做决策（这里是"上下文占用 = 0"）。本仓库前后踩过两次同一个坑：
> §2.10 是"虚高"（把 N 次调用的和当一次），本次是"归零"（把未知当 0）。

---

### 2.14 模型档位选择器里多出一个 `Default` 项

**现象**（2026-10-11 真机）：选中 Coding Plan 的模型后，思考档下拉里第一项是 `Default`
（勾选态），下面才是 Low / High / Max；用户要求去掉。

**根因**（宿主源码取证，两层）：
- `dsh-llm-pi-ai` 的 `reasoningInfo(model, defaultLevel)`：`defaultLevel === undefined` 时
  **省略** `defaultEffort`；
- 前端（`dsh-acp`）见 `info.reasoning.defaultEffort === void 0` 就补一项
  `{ value: PROVIDER_DEFAULT_REASONING_VALUE, name: "Provider default" }` —— 就是那个 `Default`。
- 而 `defaultLevel` **只能来自 provider profile**（`profile.reasoning`），**没有 per-model 口子**。

**修法**（`index.js`）：让 `profile.reasoning` 由**自动判定**给出 —— `resolveDefaultReasoningEffort(configured, models)`：
用户显式配置优先；否则**只在当前暴露（已勾选）的每个模型都支持同一档时**取最强档
（`max → high → low` 依次试），否则不设（`none`）。这样：

- 常见情况（只勾官方 5.3 模型，档位表里 low/high/max 都在）⇒ 自动设 `max` ⇒ **`Default` 项消失**，
  且与 ZCode 官方 `defaultVariant=max` 一致；
- 勾了非推理模型（如未开推理开关的 GLM-5.3-FlashX）⇒ 自动退回不设（否则它**请求期硬失败**，
  见 `dsh-llm-pi-ai` 的无条件校验）；
- 面板保存后 `loader/volatile-update` 里**同步重算**并改写 profile（不必重启才生效）。

判据（两条都免重启）：启动日志里会打
`默认推理档自动设为 'max'（当前暴露模型全部支持）⇒ 选择器不再显示 "Default" 项`；
或 `默认推理档未自动设置：当前暴露模型并非全部支持同一档 ⇒ 选择器会保留 "Default" 项`。

> **通用教训**：UI 上"多出来的一项"往往来自**某个字段缺席**（这里是 `defaultEffort`），
> 而不是前端写死。定位路径 = 先在宿主包里搜该文案/常量，再顺藤摸到提供该字段的**唯一入口**
> （provider profile），最后确认这个入口有没有 per-model 变体（本例没有 ⇒ 只能在 provider 级做取舍）。

---

## 三、通用工程

### 3.1 用 `fetch` 后调 `process.exit()` 会崩（Windows）

**现象**：脚本逻辑全部正确、输出也正常，但退出码是 **`-1073740791`**，stderr 出现：

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

**根因**：用过 `fetch`（undici）后其 keep-alive 套接字尚未关闭时硬 `process.exit()`，
触发 Windows 上的 libuv 断言崩溃。

**修法**：不要硬 exit，改为设置退出码让事件循环自然收尾：

```js
main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => { console.error(err); process.exitCode = 1; });
```

### 3.2 "换个位置就红"的测试是资产

**现象**：把插件从 `A/` 移到 `B/` 后，自检从 47/47 掉到 46/47。

**结论**：**这不是回归，而是暴露了一个假绿**。原断言要求 `vendor === 'schemastery'`，
它之所以在旧位置通过，仅因 `A/node_modules/@deepseek-ai/schemastery` **恰好存在**
（该 `node_modules` 被 `.gitignore` 忽略，是本地开发树、**不属于任何包**）。

**修法**：断言改为「两条路径均须产出合法 schema，**并如实报告走了哪条**」——
把假绿变成**有信息量**的断言。

> **教训**：断言**不得依赖"恰好存在的相邻依赖"**；环境相关的通过必须显式声明。

### 3.3 过紧的断言会保护 bug

**现象**：某次自检里有一条断言 `inject 只声明 slots（最小失败面）` —— 当时被当作**优点**写进
注释与断言。后来发现正是这个"最小 inject"导致面板**永久只读**（见 2.2），
而**那条断言还在保护这个缺陷**。

**修法**：断言应断言**能力**（如"面板可写的前提服务齐备"），而非断言某个最小实现细节。

> **教训**：**把实现细节当契约写进断言，会把 bug 固化成"规范"。**

### 3.4 静态回退表要与远端同形

**现象**：面板首屏显示 `glm-5.3` 而非 `GLM-5.3`（网关的 `display_name`）。

**根因**：`lastCatalog` 初始化为**静态回退表**，而**动态发现是懒加载**（首次拉目录才更新）
⇒ 首次发现前只能看到静态表内容，而静态表原先只存 id。

**修法**：静态表自带展示名（取网关 `display_name` 的实测值 —— 稳定公开事实，写死无虚构风险）。

> **教训**：任何"远端目录 + 本地回退表"的结构，**回退表要与远端同形（含展示字段）**。

### 3.5 门禁命令的 exit code 禁止经管道取值

```bash
cmd | tail          # ❌ $? 是 tail 的退出码
cmd > log 2>&1; echo "GATE:$?"   # ✅
```

曾让"门禁通过"的假声称混进台账。**门禁一律显式取退出码。**

---

## 附：本插件自检覆盖了哪些坑

```bash
node test/selfcheck.mjs     # 纯静态零网络；断言数见输出末行（勿在文档里写死）
```

| 坑 | 对应断言 |
|---|---|
| 2.1 防拒启一致性 | `manifest 与文件一致性`、`client 信封自足`、`apply 不抛` |
| 2.2 面板可写 | `inject 含 slots+locale+remote`、`manifest 含 api-remotes` |
| 2.3 volatile | `Config 投影含 x-cordis.volatile` |
| 2.5 主题安全 | `CSS 无浅色硬编码回退`、`回退值主题无关`、`仅引用实测 token` |
| 2.6 描述字段 | `manifest 有顶层 description/displayName` |
| 1.1 / 1.2 凭据 | `解密正确性`、`验活 5 态（含 200+认证失败体的防假绿）`、`回退 4 态`、`诊断零明文` |
| 1.3 形态校验 | `形态不符 → 报诊断`、`命中但全被过滤 → 汇总诊断` |
| 3.2 假绿防护 | `Config 走 schemastery 或降级均须合法 + 如实报告` |
