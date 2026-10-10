# 全面审查任务书 —— dsh-connect-zcode

> **审查对象**：`@local/dsh-connect-zcode` v0.3.1（本仓库，DSH 插件：把 ZCode / 智谱 BigModel Coding Plan 注册为 DSH 的 LLM provider）
> **产出**：审查意见文档（只写的文档，**不动代码**）
> **下游**：Lead 汇总后**由 Lead 执行**修改
> **本任务书版本**：v1（2026-10-06）

---

## 0. 一句话任务

**你是审查者，不是修改者。** 你要读完这个项目，产出一份**可执行、可定位、有证据**的审查意见文档；每一条意见都要让 Lead 拿着它就能直接改代码，不需要再回来问你。**你不得修改仓库里的任何代码、配置、测试。**（详见 §7 铁律）

---

## 1. 项目背景（默认你零上下文，请先读这一段）

### 1.1 这是什么

一个 **DSH（DeepSeek Harness）宿主插件**，作用是把用户本机已登录的 **ZCode（Z.ai / 智谱 BigModel）Coding Plan 套餐**接入 DSH，让 DSH 能把这个套餐当 LLM provider 用。

关键词：**这是"寄生式"插件**——它不拥有凭据、不拥有登录流程、不拥有上游协议，全靠**读取别的程序的私有状态文件** + **复用宿主进程内的内部模块**来工作。

### 1.2 仓库结构与行数（真实统计，请以此为工作量地图）

| 文件 | 行数 | 中文注释字符数 | 角色 |
|---|---|---|---|
| `index.js` | 560 | 4329 | Host 半边：注册 provider 三部曲 + config schema + 门禁 |
| `lib/client.js` | 503 | 2742 | Client 半边：设置面板（ModuleLoader 信封 bundle，无构建链） |
| `lib/model-meta.js` | 156 | 1351 | 模型元数据层（官方 config 合并 / 5.3 系过滤 / 用户覆盖） |
| `lib/credential.js` | 148 | 1208 | 凭据读取 + 验活 + 凭据库回退 |
| `lib/credential-store.js` | 146 | 1157 | ZCode 加密凭据库解密（AES-256-GCM，格式逆向自 zcode.cjs） |
| `lib/discovery.js` | 99 | 923 | `/v1/models` 动态发现 + 静态回退 |
| `lib/host-modules.js` | 186 | 881 | 宿主内嵌模块（asar）候选链解析器 |
| `lib/web-status.js` | 125 | 560 | 面板只读状态路由（回环 + 脱敏） |
| `lib/api-instrument.js` | 135 | 550 | 信号量（并发预算 N=2）+ 流拦截记账 |
| `lib/switch.js` | 51 | 390 | 派发总开关（冻结语义） |
| `lib/ledger.js` | 54 | 271 | 额度台账 jsonl 追加 |
| `test/selfcheck.mjs` | 1116 | 6339 | 自检：146 项（当前全绿） |
| `scripts/sync-key-to-config.mjs` | 217 | 1187 | 独立恢复工具（把凭据库的 key 写回 config.json） |
| `README.md` | 220 | 5635 | 用户文档 |
| `TROUBLESHOOTING.md` | 477 | 7025 | 踩坑记录（23 个坑位） |
| `cordis.patch.yml` | 9 | 87 | profile 插桩 patch |

**代码总量约 2160 行 JS，注释与文档约 2200 行中文。注释密度是全项目最显眼的特征之一——这既是资产（记录了真机实证），也是 §5.2 简化的头号目标。**

### 1.3 依赖的宿主机外部契约（本项目全部"隐性依赖"的清单）

这是理解全部风险的钥匙。项目与外界有 **9 条耦合缝**，每条都可能被上游单方面打破：

