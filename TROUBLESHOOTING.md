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
- [二、DSH 插件机制](#二dsh-插件机制)
  - [2.1 声明了 `dsh.client` 却缺 `lib/client.js` → DSH 拒绝启动](#21-声明了-dshclient-却缺-libclientjs--dsh-拒绝启动)
  - [2.2 设置面板全灰不可点：`configForms` 没被激活](#22-设置面板全灰不可点configforms-没被激活)
  - [2.3 面板"看起来保存成功"实则回弹：缺 volatile 标记](#23-面板看起来保存成功实则回弹缺-volatile-标记)
  - [2.4 宿主包必须走 asar 候选链；asar 内部不能用 `existsSync` 探测](#24-宿主包必须走-asar-候选链asar-内部不能用-existssync-探测)
  - [2.5 深色主题出现白块：token 名写错 + 浅色回退值](#25-深色主题出现白块token-名写错--浅色回退值)
  - [2.6 插件列表不显示描述：字段写错位置](#26-插件列表不显示描述字段写错位置)
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
| **Start Plan**（赠送/活动额度） | 账户 **JWT**，且端点需要 **Aliyun 无痕验证码凭证**（由 ZCode renderer 逐请求签发） | ❌ **不可** —— 直连返回 `{"code":3007,"msg":"captcha verify failed"}` |

社区项目（如 `dsh-zcode-connector`）断言"ZCode 无可提取 Key、只能 CDP 驱动 GUI"，
**那是 Start Plan 形态的限制，不是 ZCode 的普遍限制**。

本插件只接 Coding Plan（api-key 形态），并对 start-plan 的 JWT 形态**显式拒绝**而非静默失败：

```
该条目是 start-plan 账户 token 而非 API Key，本插件不支持：
请改用 builtin:bigmodel-coding-plan（api-key 形态）的登录条目。
```

> **通用教训**：**别把单一账号形态的结论当成普遍结论**。
> 排查"能不能接"时，先分清对方有几种凭据形态、你手上是哪一种。

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
  "name": "@local/dsh-connect-zcode",
  "displayName": "DSH Connect ZCode",        // ← 顶层
  "description": "把 ZCode … 接入 DeepSeek Harness…",  // ← 顶层（DSH 读这里）
  "meta": { "title": "…", "description": "…" }          // ← 这个 DSH 不读
}
```

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
node test/selfcheck.mjs     # 140 断言，纯静态零网络
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