| # | 耦合对象 | 形式 | 位置 |
|---|---|---|---|
| C1 | `~/.zcode/v2/config.json` | 读 `provider[planKey].options.{apiKey,baseURL}` + `.models` 段 | `lib/credential.js:53-73`、`lib/model-meta.js:49-78` |
| C2 | `~/.zcode/v2/credentials.json` | 逆向出的 `enc:v1` AES-256-GCM 解密 + secret 推导式 | `lib/credential-store.js`（全文件） |
| C3 | 宿主 `app.asar` 内嵌 node_modules | 候选链 + **硬编码相对文件路径** | `lib/host-modules.js:25-76` |
| C4 | `@earendil-works/pi-ai` 内部 | `createProvider` / `anthropicMessagesApi` 形状 | `index.js:449-510` |
| C5 | `@deepseek-ai/dsh-llm-pi-ai` 内部 | `PiAiAdapter` options 形状、`profile.*` 字段、`:1848` 校验行为 | `index.js:471-510`（注释里引用了行号） |
| C6 | `ctx.llm` 注册 API | `registerAdapter` / `registerModelDiscovery` / `registerConfigurableProviders` | `index.js:513-542` |
| C7 | `ctx.slots` / `configForms` / `settings` | client 面板 slot 契约 + 设置读写 | `lib/client.js:470-532` |
| C8 | bigmodel 网关 HTTP 行为 | 失效 key 返回 **HTTP 200 + body.code=1000** | `lib/credential.js:91-122` |
| C9 | ZCode 明文 key 形态 | 正则 `^[0-9a-f]{32}\.[A-Za-z0-9]{16}$`（长度恒 49） | `lib/credential-store.js:84`、`scripts/sync-key-to-config.mjs:51` |

### 1.4 已知的设计红线（审查时必须尊重，不要建议违反）

- **凭据零落盘、零缓存、零明文日志**：每次调用现读 config.json；任何错误消息/日志不得含 key 原文。
- **并发预算 N=2**（`maxConcurrent` 上限写死 2，不自动升限）。
- **派发总开关（PROTOCOL §7.1）**：开关关闭 = 套餐整体冻结，provider 通道也拒。
- **静态 import 只用 `node:` 内建与 `./lib/*`**；宿主包一律动态解析（`lib/host-modules.js`）。
- **不发明宿主 API**：全部照本机 `dsh-connect-trae@2.4.0` 同款实现抄写（注释中以 `trae :NNNN` 标注行号）。

---

## 2. 当前基线（动手前必须先复现这一步）

```powershell
cd "F:\My Code\dsh-connect-zcode"
node --version          # 基线实测 v24.14.1；package.json engines 要求 ^22.19.0 || >=24.0.0
node test\selfcheck.mjs # 基线实测：SELFCHECK PASS：146/146，退出码 0
```

**基线事实（已由 Lead 验证，可直接引用，但请自行复现一次）**：

- 仓库干净（`git status --porcelain` 为空），HEAD = `a2742f2`。
- 自检 146 项全绿，退出码 0，tmp 无残留。
- 无第三方运行时依赖（`dependencies` 段不存在），全部为 `peerDependencies`。
- 全仓库 `TODO` / `FIXME` / `HACK` / `eslint-disable` / `@deprecated` **零命中**——即"已知欠债"没有任何显式登记，全靠注释里的 ⚠️ 承载。

**关于自检的诚实局限（请重点验证这一点）**：`test/selfcheck.mjs` 是**单文件、1164 行、无测试框架**的巨型脚本，全部用 `await import('../lib/*.js')` 直接测真实模块。它**没有**覆盖：真实 asar 解析、真实面板渲染（用 stub react）、真实 DSH 进程内的注册链路、真实网关。**"146 项全绿"不等于"插件能用"——自检的结构性盲区本身可能是一条重要意见（见 §5.5）。**

---

## 3. 五个审查维度（每条意见必须明确归入其中之一）

### D1. Review —— 正确性与风险审查

找**真问题**，不是找风格：

- **逻辑缺陷**：边界条件、空值、竞态、错误吞噬（`catch {}` 空块的数量与后果）、状态机错误。
- **安全**：凭据泄漏面（日志/错误消息/台账/状态路由响应）、`writeJson` 的 header 完整性、回环判定是否可绕过（`originIsLoopback` 对 `Origin: null` / 畸形值的处理）、`fs` 路径注入、`scripts/sync-key-to-config.mjs` 的写入安全性。
- **正确性**：`toPiModel` / `buildCatalog` / `applyContextBudgets` 的语义是否与注释声称的一致；`instrumentApi` 的 Proxy 是否在所有消费路径下都正确（尤其**同一 `result` 被多次迭代**、`Symbol.asyncIterator` 之外的消费方式、`semaphore.release()` 是否可能双释放或泄漏）。
- **并发**：信号量在异常/中止路径下是否必然释放；`Semaphore.release()` 在 `queue` 非空时不减 `active` 的语义是否正确。
- **隐性耦合**：§1.3 的 C1–C9，每条问"上游变了我们会怎么坏？坏的时候用户看到什么？"
- **文档与代码不一致**：注释/README/TROUBLESHOOTING 声称的行为，代码里是否真的成立。（**本项目注释极多，这类不一致是重灾区，请逐条核对给出行号。**）

### D2. Simplify —— 简化审查

以"**删掉的行数**"为 KPI：

- **重复代码**：同一份常量/逻辑存在多个"同值副本"——例如 `SECRET_PATTERNS`（`lib/ledger.js:25` 与 `lib/web-status.js:17`）、`STATUS_PATH`（`lib/web-status.js:14` 与 `lib/client.js:31`）、`CONTEXT_1M`、`STATIC_MODEL_IDS`（`lib/discovery.js:19` 与 `lib/client.js:47`）、`unwrapLive` vs `unwrapLiveDeep`（`index.js:66` vs `lib/client.js:54-66`）、`decrypt` + `resolveSecret` + `API_KEY_RE` 在 `lib/credential-store.js` 与 `scripts/sync-key-to-config.mjs` 的**整段复制**。
  → 对每一处，回答：**跨半/跨进程是否真的不能共享？有没有低成本共享方案（生成脚本、单文件内联、构建期同步）？不共享的维护成本具体是什么？**
- **过度设计**：哪些抽象层其实只有 1 个调用方？哪些参数化从没被用过？
- **注释噪声**：注释里大量 `T18/T19/T20/T21/T22`、`trae :NNNN`、`PROTOCOL §x.y`、`ZB-01/Z13-1`、`§10.9` 等**外部上下文引用**——对一个独立维护者是不可解析的。请统计并给出**可搬走的清单**（哪些该留在代码里、哪些该搬进 `TROUBLESHOOTING.md`/ADR、哪些可删）。
- **代码形态**：`index.js` 560 行单文件、`registerZcodeProvider` 单函数约 210 行的拆分建议。

### D3. 强制性优化（Mandatory / Hardening）—— 必须做的加固

不是"可以考虑"，而是"**不做就是个坑**"的项目。判据：不做的后果是否是**静默失败 / 数据损坏 / 安全暴露 / 用户无法自救**。

已知候选（**你要验证真伪、补足证据、并继续挖掘**）：

1. `resolveSchemastery()` 失败 → 手写 fallback schema → DSH 判 `!isNativeConfigSchema` → **插件整体不激活**（`index.js:234-245` 注释自述）。是否存在"降级即静默失效"的其它同类点？
2. `lib/host-modules.js` 的候选文件路径（`dist/index.js`、`lib/index.js` 等）是**硬编码推断**；宿主升级换目录布局即失效，且失败信息可能不含足够线索。
3. `lib/credential-store.js:84` 的 `API_KEY_RE` 是**静默过滤**——ZCode 换 key 形态 ⇒ 全部候选被滤掉。
4. `lib/credential.js` 的验活**每次调用**都要打一次 `GET /v1/models`（网络往返在请求关键路径上）——失败/超时行为是什么？会不会每次调用都等 8 秒？（`timeoutMs` 默认 8000，`resolvePlanCredential` 在 store 回退路径下可能**串行验活 N 把 key**，最坏 N×8s。）
5. `lib/web-status.js:47` `originIsLoopback`：`hostname === '[::1]' || hostname === '::1'`——`new URL('http://[::1]:3000').hostname` 实际返回什么？写个脚本验一下，别猜。
6. `lib/api-instrument.js` 覆盖的只是 `stream` / `streamSimple` 两个入口——provider 是否还有别的调用路径**绕过**并发预算与记账？
7. `scripts/sync-key-to-config.mjs` 会**明文写入 `~/.zcode/v2/config.json`**（含 key）。备份文件 `config.json.bak-dsh-<stamp>` 是否被 `.gitignore` 覆盖？本仓库 `.gitignore` 里**没有** `*.bak-*` 规则——若用户把该目录纳入仓库就会泄漏凭据。请核实并给结论。
8. `lib/client.js:500` 命名空间匹配用 `/zcode/i`（`NS_PATTERN`）——**双 provider 或误匹配**风险。

### D4. 解耦（Decoupling）—— 切断隐性依赖

目标：**把"改上游就炸"的地方变成"有边界、可替换、可诊断"**。

- 对 §1.3 的 C1–C9 **逐条**给出解耦方案，并按 **成本 / 收益 / 风险** 排序。方案要具体到"改哪个文件、加什么边界、失败时用户看到什么"。
- 特别关注：
  - **凭据来源**（C1+C2）：现在是两条硬编码路径 + 逆向解密。是否该抽象成"凭据提供者"接口？
  - **宿主模块解析**（C3）：候选链 vs 注入 vs 显式配置。失败面如何收窄？
  - **pi-ai 适配**（C4+C5）：哪些是必需契约、哪些是"抄 trae 时抄进来的偶然事实"？如何在不发明 API 的前提下加一道**版本/形状校验**，让不兼容**早失败且可诊断**？
  - **client/host 双副本**（`STATUS_PATH` / 常量 / canon 函数）：跨半不能 import 是事实，但"同值副本"必须有**守卫**（自检里比对两份是否一致）——现在有没有？没有就是一条强制性优化。
  - **测试与实现的耦合**：`selfcheck.mjs` 直接 `import('../lib/*.js')` 测内部函数，改动内部实现即破坏测试。这是好的（白盒）还是坏的（脆）？给出立场与建议。

### D5. 文档与工程卫生（作为 D1–D4 的支撑，可单列小章节）

- README / TROUBLESHOOTING 与代码的一致性抽样核对（**至少抽查 5 条声称**，给出成立/不成立的证据）。
- `package.json` 的 `files` 字段、`exports`、`engines`、`peerDependencies` 上限 `<0.3.0-0` 的合理性（宿主升级后是否会静默失配？）。
- 无 lint / 无格式化 / 无 CI / 无 `typecheck`（纯 JS 无类型）——**在 2160 行 + 9 条外部耦合的规模下，这是否是必须补的强制性优化？** 给出明确立场（要/不要，为什么）。
- `.gitignore` 是否覆盖了本项目实际会产生的一切敏感/临时产物（备份文件、台账、开关文件、临时写入 `*.dsh-tmp-*`）。

---

## 4. 输出格式（**严格遵守，Lead 要按这个结构直接改**）

产出一个 Markdown 文件：**`REVIEW-REPORT.md`**（放在仓库根目录），结构如下：

```markdown
# dsh-connect-zcode 全面审查报告
（元信息：审查者、时间、审查基线 commit、自检基线结果、审查方法）

## 0. 执行摘要
- 一句话结论（这个项目现在处于什么状态）
- Top 5 最高优先级问题（每条一行，带 [编号] 与严重度）
- 建议的执行顺序（Lead 先做什么、后做什么）

## 1. 审查方法与环境
（你实际跑了什么命令、读了什么、哪些结论是实测、哪些是推理——**必须区分**）

## 2. 发现清单（主体）
每条发现用**完全一致**的模板：

### [D1-01] 标题：一句话说清问题
- **维度**：Review / Simplify / 强制性优化 / 解耦
- **严重度**：🔴 阻断 / 🟠 高 / 🟡 中 / 🔵 低（定义见 §5.1）
- **位置**：`lib/xxx.js:123-145`（**必须给行号；跨文件给全**
- **证据**：实测输出 / 代码原文引用 / 推理链。**实测与推理必须标注清楚**
- **影响**：不修会怎样（用户可见的具体现象，不要写"可能有问题"）
- **建议方案**：具体到"改哪个文件、怎么改"。若有多方案，给 A/B 并说推荐哪个、为什么
- **改动成本**：S（<30 行）/ M（30-150 行）/ L（>150 行 或 涉及架构调整）
- **验证方式**：改完怎么证明修好了（可执行命令 / 自检项 / 手工步骤）
- **依赖/冲突**：与其它发现的关联（会不会改 A 就必须改 B）

## 3. 跨维度综合判断
- 架构层面的整体问题（不要重复罗列单条）
- 哪些"耦合"是**必须接受的**（说出来，避免 Lead 过度重构）
- 哪些"复杂"是**真复杂度**（业务本身难），哪些是**假复杂度**（自己造出来的）

## 4. 建议的简化清单（可量化）
| 编号 | 可删除/合并的对象 | 预估行数变化 | 风险 | 前置条件 |

## 5. 建议的解耦路线图（按投入产出排序）
| 阶段 | 动作 | 收益 | 成本 | 风险 |

## 6. 不建议做的事（反建议）
（明确列出"看起来该改但实际不该改"的项，并说明原因——防止 Lead 过度重构）

## 7. 附录
- A. 实测命令与原始输出
- B. 未覆盖 / 无法验证的盲区（诚实列出）
- C. 与现有文档（README/TROUBLESHOOTING）的不一致清单
```

---

## 5. 质量要求

### 5.1 严重度定义（**不得随意使用**）

- 🔴 **阻断**：会导致插件完全不可用 / 凭据泄漏 / 数据损坏 / 静默失效且用户无法自救。
- 🟠 **高**：特定常见场景下功能失败，或失败时完全无诊断线索（排查成本极高）。
- 🟡 **中**：功能降级、维护成本显著、或错误路径处理不当但可绕过。
- 🔵 **低**：整洁性、可读性、文档改进。

**要求**：🔴 与 🟠 的判定必须保守——说得出"什么条件下触发、触发后用户看到什么"。**宁可降级也不要夸大。**

### 5.2 硬性质量规则

1. **零 AI 废话**。禁止"建议加强错误处理""注意代码质量""建议增加注释"这类无信息量的句子。每句话要么是事实，要么是可执行动作。
2. **行号是硬要求**。任何指向代码的意见不给行号 = 无效意见。
3. **区分实测与推理**。跑了命令得到的结果标 `[实测]`；读代码推断的标 `[推理]`。**混为一谈是本任务最严重的质量事故。**
4. **禁止修改代码**。包括测试、文档、配置。你的产出只有 `REVIEW-REPORT.md` 这一个文件。
5. **禁止编造**。不确定就写"未验证"，并给出验证方法。**不要为了凑数编造问题。**
6. **允许"没发现问题"**。某些模块审下来确实干净，就明确写"本模块未发现 D1–D4 级问题"，并说明你检查了什么（证明你确实审了）。
7. **反建议同样重要**。明确写出"看起来该改但不该改"的项，防止 Lead 过度重构。
8. **中文**。术语可保留英文（provider / stream / semaphore 等）。
9. **可复现**。所有 `[实测]` 结论必须给出可复制的命令和原始输出片段。

### 5.3 覆盖度要求（**这是验收项，Lead 会核对**）

- `index.js`、`lib/client.js`、`lib/host-modules.js`、`lib/api-instrument.js`、`lib/credential-store.js`、`lib/credential.js`、`lib/model-meta.js` 这 **7 个高风险文件必须逐个点名**，每个至少给一条结论（包括"未发现问题"）。
- `test/selfcheck.mjs` 必须给出评估：**它的 146 项到底保护了什么？盲区在哪？**
- §1.3 的 **C1–C9 九条耦合必须逐条回应**，一条都不能漏。
- 至少 **5 条** README/TROUBLESHOOTING 与代码的一致性抽查结论。

### 5.4 交付前自检（**你必须自己跑一遍再交**）

- [ ] 每条发现都有：维度 / 严重度 / 行号 / 证据 / 影响 / 建议 / 成本 / 验证方式
- [ ] 所有 `[实测]` 都有可复制命令
- [ ] C1–C9 全部有回应
- [ ] 7 个高风险文件全部点名
- [ ] §4 的 6 个表格/清单章节都没漏
- [ ] 全文没有"建议加强""注意""可以考虑"这类空话
- [ ] `git status --porcelain` 只显示 `REVIEW-REPORT.md` 一个新增文件（**证明你没动代码**）
- [ ] 报告长度 ≥ 400 行（轻量报告不足以支撑 Lead 执行）

---

## 6. 建议的审查路径（不是必须，但能省时间）

```powershell
# 0. 基线复现（必须先做）
cd "F:\My Code\dsh-connect-zcode"
git log --oneline -3
git status --porcelain
node --version
node test\selfcheck.mjs

# 1. 规模地图
Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.git\\' } |
  Select-Object Name, Length

# 2. 逐文件精读（按风险从高到低）
#    index.js → lib/host-modules.js → lib/client.js → lib/credential-store.js
#    → lib/credential.js → lib/api-instrument.js → lib/model-meta.js → 其余

# 3. 针对具体怀疑点写一次性验证脚本（放 %TEMP%，不要放仓库！）
#    例：验 originIsLoopback 对 [::1] 的实际行为
node -e "console.log(new URL('http://[::1]:3000').hostname)"
#    例：验 Semaphore 在异常路径是否泄漏预算
#    例：验 instrumentApi 包装后的 result 被迭代两次会怎样
#    例：验 applyContextBudgets / buildCatalog 的边界输入

# 4. 交付前确认没动代码
git status --porcelain
```

**验证脚本纪律**：临时脚本一律写在系统临时目录（`$env:TEMP`），**不要写进仓库**；跑完删除。若确实需要留在仓库做证据，只能留文本片段进报告，不得新增文件。

---

## 7. 铁律（违反即任务失败）

1. **只写 `REVIEW-REPORT.md` 一个文件。** 不得修改、新建、删除仓库内任何其它文件（包括测试、文档、配置、`.gitignore`）。
2. **不得执行任何会改变系统状态的命令**：不安装包、不改 `~/.zcode/*`、不写 `~/.dsh/*`、不跑 `scripts/sync-key-to-config.mjs`（**它会真实写用户的凭据文件**；只许读它的源码，不许执行）。
3. **不得发起真实网络请求**：不调 bigmodel 网关、不读真实 `~/.zcode/v2/config.json` 的内容（若确需确认"文件是否存在"，只许 `Test-Path`，不得打印内容）。
4. **不得为了"显得审得深"而编造问题。** 证据不足就标"未验证"并给验证方法。
5. **不得建议违反 §1.4 设计红线**的方案（如"把 key 缓存到磁盘""提高并发上限到 N""在 client 半直接读文件"）。若你认为某条红线本身有问题，**单独开一节论证**，不要混在建议里。

---

## 8. 完成定义（Definition of Done）

任务完成 = **同时满足**以下全部：

1. 仓库根存在 `REVIEW-REPORT.md`，长度 ≥ 400 行，结构符合 §4。
2. `git status --porcelain` 的输出**只有** `?? REVIEW-REPORT.md`（一行）。
3. §5.3 覆盖度要求全部满足（C1–C9、7 个高风险文件、5 条文档抽查）。
4. §5.4 交付前自检清单全部勾选，且清单本身出现在报告末尾（附实测的 `git status` 输出）。
5. 报告里每条 🔴/🟠 级发现都能被 Lead 独立复现（证据可复制）。

---

## 9. 交给 Lead 的一段话（模板，你的最终回复必须包含）

审查完成后，你的最终回复必须包含以下结构（Lead 会据此汇总执行）：

```
【审查完成】
报告路径：REVIEW-REPORT.md（N 行）
审查基线：commit a2742f2，自检 146/146 通过
未改动代码：是（git status 仅 REVIEW-REPORT.md）

发现统计：🔴 N 条 / 🟠 N 条 / 🟡 N 条 / 🔵 N 条
Top 5 必改：
  1. [D?-NN] ...（为什么）— 建议动作：...
  2. ...
简化收益预估：可净删约 N 行，涉及 M 个文件
解耦路线：第一优先 C? （成本 S/M/L，收益 ...）

我认为**最容易被误改**的地方（反建议）：
  - ...
我**没有**验证的盲区：
  - ...
```

---

## 10. 附：Lead 已初步观察到的疑点（**交给你验证，不要直接抄进报告**）

以下只是线索，**其中可能有一半是伪问题**。请逐条实测或读码验证，**成立才写、不成立就写"经核实为非问题"并说明理由**：

1. `lib/web-status.js:47` —— `new URL('http://[::1]:3000').hostname` 在 Node 里到底返回 `[::1]` 还是 `::1`？两个分支是不是有一个永远不成立？（一行命令就能验）
2. `lib/api-instrument.js:33-37` —— `Semaphore.release()` 在 `queue` 非空时**不减 `active`**，而是直接把名额交给下一个等待者。这是对的还是错的？构造一个"并发 3、limit 2、其中一个 reject"的场景实测。
3. `lib/api-instrument.js:120-126` —— Proxy 只拦截 `Symbol.asyncIterator`；若消费方用 `result.next()`（而非 `for await`）或拿到 `Symbol.asyncIterator` 后**调用两次**，会怎样？
4. `lib/credential.js:144-172` —— `resolvePlanCredential` 在最坏路径上是 **2 + N 次串行 `GET /v1/models`**（config 验活 1 次 + 每个候选 1 次），每次都带 `timeoutMs 8000`。这条路径在**每次 API 调用**都会被 `resolveApiKey` 走到吗？（读 `index.js:498` 与 pi-ai 适配器行为）若会，最坏延迟是多少？是否有缓存必要（注意：不能违反"零缓存"红线——请论证）？
5. `lib/discovery.js:120` —— `filterGlm53Family` 是**硬编码 3 个 id**。上游新增 `glm-5.3-pro` 时用户**看不到新模型**，且**没有任何提示**。这是产品决策还是缺陷？
6. `lib/client.js:500` —— `NS_PATTERN = /zcode/i` 配 `.find(...)`，若同时装了多个 zcode 相关插件会**静默绑错命名空间**。
7. `scripts/sync-key-to-config.mjs:199` —— 备份文件名 `config.json.bak-dsh-<stamp>` **含明文 key**，且本仓库 `.gitignore` 未覆盖该模式。
8. `lib/host-modules.js:113` —— `bareAttempted` 是**模块级 Set**（每进程只试一次裸导入）。若宿主在运行中改变了模块解析环境，这套缓存会不会产生"第一次失败就永久失败"？
9. `index.js:248` —— `export const Config = await loadConfig()` 是**模块加载期顶层 await**。若它抛（catch 里已兜底）或挂起，插件加载会怎样？DSH 对顶层 await 的容忍度？
10. `index.js:596-638` —— `apply()` 是**异步 fire-and-forget**（`resolveHostLlmModules().then(...)`）。`ctx.effect` 的卸载与 `disposed` 标志的竞态：卸载发生在 `.then` 之前会怎样？（代码里有 `if (disposed) return;`，但 `offs.push` 之后才注册的 `ctx.effect` 顺序是否正确？）

**最后提醒**：你的价值不在于"找到了多少问题"，而在于**每一条都能让 Lead 直接动手**。宁可 20 条扎实的，不要 60 条注水的。
