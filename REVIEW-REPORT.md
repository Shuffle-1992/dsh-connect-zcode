# dsh-connect-zcode 全面审查报告

> **审查对象**：`@local/dsh-connect-zcode` v0.3.1（HEAD = `a2742f2`）
> **审查者**：ZCode 审查 agent（按 `REVIEW-TASK.md` v1 执行）
> **审查时间**：2026-10-06
> **自检基线**：`node test/selfcheck.mjs` → **146/146 PASS，退出码 0**（本机实测复现）
> **环境**：Windows 10.0.19045 / Git Bash / node v24.14.1（`package.json` engines `^22.19.0 || >=24.0.0` 满足）
> **审查方式**：全部 17 个仓库文件逐行精读（含 `test/selfcheck.mjs` 1164 行）；10 个一次性验证脚本在系统临时目录运行（未入仓库、已删除）；**未执行** `scripts/sync-key-to-config.mjs`；**未发起**任何到达真实网关的网络请求；**未读取**真实 `~/.zcode/v2/config.json` 内容。
> **证据标注**：`[实测]` = 本机命令可复现（命令与原始输出见附录 A）；`[读码]` = 静态代码推理；`[未验证]` = 明确标注并给验证方法。

---

## 0. 执行摘要

**一句话结论**：这是一个纪律意识很强、失败面设计普遍保守（fail-safe 方向正确）的寄生式插件；**没有发现 🔴 级问题**，但存在 3 条 🟠：自检纪律存在真实破口（每次运行读取并解密真实凭据库）、验活超时在外部 signal 下静默失效、流中止后内层上游流不关闭（额度继续消耗而台账记 null）。另有约 13 条 🟡 集中在"失败无诊断线索"与"同值副本无守卫"两个主题上。

**Top 5 必改**：

1. **[R-01] selfcheck 的"零网络零凭据"纪律破口** —— `test/selfcheck.mjs:858` 在 fetch 投毒（:865）之前调用了真实 `resolveApiKey`，回退路径按默认路径读取并解密真实 `~/.zcode/v2/credentials.json`（[实测] 日志"2 个候选"，fixture 只有 1 把）。建议：apply config 加 `credentialFallback: false` + 投毒提前到 import 之前。成本 S。
2. **[R-03] 消费者中止后内层流永不关闭** —— `lib/api-instrument.js:101-119` 的 `finally` 不向 `source` 传播 `return()`，上游网关继续生成、token 继续消耗，台账却只记 `aborted` 且 usage 为 null（[实测]）。建议：finally 中 `await source.return?.()`。成本 S。
3. **[R-02] `validateApiKey` 传入外部 signal 时 `timeoutMs` 完全失效** —— `lib/credential.js:95-97` 定时器 abort 的是内部 AbortController，请求却绑定外部 signal（[实测] 200ms 超时形同虚设）。建议 `AbortSignal.any([io.signal, ac.signal])`。成本 S。
4. **[DE-04] C5（dsh-llm-pi-ai options/profile 形状）无启动期形状自检** —— 挂错位置即静默无效是该耦合的已实证失败模式（TROUBLESHOOTING §2.7），当前只有"函数存在"级校验。建议：注册后立即断言 `adapter.options` 关键键 + 启动日志输出宿主包版本。成本 S~M。
5. **[DE-10] 跨半同值副本（`STATUS_PATH`/`CONTEXT_1M`/`STATIC_MODEL_IDS`）零守卫** —— client 半三个字面量副本与 host 半真值无任何一致性断言，漂移即静默错绑/静默失效。建议 selfcheck 加 3 条源码级断言。成本 S。

**建议执行顺序**：先做全部 S 级修复（R-01/R-02/R-03 + DE-10 守卫，一个下午的工作量，全部可由 selfcheck 回归）；再做 DE-04 形状自检与 H-01 最小 CI；最后做注释/简化清理（S 系列）与文档同步（附录 C）。R-05（排队中止挂起）需要 Lead 决策，不进第一批。

**发现统计**：🔴 0 条 / 🟠 3 条 / 🟡 13 条 / 🔵 19 条（共 35 条）。

---

## 1. 审查方法与环境

### 1.1 基线复现（全部 [实测]）

```
PS> git log --oneline -3
a2742f2 docs(TROUBLESHOOTING): Start Plan 第二轮实验 —— 账号路径也用不了（三重证据）
517f3f5 fix(attachments): profile 补图片请求预算 —— 修 Image request width 报错
e1ceac0 docs(TROUBLESHOOTING): Start Plan 真实阻断点 = V4 客户端签名（非验证码）

PS> node --version
v24.14.1

PS> node test\selfcheck.mjs
SELFCHECK PASS：146/146
tmp 已删除：…（残留 否）
EXIT=0
```

**与任务书基线描述的一处偏差**：任务书 §2 称"仓库干净（`git status --porcelain` 为空）"，实测为：

```
?? HANDOFF.md
?? REVIEW-TASK.md
```

这两个未跟踪文件是审查任务开始前即存在的（任务书与交接文档本身），非本审查产生。**本审查结束时的新增文件仅 `?? REVIEW-REPORT.md`**（见附录 A 末尾的交付自检输出）。

### 1.2 实际执行过的验证（全部脚本位于 `%TEMP%\zcode-review\`，跑完已删）

| 脚本 | 验证点 | 结论 |
|---|---|---|
| `sem.test.mjs` | 信号量转交/中途抛错/幽灵释放/`.next()` 绕过/内层流关闭 | A1/A2 正确；A3 挂死实锤；A4 绕过实锤；A5 内层不关闭实锤 |
| `sem2.test.mjs` | A3 恢复路径/A4 复测/A5 复测 | 配对最终正确；绕过与不关闭复现实锤 |
| `timeout.test.mjs` / `timeout2/3` | `validateApiKey` 超时 × 外部 signal | 传 signal 时超时失效实锤（601ms vs 对照 206ms） |
| `loopback.test.mjs` | 回环判定边界 18 组输入 | 无安全绕过；`hostname === '[::1]'` 实锤 |
| `gate2.test.mjs` | gate 回退路径读取的凭据库默认路径 | USERPROFILE 重定向后路径跟随变化实锤 |
| `ledger.test.mjs` | `readLastLedgerRow` 全文件读耗时 | 97MB/40 万行 → 244ms 实锤 |
| `edges.test.mjs` | buildCatalog/normalize/边界防御 | 防御全部成立；`contextWindow:-5 → 1` 实锤 |
| `race.test.mjs` | `apply()` disposed 竞态两时序 | 两种时序均正确 |

### 1.3 明确未做的事

- 未执行 `scripts/sync-key-to-config.mjs`（只读了源码）。
- 未向 `open.bigmodel.cn` 或任何真实主机发请求（所有 fetch 均为注入假体或对 RFC 2606 保留 TLD `example.test`/`example.invalid`，且实测中 DNS 不解析、请求未出网）。
- 未读取真实 `~/.zcode/v2/config.json` 与 `credentials.json` 内容（仅通过 `Test-Path` 类存在性确认间接推理；真实凭据库的条目数"2"来自 selfcheck 自身运行的日志输出，非本审查直接读取）。
- 未在 DSH 宿主进程内运行任何代码（宿主内行为一律标 `[读码]` 或 `[未验证]`）。

---

## 2. 发现清单

> 模板：维度 / 严重度 / 位置（行号）/ 证据 / 影响 / 建议方案 / 改动成本 / 验证方式 / 依赖冲突。
> 成本：S（<30 行）/ M（30-150 行）/ L（>150 行或架构调整）。

### 2.1 Review 维度（R 系列）

---

#### [R-01] selfcheck 的"零网络零凭据"纪律存在真实破口：resolveApiKey 测试用真实 fetch 并按默认路径读取真实凭据库

- **维度**：Review
- **严重度**：🟠
- **位置**：`test/selfcheck.mjs:858`（`await opts.resolveApiKey(...)`）；`test/selfcheck.mjs:865-868`（fetch 投毒在此**之后**才发生）；`index.js:388-400`（gate 调 `resolvePlanCredential` 时**不传** `fetchFn`/`storePath`）；`lib/credential.js:160`（`readStoredApiKeys(io.storePath ?? defaultCredentialStorePath())`）；`lib/credential-store.js:37-39`（默认路径 = `<homedir>/.zcode/v2/credentials.json`）
- **证据**：
  - [实测] 基线 selfcheck 运行输出中夹带两行日志：`[dsh-connect-zcode] config.json 中的 API Key 验活失败（401/网络），尝试回退到 ZCode 加密凭据库` 与 `[dsh-connect-zcode] 凭据库中 2 个候选均验活失败，沿用 config.json 原值`。selfcheck 的 fixture 只加密了 **1** 把 key（`selfcheck.mjs:146-155`，单一 `enc` 条目）；"2 个候选"只能来自真实用户凭据库（README:253-254 的真机示例同样是 individual + team 两把）。
  - [实测] 重定向 `USERPROFILE` 到临时目录 + fetch 投毒后调用同一 `resolveApiKey`，日志变为 `凭据库不可读或不是合法 JSON：<fakehome>\.zcode\v2\credentials.json（ENOENT）`——证明该回退路径读取的正是由 `homedir()` 推导的默认真实路径。
  - [读码] `selfcheck.mjs:858` 先于 `:865` 的 fetch 投毒执行；此时 `validateApiKey`（`lib/credential.js:93` `io.fetchFn ?? fetch`）使用全局 fetch 向 fixture baseURL `https://example.test/api/anthropic/v1/models` 发起真实请求（DNS 解析 `.test` 失败，请求未出网）；**凭据库候选的验活同样使用该全局 fetch**（`lib/credential.js:166`）。
- **影响**：三层。① selfcheck 自述的两条纪律（`selfcheck.mjs:5-6`"不产生任何网络请求（fetch 全程投毒）；不读真实 ~/.zcode/v2/config.json 内容"）被确定性地打破——每次在装有 ZCode 的机器上跑 selfcheck 都会读取并解密真实凭据。② 真实 key 被解密进内存后作为 `x-api-key` 头发往 fixture URL；当前被 `.test` TLD 不可解析兜住，但若 DNS 环境异常（企业 wildcard DNS、hosts 劫持、本机代理工具的假 TLD 解析），**真实凭据将外发到不可控地址**。③ DNS 解析慢的环境下 selfcheck 最坏增加 3×8s 串行等待。
- **建议方案**（两处都做，共 2 行）：
  - A：`selfcheck.mjs:810`（及 ：881/:918/:939 的各次 apply）的 config 增加 `credentialFallback: false` → gate 走 `lib/credential.js:152-155` 的逃生口，验活失败后不读凭据库、沿用 config 原值，现有断言（`返回 key === fakeKey`）不变。
  - B：把 fetch 投毒从 `selfcheck.mjs:865` 提前到 `:735`（`import('../index.js')`）之前，保证模块加载与全部 gate 路径零真实 fetch。
- **改动成本**：S
- **验证方式**：重跑 selfcheck：① 输出中不再出现"尝试回退到 ZCode 加密凭据库"；② 仍 146/146 PASS；③ 断网/断 DNS 环境下耗时无异常。
- **依赖/冲突**：无。注意方案 A 不得改生产代码（`credentialFallback` 是已有 config 项，测试侧注入即可）。

---

#### [R-02] `validateApiKey` 传入外部 signal 时，`timeoutMs` 定时器完全失效

- **维度**：Review
- **严重度**：🟠
- **位置**：`lib/credential.js:95-97`
- **证据**：[实测] 假 fetch 监听 `init.signal` 且永不主动返回：传 `signal: external.signal, timeoutMs: 200` 时函数 601ms 才返回（外部 600ms abort 才生效）；对照组不传 signal → 206ms 超时正常生效。根因：`const timer = setTimeout(() => ac.abort(), ...)` 只 abort 内部 `ac`，而 `const signal = io.signal ?? ac.signal` 在传入外部 signal 时请求绑定的是外部 signal，`ac.signal` 未接入请求。
- **影响**：全代码库唯一传入 signal 的调用点是发现回调（`index.js:524` 传 cancellation signal）。目录刷新遇到半开连接/无响应网关时，验活挂起到 DSH 侧 signal 触发为止；DSH 不取消时挂到 undici 默认超时（分钟级）。用户可见现象："刷新模型目录长时间无响应"。推理主路径的 gate（`index.js:390`）不传 signal，8s 超时正常，不受影响。
- **建议方案**：`lib/credential.js:97` 改为信号组合：`const signal = io.signal ? AbortSignal.any([io.signal, ac.signal]) : ac.signal;`（[实测] 本机 Node 24 `AbortSignal.any` 可用；engines 下限 22.19 同样具备，Node 20.3+ 引入）。
- **改动成本**：S
- **验证方式**：重跑超时对照脚本：传外部 signal 时 elapsed ≈ `timeoutMs` 而非外部 abort 时刻；selfcheck 验活 5 态仍 PASS。
- **依赖/冲突**：无。

---

#### [R-03] 消费者提前退出时，内层流不被关闭：上游继续生成、额度继续消耗、台账只记 aborted 且 usage 为 null

- **维度**：Review
- **严重度**：🟠
- **位置**：`lib/api-instrument.js:100`（`const source = result[Symbol.asyncIterator]()`）与 `:115-118`（`finally { finish(...) }` **未调用** `source.return?.()`）
- **证据**：[实测] 内层 generator 带 `finally` 标记：消费者 `for await ... break` 后 30ms，内层 `finally` 未执行（关闭标记为 false），台账行 `exit="error: aborted"`。JS 迭代协议义务是"外层迭代器终止时向内层传播 `return()`"，`observed` 未履行。
- **影响**：用户在 DSH 中止请求 → dsh-llm-pi-ai 对 wrapped 流调 `return()` → `observed` 终止并记账 `aborted`（input/output=null）→ 原始 pi-ai 事件流无人关闭。若 pi-ai 流依赖 `options.signal`，则中止经 signal 由上游兜底（[读码] 未验证 pi-ai 是否如此）；对不依赖 signal 的消费路径（例如消费者直接 break 而无 abort 信号），上游网关会继续生成到自然结束——**额度继续消耗而台账无记录**。对一个以"额度记账"为核心目的的模块，这是记账语义的真实漏洞。
- **建议方案**：`lib/api-instrument.js` 的 `finally` 块改为：
  ```js
  } finally {
    try { await source.return?.(); } catch { /* 内层清理失败不影响记账 */ }
    finish({ message: 'aborted' }, usage);
  }
  ```
  注意顺序：先传播 return 再 finish，保证正常完成路径（`done` 后走到 finally）时 `source.return?.()` 是空操作（generator 已完成），不影响现有记账断言。
- **改动成本**：S
- **验证方式**：重跑 [A5] 脚本（内层 finally 标记应变为 true）；selfcheck"拦截: 提前 return 也记账"与"流完成记一次账"两项仍 PASS（确认正常路径不产生双重记账）。
- **依赖/冲突**：与 R-05 同在一个 finally 区域，建议同一次修改评审；与 R-04 独立。

---

#### [R-04] Proxy 只拦截 `Symbol.asyncIterator`：直接 `.next()` 消费完全绕过并发预算与记账，且多条消费路径无协调

- **维度**：Review
- **严重度**：🟡
- **位置**：`lib/api-instrument.js:120-126`（Proxy get trap）
- **证据**：[实测] ① `wrapped.stream(...)` 返回的 Proxy 上直接 `await result.next()`：事件到达、`record` 零调用、信号量未持有——**预算与记账双双静默绕过**；② `result[Symbol.asyncIterator]()` 调用两次返回同一 `observed` 实例（无重复记账，此点安全）；③ 先 `.next()` 再 `for await`：事件被两条路径瓜分（第一个事件被 `.next()` 吃掉），两条路径合计零记账。
- **影响**：当前 dsh-llm-pi-ai 以 `for await` 消费（`lib/api-instrument.js:5-7` 注释声称 T20 实证），不触发。但这是本项目两条红线（N=2 预算 + 额度记账）共同依赖的**单一假设**：上游改用手动迭代即全部静默失效，且无任何报警（记账行直接消失而非出错）。
- **建议方案**：get trap 对迭代器方法也转发到 `observed`，把手动迭代纳入同一监管：
  ```js
  get(target, prop) {
    if (prop === Symbol.asyncIterator) return () => observed;
    if (prop === 'next' || prop === 'return' || prop === 'throw') {
      return (...args) => observed[prop](...args);
    }
    ... // 原有 Reflect.get 分支不变
  }
  ```
  该改动不改变 `for await` 行为（for await 取的就是 `observed`），只消除绕过面。
- **改动成本**：S
- **验证方式**：重跑 [A4]：`.next()` 路径下 `record` 有调用、信号量被持有；selfcheck 三个拦截断言仍 PASS。
- **依赖/冲突**：与 R-03 同文件相邻区域，一并修改一并回归。

---

#### [R-05] 并发排队中消费者中止：清理协程被阻塞到名额轮转（无泄漏，但中止响应性退化为排队时长）

- **维度**：Review
- **严重度**：🟡
- **位置**：`lib/api-instrument.js:104`（`await env.semaphore.acquire()` 位于 generator body 内）
- **证据**：[实测] limit=1、名额被占、启动 wrapped 流触发排队，然后 `it.return()`：该 promise **长期不 settle**（脚本以 unsettled top-level await 被 Node 强杀，exit 13）；释放名额后 `return` 立即 settle、记账 `aborted` 一条、`active` 归零、新 acquire 正常——**最终配对正确，无预算泄漏**。
- **影响**：async generator 挂起在 `await acquire` 时，`return()` 要等当前 await 完成才走 finally。dsh-llm-pi-ai 的 `for await break` 会 await `return()`（AsyncIteratorClose 语义）——即**中止一个排队中的请求，其整条处理协程要挂着等前面两个流结束**（长对话下可达分钟级）。不是泄漏，是中止响应性缺陷。
- **建议方案**（两选一，需 Lead 决策）：
  - A（保守，推荐先做）：接受现状，在 `lib/api-instrument.js:104` 处补注释说明该语义（"排队中中止的清理协程将等待名额轮转；配对最终正确"）。
  - B（修复）：`acquire` 与外部中止信号竞速——`Promise.race([env.semaphore.acquire(), abortPromise(options.signal)])`，中止时直接以异常退出 generator（注意：race 输了的一侧若稍后 resolve，名额会被静默多放出一次，需用"acquire 后立即检查 aborted 则 release"的守卫，逻辑变复杂）。
- **改动成本**：A = S；B = M
- **验证方式**：A：注释评审；B：重跑 [A3] 脚本，`it.return()` 应立即 settle 且 `active` 守恒。
- **依赖/冲突**：B 方案与"排队计入耗时"的记账语义（`lib/api-instrument.js:9` 注释）交互，需 Lead 认可语义变化。

---

#### [R-06] 目录发现回调双层静默：任何失败都无日志

- **维度**：Review
- **严重度**：🟡
- **位置**：`index.js:533-535`（`catch { return discoveredFor(state.lastCatalog); }`）；`lib/discovery.js:123-125`（`catch { return fallback(); }`）
- **证据**：[读码] 两层 catch 均无任何输出。同文件的调用门有完整诊断通道（`index.js:392-398` 的 `onDiagnostic` → `console.warn`），发现路径一条都没有。
- **影响**：目录刷新失败（网络故障、凭据失效、网关响应形态变化、JSON 解析失败）时，用户看到的只是"模型列表没更新/少了模型"，主进程日志零线索。无法区分"网关挂了"与"响应形态变了"。命中"失败无诊断线索"判据。
- **建议方案**：`index.js:533` 改为 `catch (err) { console.warn(`[dsh-connect-zcode] 目录发现失败，回退上次目录：${err?.message ?? err}`); return discoveredFor(state.lastCatalog); }`（错误消息来自 fetch/JSON.parse，不含凭据；`discovery.js:123` 的内层 catch 保持静默——它已有回退语义，让异常经 `discoverModels` 内部消化或统一在外层记）。二者取其一即可，推荐外层。
- **改动成本**：S
- **验证方式**：selfcheck"发现: 网络异常回退静态表"仍 PASS；人工断网观察日志出现一条 warn。
- **依赖/冲突**：与 H-02（被过滤模型日志）共用同一日志通道，一并做。

---

#### [R-07] 状态路由注册失败零日志（空 catch）

- **维度**：Review
- **严重度**：🟡
- **位置**：`index.js:370-372`（`} catch { /* 路由注册失败不影响 provider 三部曲 */ }`）
- **证据**：[读码] `registerStatusRoute` 的整个 try/catch 无输出。webServer 服务缺席（`index.js:586-588` 有兜底）与 `webServer.register` 契约变化（签名不匹配抛错）在用户侧是同一现象：面板"状态不可用（HTTP 404）"，但前者是已知降级、后者是需要修的兼容问题——当前无法区分。
- **影响**：与 TROUBLESHOOTING §2.8 同构的"静默失效"：一个潜在的面板 404 成因完全不可诊断。
- **建议方案**：`catch (err) { console.warn(`[dsh-connect-zcode] 状态路由注册失败（面板将显示状态不可用）：${err?.message ?? err}`); }`
- **改动成本**：S
- **验证方式**：selfcheck 全链路（fakeCtx.inject 为空实现，走 catch 分支）出现该 warn 且其余断言不受影响。
- **依赖/冲突**：无。

---

#### [R-08] `resolveSchemastery` 失败时尝试点列表被丢弃，降级 warn 缺少可诊断信息

- **维度**：Review
- **严重度**：🟡
- **位置**：`lib/host-modules.js:192-200`（`tried` 数组构造并填充后，函数返回 `null` 时**整个丢弃**）；`index.js:239-243`（warn 文案只有"宿主内未解析到 @deepseek-ai/schemastery"）
- **证据**：[实测] selfcheck 与本审查各脚本运行时该 warn 的实际输出无任何尝试点；对照组 `resolveHostLlmModules` 失败时会列出 `tried.slice(-24)`（`host-modules.js:178-183`）并给出 env 逃生口提示。
- **影响**：schemastery 降级 = 面板写入被 DSH 门禁静默拒绝（volatile 缺失，TROUBLESHOOTING §2.3）——这正是本项目已知危害最大的降级链，而它的失败诊断反而比 LLM 栈失败（有 tried 列表）少一档。用户无法确认"是宿主真没这个包"还是"路径候选错了"。
- **建议方案**：`resolveSchemastery` 失败路径改为 `throw new Error('…尝试过：' + tried.join('；'))` 并由 `loadConfig` 的现有 catch 捕获（warn 文案已拼接 `err.message`，无需再改 index.js）；或返回 `{ module: null, tried }` 让调用方拼接。
- **改动成本**：S
- **验证方式**：selfcheck 运行时该 warn 含候选点列表（开发目录下应至少列出裸说明符与 resourcesPath 候选）。
- **依赖/冲突**：无。

---

#### [R-09] `readLastLedgerRow` 每次状态请求同步读全量台账；台账无轮转机制，文件无限增长

- **维度**：Review
- **严重度**：🟡
- **位置**：`lib/web-status.js:70`（`readFileSync(ledgerPath, 'utf8').split('\n')` 全量读）；`lib/ledger.js:58-59`（appendFileSync 无任何轮转/截断）
- **证据**：[实测] 构造真实形状台账行：10 万行 24MB → 62ms；40 万行 97MB → **244ms** 同步阻塞（该读发生在每次面板状态 GET，即 DSH 主进程）。
- **影响**：按每次推理请求 1 行累积，重度使用一年即数十 MB；此后每次面板刷新造成主进程 100-300ms 同步阻塞 + 等量内存峰值。功能不出错，但随时间线性劣化。
- **建议方案**：`readLastLedgerRow` 改为尾部读取：`fs.openSync` + 从文件尾倒读最后 64KB（provider 行必然在末尾若干行内），找不到再扩大；或者更简单地只在 `statSync().size > 1MB` 时走尾部读。不建议动台账写入侧（追加写是红线语义）。
- **改动成本**：S~M
- **验证方式**：重跑台账性能脚本：97MB 文件耗时 < 5ms；selfcheck"状态: 台账摘要取最后 provider 行"仍 PASS。
- **依赖/冲突**：无。

---

#### [R-10] selfcheck 的宿主 stub 形态与代码注释声称的 pi-ai 真实形态互相矛盾，promise 防御分支零测试

- **维度**：Review
- **严重度**：🟡
- **位置**：`test/selfcheck.mjs:719`（stub `anthropicMessagesApi = () => ({ async stream(model) {...} })` —— async 方法返回 **Promise**）；`lib/api-instrument.js:4-7`（注释声称"pi-ai 导出为**同步箭头函数**，返回事件流对象……绝不能返回 Promise"）
- **证据**：[读码] stub 的 `stream` 是 `async` 方法 → 调用返回 `Promise<AsyncIterable>` → 在 `instrumentApi` 中命中 `isPromise` 分支（`lib/api-instrument.js:128-140`）。该分支 resolve 后返回**未经 Proxy 包装**的原始流，且只记一次账（usage 取自 resolved 对象，恒为 null）。selfcheck 的主 fixture（`selfcheck.mjs:578-588`）用同步方法——两种形态并存，而全链路注册测试从不调用 `api.stream`，promise 分支行为零断言。
- **影响**：若 T20"同步形态"的实证结论随 pi-ai 升级过时（改为返回 Promise），并发预算与记账将整体静默失效，且无测试报警——恰好是本测试套件本应防御的那类回归。
- **建议方案**：① 把 stub（`selfcheck.mjs:719`）改为与注释一致的**同步**方法，消除两套说法；② 新增一条显式断言：构造返回 Promise 的 rawApi，断言 promise 分支行为（记账一次 + 返回对象未包装 + 信号量获取释放配对），把"防御分支"从无测试变成有契约注释的已验证路径。
- **改动成本**：S
- **验证方式**：新增断言 PASS；现有 146 项不变 PASS。
- **依赖/冲突**：无。

---

#### [R-11] fallback schema 的 `contextWindow` 钳制语义：非法负值变成 1 而非默认 200000，与 schemastery 主路径行为不一致

- **维度**：Review
- **严重度**：🔵
- **位置**：`index.js:139-145`（`clampInt`）
- **证据**：[实测] 经 fallback `Config['~standard'].validate` 传入 `contextWindow: -5` → 归一为 **1**（而非 dflt 200000）；`maxConcurrent: 99 → 2` 正常。schemastery 主路径 `z.number().min(1)` 对 -5 会校验失败——两条路径对同一输入行为不同。
- **影响**：仅当用户手写 profile config 填错时触发（面板不暴露该字段）；后果是全部模型声明 `contextWindow=1`，DSH 上下文管理立即异常。可发现可改回，无凭据/数据风险。
- **建议方案**：`clampInt` 中把"非有限数或 ≤0"归为非法（回 dflt），仅对合法范围内的越界值钳制；或维持现状并在 `index.js:139` 注释写明"负值 → 1"是接受的行为。
- **改动成本**：S
- **验证方式**：重跑边界脚本断言 `-5 → 200000`。
- **依赖/冲突**：无。

---

#### [R-12] 回环判定经全面边界测试无安全绕过；`originIsLoopback` 的 `'::1'` 分支为死分支（无害冗余）

- **维度**：Review
- **严重度**：🔵（安全结论：非问题）
- **位置**：`lib/web-status.js:43-51`（origin）、`:57-61`（host）
- **证据**：[实测] 18 组边界输入：`Origin: "null"` 字符串 → 拒绝；`http://localhost.evil.com`、`http://evil.com#@localhost`、`http://localhost@evil.com`、`http://127.0.0.1:80@evil.com` → 全部拒绝；IPv4-mapped `[::ffff:127.0.0.1]` → 拒绝（fail-closed）；全零 IPv6 `[0:0:0:0:0:0:0:1]` → URL 规范化为 `[::1]` 放行（合法回环自身）；大小写与空白 → 正常放行。`new URL('http://[::1]:3000').hostname === '[::1]'` 为 true、`=== '::1'` 为 false——**origin 的 `'::1'` 分支永不成立**（与 Lead 前期排除结论一致）。host 侧的 `'::1'` 分支并非全死：`hostIsLoopback('::1:8080') === true`（端口剥离后命中），但那只是回环地址的非法 Host 写法，浏览器不会产生，无绕过意义。
- **影响**：无。判定面 fail-closed，死分支属可清理的冗余（见 S-05）。
- **建议方案**：不作为安全问题处理。可在简化时删除 `lib/web-status.js:47` 的 `|| hostname === '::1'`（origin 侧）；host 侧的 `|| name === '::1'` 保留与否皆可（对畸形输入仍只放行回环自身）。
- **改动成本**：S
- **验证方式**：重跑回环边界脚本，18 组结果不变（除有意删除的死分支）。
- **依赖/冲突**：无。

---

#### [R-13] Semaphore 经定向测试与语义核对无问题（§10-2 为非问题）

- **维度**：Review
- **严重度**：🔵（经核实为非问题）
- **位置**：`lib/api-instrument.js:18-38`
- **证据**：[实测] ① limit=2、4 个 acquirer：排队者按序获得转交名额，`active` 全程守恒（获取总数 - 释放总数），最终归零；② 流中途抛错：预算释放 + 记账 `error` 行，`active` 归零；③ "release 在 queue 非空时不减 active"是**名额转交语义**（等待者接管名额），数学上守恒，是标准公平信号量实现，正确。
- **影响**：无。
- **建议方案**：不改。可选：`release()` 加一行注释说明转交语义（`lib/api-instrument.js:33-37`），防止后来者"修复"它。
- **改动成本**：S（仅注释）
- **验证方式**：不适用（非问题记录）。
- **依赖/冲突**：无。

---

#### [R-14] `apply()` 的 disposed 与异步注册竞态经实测无问题（§10-10 为非问题）

- **维度**：Review
- **严重度**：🔵（经核实为非问题）
- **位置**：`index.js:597-638`（`apply`）与 `:614-617`（effect 卸载）、`:628-638`（fire-and-forget）
- **证据**：[实测] 两个时序：① dispose 发生在 `resolveHostLlmModules().then` 之前 → `index.js:630` 的 `if (disposed) return` 防住，adapter 零注册；② 注册完成后再 dispose → 三部曲 offs 全部对称执行，adapter 数归零。`registerZcodeProvider` 是同步函数，单线程下与 dispose 无交错窗口。
- **影响**：无。
- **建议方案**：不改。
- **改动成本**：-
- **验证方式**：不适用。
- **依赖/冲突**：唯一残留点是状态路由不经过 offs（见 R-15）。

---

#### [R-15] 状态路由的卸载语义未验证：依赖 `webServer.register()` 返回值恰为清理函数，且不在 `offs` 数组内

- **维度**：Review
- **严重度**：🔵（未验证记录）
- **位置**：`index.js:343-369`（`webCtx.effect(() => webCtx.webServer.register({...}), name)` —— 单层箭头）；`index.js:512-589`（`offs` 不含状态路由）
- **证据**：[读码] `ctx.effect(fn)` 的 cordis 语义（依 trae :4459 同款注释）是"fn 返回清理函数"。trae 的写法是双层箭头 `() => () => registration.*?.()`；此处是单层 `() => webServer.register({...})`——清理函数 = `register()` 的返回值。若 `register` 返回的是 off 函数则恰好正确；若返回 undefined 或句柄对象，卸载即 no-op/误调。disposeAll() 不覆盖该路由，卸载完全依赖 webCtx 的 fiber 生命周期。
- **影响**：若契约不成立，插件重载后旧路由残留（旧闭包继续响应状态请求；响应字段为零凭据，泄漏风险低，但状态可能与新实例不一致）。
- **建议方案**：**未验证**。验证方法：真机 Cordis Inspect 或对照宿主源码确认 `webServer.register` 返回类型；若确为 off 函数，在 `index.js:343` 加注释锁定该依赖。若不为，改写为 `webCtx.effect(() => { const off = webCtx.webServer.register({...}); return () => off?.(); }, name)`（对两种返回形态都安全）。
- **改动成本**：S（注释或防御性包装）
- **依赖/冲突**：无。

---

#### [R-16] client 半两个小项：`writeField` 三字段串行写非原子；`rebind` 的空 catch 把异常伪装成"尚未就绪"

- **维度**：Review
- **严重度**：🔵
- **位置**：`lib/client.js:300-302`（三个 `await writeField` 顺序执行）；`lib/client.js:499-501`（`catch {}`）、`:511-513`（`catch {}`）
- **证据**：[读码] 第二个字段写入失败时第一个已生效（部分保存）；重试全量覆盖、幂等，最终一致，失败文案可操作——可接受，记录即可。`forms.describe()` 抛错时 `served=undefined` → 面板只读，提示文案为"设置命名空间不可写（尚未就绪）"，把**异常**与**未就绪**混为一谈。
- **影响**：低。configForms 正常时不抛；抛错场景用户得到的提示不准确。
- **建议方案**：两个 catch 改为 `catch (error) { console.warn('[dsh-connect-zcode] configForms 读取失败：', error?.message); }`。
- **改动成本**：S
- **验证方式**：selfcheck client 组断言不受影响（stub ctx 的 get 返回 undefined 不走该路径）。
- **依赖/冲突**：无。

---

#### [R-17] `NS_PATTERN` 命名空间匹配：精确分支在生产永不命中，模糊匹配有误绑理论面

- **维度**：Review
- **严重度**：🔵
- **位置**：`lib/client.js:500`（`.find((entry) => entry.ns === "zcode" || NS_PATTERN.test(entry.ns))`）；对照 `index.js:599-600`（settingsNs = Loader entry id）与 `cordis.patch.yml:8`（生产 entry id = `zcode-connect`）
- **证据**：[实测·读码] 生产 settingsNs = `zcode-connect`（patch id），`entry.ns === "zcode"` 仅在 `ctx.fiber.entry.options.id` 缺失的兜底场景（`index.js:600` 回落 `NS='zcode'`）才可能命中——生产路径**永远走 `/zcode/i` 模糊分支**。
- **影响**：另一个命名空间含 "zcode" 的插件共存时按 namespaces 数组顺序误绑（当前生态 trae/workbuddy 无此名，风险低）。精确分支的存在暗示与真实 settingsNs 值脱节的心智模型。
- **建议方案**：改为 `entry.ns === "zcode-connect" || NS_PATTERN.test(entry.ns)`，并在命中模糊分支且存在多个候选时 `console.warn` 列出全部候选 ns。
- **改动成本**：S
- **验证方式**：selfcheck 的 settingsNs 断言（`zcode-connect-selfcheck`）需同步适配（或断言改为"命中模糊分支"）。
- **依赖/冲突**：selfcheck `:846` 若改断言需一并更新。

---

### 2.2 Simplify 维度（S 系列）

---

#### [S-01] `scripts/sync-key-to-config.mjs` 与 `lib/credential-store.js` 的解密实现整段复制，且无任何一致性守卫

- **维度**：Simplify
- **严重度**：🟡
- **位置**：`scripts/sync-key-to-config.mjs:50-51`（`ENC_PREFIX`/`API_KEY_RE`）、`:57-67`（`resolveSecret`）、`:68-82`（`decrypt`）对照 `lib/credential-store.js:31-34`、`:42-52`、`:59-73`、`:84`
- **证据**：[读码] 两份 `decrypt` 逐行同式（ENC_PREFIX、3 段 split、iv12/tag16、`sha256(secret)`、aes-256-gcm）；`resolveSecret` 同式（env 优先、fallback 串含 platform/homedir/username）；`API_KEY_RE` 字面相同。`test/selfcheck.mjs` 对 `scripts/` **零覆盖**（全文无 `sync-key`/`scripts/` 引用）。
- **影响**：这是 C2（逆向契约）的两份手工同步副本。任何一侧因 ZCode 加密格式变化而修改（或修 bug）而另一侧遗漏 → 方案 A 恢复工具与插件方案 B 回退行为分叉：用户按 README 先跑恢复工具"修好了 config.json"，插件回退却仍失败（或反之），排查成本极高。
- **建议方案**：scripts 的解密段改为复用 lib：`import { decryptCredentialValue, readStoredApiKeys } from '../lib/credential-store.js'`（脚本是独立 ESM，相对 import 可行；可保留其自有的"逐把验活 + 写回"主流程）。删除 scripts 内 `decrypt`/`resolveSecret`/`API_KEY_RE` 约 30 行。
- **改动成本**：S
- **验证方式**：`node scripts/sync-key-to-config.mjs --dry-run` 在**有 fixture 凭据库的沙箱**（`ZCODE_CREDENTIAL_SECRET` env + 临时目录）下行为与改前一致；selfcheck 保持零覆盖不变。
- **依赖/冲突**：与 DE-02（C2 维持现状结论）配套；注意不要把脚本改成 import 本包 `index.js`（会触发顶层 await 与宿主解析）。

---

#### [S-02] `SECRET_PATTERNS` 与脱敏函数双副本（同包可共享而未共享）

- **维度**：Simplify
- **严重度**：🔵
- **位置**：`lib/ledger.js:25-35`（`SECRET_PATTERNS` + `sanitizeErrorSummary`）对照 `lib/web-status.js:17-27`（同两正则 + `redactStatusText`）
- **证据**：[读码] 两个正则字面完全一致；两个函数体仅命名不同。两模块同在 `lib/` 且无循环依赖（web-status 不 import ledger）。
- **影响**：与 C9 联动：key 形态变化时需要同步改 4 处正则（credential-store 的 `API_KEY_RE`、scripts 的副本、ledger、web-status）——现在是 2 处副本 ×2 语义（形态判定/脱敏），漂移一处即脱敏失效。
- **建议方案**：`SECRET_PATTERNS` + 脱敏函数收敛到一处（建议留 `lib/ledger.js` 导出，`web-status.js` import 之；或新建 `lib/redact.js`）。净删约 10 行。
- **改动成本**：S
- **验证方式**：selfcheck 台账脱敏与状态脱敏断言仍 PASS。
- **依赖/冲突**：与 DE-09（C9 三处正则联动注释）配套。

---

#### [S-03] `128000` 同值三处

- **维度**：Simplify
- **严重度**：🔵
- **位置**：`index.js:46`（`FALLBACK_MAX_TOKENS = 128000`）、`lib/model-meta.js:116`（非官方行 `maxTokens: 128000`）、`lib/model-meta.js:128`（`hit.output ?? 128000`）
- **证据**：[读码] 三处独立字面量，语义相同（官方 output 缺失时的回退值）。
- **影响**：若官方 output 默认值需要调整（如 5.3 系 output 上限变化），三处漏一即目录行与 pi 行不一致。
- **建议方案**：`lib/model-meta.js` 导出 `export const FALLBACK_MAX_TOKENS = 128000;`，三处统一引用（index.js 已 import model-meta，零新增依赖）。
- **改动成本**：S
- **验证方式**：selfcheck 目录/管线断言（maxTokens 正整数）仍 PASS。
- **依赖/冲突**：无。

---

#### [S-04] 注释外部上下文引用约 134 处，对独立维护者不可解析（附搬迁清单）

- **维度**：Simplify
- **严重度**：🔵
- **位置**：全仓。[实测 grep 统计] `T18`–`T23` 标记 74 处（index.js 17、selfcheck 25、model-meta 9、discovery 8、client 7、其余分散）；`trae :NNNN` 行号引用 30 处；`PROTOCOL §x` 16 处；`ZB-01`/`Z13-1`/`Z10-x`/`pitfalls §` 14 处。注释行占比：index.js 175/639（27%）、discovery.js 54/126（43%）、switch.js 28/64（44%）、model-meta 71/193（37%）、credential-store 64/172（37%）。
- **证据**：[实测 grep] 见附录 A。
- **影响**：`T22 §1.1-3`、`trae :383-393`、`PROTOCOL §5.2`、`Z10-3` 等编号指向本仓库不存在的文档/他仓库行号，行号还会随宿主版本漂移失效。信息密度高但可解析性低，稀释真正重要的"为什么"注释。
- **建议方案**（三类处置）：
  1. **留**：承载因果与实测结论的"为什么"注释（如 `index.js:79-85` 图片预算缺失后果、`lib/credential.js:80-84` 200 假绿陷阱）——删编号、保留事实本身。
  2. **搬**：`trae :NNNN` 具体行号 → TROUBLESHOOTING 汇总一节（"宿主 API 对照表"，注明 dsh-connect-trae@2.4.0 版本），代码里只留"trae 同款"字样；`PROTOCOL §x`/`T 编号`/`Z 编号` 的背景 → 同一节或 ADR。
  3. **删**：纯过程性引用（如"Z10-1：cordis 只认 ~standard.validate"这类已把结论写全、编号纯属装饰的）。
  预计净删 120-180 行注释而不损失任何事实。
- **改动成本**：M（纯编辑，量大但机械）
- **验证方式**：selfcheck 全绿（其 tripwire 依赖部分注释文本的断言需先核对：`selfcheck.mjs:628-631` 用源码包含判断，如 `enabledModelIds: asVolatile(`，删注释不影响；`README 断言`与注释无关）。
- **依赖/冲突**：改动量大，建议单独一个 commit、放在功能修复之后。

---

#### [S-05] 死代码与未用导出：`extractModelIds` 生产无调用方

- **维度**：Simplify
- **严重度**：🔵
- **位置**：`lib/discovery.js:89-92`（`extractModelIds`）
- **证据**：[实测 grep] 全仓仅 `test/selfcheck.mjs:533` 断言它存在；`index.js`/`lib/client.js` 均未使用（client 半有自己的副本逻辑）。
- **影响**：无功能影响；是"为测试而存在"的导出。
- **建议方案**：删除 `:89-92` 及 selfcheck 对应断言片段；或保留但在 JSDoc 标注"仅测试消费"。
- **改动成本**：S
- **验证方式**：selfcheck 相应断言同步删除后全绿。
- **依赖/冲突**：无。

**另核清两项为非问题**：① `unwrapLive`（`index.js:66-68`）vs `unwrapLiveDeep`（`lib/client.js:54-66`）不是冗余——host 侧 volatile 活引用只在字段层（单层够用），client 侧 `getSnapshot().value` 是嵌套结构（深层必需），且跨半不能 import（client 信封零静态 import 是 T21 红线）。② `lib/discovery.js:19` 的 `STATIC_MODEL_IDS = [...GLM53_FAMILY]` 是引用展开而非同值副本（selfcheck:423 有守卫），真正的无守卫副本在 client 半（见 DE-10）。

---

### 2.3 强制性优化维度（H 系列）

---

#### [H-01] 146 项断言没有任何 CI 承载：只在 Lead 机器上运行

- **维度**：强制性优化
- **严重度**：🟡
- **位置**：仓库无 `.github/`/CI 配置（[实测] 文件清单）；`test/selfcheck.mjs:5-7` 自述"纯静态零网络、退出码 0/1"——天然可 CI。
- **证据**：[实测] `node test/selfcheck.mjs` 在无宿主、无凭据、无网络的环境中可完整运行（本审查即在此环境复现 146/146）。
- **影响**：本项目 2160 行 JS + 9 条外部耦合，唯一防线是这份自检；它当前依赖人手执行。R-01/S-01 这类"测试自身纪律"问题长期无人发现，根因就是没有第二双眼睛（CI 在干净环境跑会暴露"读真实凭据库"这类环境依赖）。
- **建议方案**：最小 CI：GitHub Actions 单 workflow，`node:22` 与 `node:24` 两个 matrix 跑 `node test/selfcheck.mjs`，不加 lint、不加构建（尊重"无构建链"的项目形态）。可选加 `node scripts/sync-key-to-config.mjs --dry-run`？**不加**——dry-run 也会读真实凭据库（脚本读取真实路径），CI 环境无该文件会 exit 1，反而制造红鲱鱼。
- **改动成本**：S（一个 yaml 文件）
- **验证方式**：CI 首次运行绿；故意注入一个 FAIL 观察 CI 变红。
- **依赖/冲突**：R-01 修复应在 CI 启用前完成（否则 CI 环境无凭据库时 selfcheck 日志路径不同，但断言仍应通过——正好是验证 R-01 修复的机会）。

---

#### [H-02] 5.3 系显式集合把上游新模型静默过滤：设计决策保留，但"上游变了"应至少在日志可见

- **维度**：强制性优化
- **严重度**：🟡
- **位置**：`lib/model-meta.js:26`（`GLM53_FAMILY` 显式 3 项）、`:37-39`（`filterGlm53Family`）；`lib/discovery.js:120`（`buildCatalog` **之前**过滤——被滤模型连 `state.lastCatalog` 都进不去）；`README.md:329-330`（已知限制 8 如实声明）
- **证据**：[读码] 注释明说"不用模糊前缀（防未来网关多出 glm-5.3-pro 被误放行）"——这是有意的防误放行取舍，**不是缺陷**。但上游新增 5.3 系变体时：面板 modelsTotal 不变、选择器无新模型、无任何日志或提示，用户与维护者都无从得知"网关已经有新模型了"。
- **影响**：上游演进 → 功能静默落后，唯一发现途径是人工对比网关。README 已声明，属"接受的取舍 + 缺一个观测点"。
- **建议方案**：保持过滤语义不变，在发现回调（`index.js:526-532`）过滤前记录数量：`console.warn(`[dsh-connect-zcode] 网关返回 ${all.length} 个模型，按 5.3 系显式集合保留 ${rows.length} 个`)`（或 debug 级）。当保留数与网关数差异扩大时至少有线索。GLM53_FAMILY 的更新仍走"改代码 + README"的显式流程（尊重取舍）。
- **改动成本**：S
- **验证方式**：selfcheck"发现: 200 时 5.3 系过滤"仍 PASS；日志在 fixture 下出现数量行。
- **依赖/冲突**：与 R-06 同一日志通道。

---

#### [H-03] "每次调用前置一次验活往返"的用户可见成本未在 README 声明（§10-4 的论证落点）

- **维度**：强制性优化
- **严重度**：🟡
- **位置**：`index.js:498`（`resolveApiKey: async () => (await gate()).apiKey`——[读码] T20 实证适配器每请求 await，即**每次推理调用**都走 gate）；`lib/credential.js:144-172`（gate 最坏路径 = 1 次 config 验活 + N 次凭据库候选串行验活，每次 `timeoutMs` 默认 8000）
- **证据**：[读码] 正常路径（config key 有效）：每请求 +1 次 `GET /v1/models` 网络往返（~100-500ms，相对流式推理总时长占比小）；异常路径（config key 失效 + 库里 N 把候选）：每请求 8s + N×8s **串行**（`lib/credential.js:165-170` 逐把 await）。README"已知限制"未提及此项。
- **影响**：用户在 key 失效期看到"每次对话先卡 8 秒到几十秒再报错/继续"，无文档解释。任务书 §10-4 问"是否需要缓存（不能违反零缓存红线）"——见 §6.1 的红线论证：**不建议用缓存修此条，建议文档化**。
- **建议方案**：README"已知限制"追加一条：凭据门每次调用现读现验（零缓存红线），正常路径 +1 次轻量 GET 往返；config key 失效且回退启用时，最坏（1+N）×8s 串行验活后才沿用/回退。
- **改动成本**：S
- **验证方式**：文档评审。
- **依赖/冲突**：不修改任何运行时行为。

---

### 2.4 解耦维度（DE 系列：C1–C9 逐条 + 跨半守卫）

---

#### [DE-01] C1（`~/.zcode/v2/config.json` 条目形状）—— 耦合已收窄，补一个键名诊断即可

- **维度**：解耦
- **严重度**：🔵
- **位置**：`lib/credential.js:37-74`（读取与校验）、`lib/model-meta.js:49-78`（只读 models 段）
- **证据/现状**：路径（`credentialPath`）与 planKey 均可配置；失败全部收敛为带可操作文案的 `CredentialError`（缺文件/坏 JSON/未启用/缺 key/JWT 形态五态，selfcheck 各有断言）；`model-meta` 侧只读 models 段、异常回 `{}` 绝不抛。上游改形状 → fail-fast 且文案指向 ZCode 重登。
- **残余风险**：`cfg?.provider?.[planKey]` 键名结构若变（如 provider 段改名），错误文案仍是"未启用"——用户照文案重登也修不好。
- **建议方案**：`lib/credential.js:53-59` 的"未启用"错误消息中追加实际存在的 provider 键名列表（`Object.keys(cfg?.provider ?? {}).join(', ')`——键名不是凭据，零明文风险）。成本 S。
- **验证方式**：selfcheck 凭据 5 态仍 PASS；fixture 加一个干扰键名观察错误消息。

---

#### [DE-02] C2（`credentials.json` 逆向 AES-256-GCM 解密）—— 最脆的契约，但失败面已做到"显式且保守"，维持现状

- **维度**：解耦
- **严重度**：🔵
- **位置**：`lib/credential-store.js`（全文件）；消费方 `lib/credential.js:160-172`
- **证据/现状**：四层防护已在位：① 任何失败返回空数组/`null` 绝不抛；② 解密失败/形态不符有 `onDiagnostic`（只报长度与原因，零明文）；③ 上游换格式 → 回退失败 → **沿用 config 原值**（fail-safe，不比现状更糟）；④ `fallback:false` 逃生口（`credential.js:152-155`）。真正缺的不是边界而是**单实现**（双副本漂移风险，见 S-01）。
- **建议方案**：不抽象"凭据提供者"接口（两条来源是两个函数、一个消费点，抽象层是无收益的间接性——见 §6 反建议）。做 S-01 的单实现即可。剩余风险（ZCode 换加密格式 → 回退永久失效）接受：发生时用户走 sync-key 工具或重登，诊断可见。

---

#### [DE-03] C3（宿主 asar 候选链 + 硬编码文件路径）—— 已有"tried 列表 + 双 env 逃生口"，边界合格

- **维度**：解耦
- **严重度**：🔵
- **位置**：`lib/host-modules.js:25-76`（REQUIRED/OPTIONAL 的 files 候选）、`:79-101`（根推导）、`:150-184`（失败时列出 tried 并指向 `ZCODE_CONNECT_MODULES_ROOT`）
- **证据/现状**：宿主升级换目录布局 → 全候选失败 → 可操作错误含最近 24 条尝试点与 env 解法（[实测] selfcheck"宿主栈不可解析 → 可操作错误且不注册"断言）。§10-8 的 `bareAttempted` 一次性缓存只影响裸导入这一**乐观支路**（`host-modules.js:113-126`），文件候选主路径不受"首次失败永久失败"影响——非问题。
- **建议方案**：不改。可选：`resolveSchemastery` 的 tried 丢弃问题单独修（R-08）。

---

#### [DE-04] C5（dsh-llm-pi-ai 的 options/profile 形状）—— 全项目最高风险的静默失效面，缺启动期形状自检

- **维度**：解耦
- **严重度**：🟡
- **位置**：`index.js:471-510`（profile 与 adapter options 的构造）；宿主侧消费点（注释引用 `:1753-1755`/`:1848`/`:1860` 等行号，随宿主版本漂移）；现有唯一校验 = `lib/host-modules.js:47`（`typeof m?.PiAiAdapter === 'function'`）
- **证据**：[读码] 本耦合已两次真机翻车：resolveAttachments 挂错对象（TROUBLESHOOTING §2.7"挂 createProvider 会静默无效"）、profile 缺图片预算（`index.js:79-85`"一发图就失败"）。两者的共同点：**键挂错位置/缺失 = 运行时特定场景才炸，无启动期信号**。宿主升级若重命名 `resolveAttachments`/`requestImagePixelBudget` 的读取点，现有校验（函数存在性）完全不设防。
- **影响**：宿主升级 → 带图请求/推理档/凭据门在特定场景静默失效，用户看到的是与 §2.7 同款的"新会话能用、带图会话失败"类迷惑现象，排查要重走一遍逆向。
- **建议方案**（启动期形状自检，不改宿主契约、不发明 API）：
  1. `registerZcodeProvider` 构造完 adapter 后立即断言：`typeof adapter.options.resolveAttachments === 'function'`、`adapter.options.auth === INERT_AUTH`、profile 上三个图片预算字段为正整数——不满足则 `console.warn` 明确列出缺失项（不阻断注册，与现有"降级必须可见"纪律一致）。
  2. 启动日志输出宿主栈版本与来源：解析成功后读取各包 `package.json` 的 `version`（`mods` 解析时已拿到包根路径），`console.warn`/`log` 一条 `pi-ai@x.y.z @ dsh-llm-pi-ai@x.y.z from <source>`——上游升级时日志首行即可对照。
- **改动成本**：S~M
- **验证方式**：selfcheck 全链路断言新增自检项 PASS；人工改 stub 缺一个预算字段观察 warn。
- **依赖/冲突**：无。**解耦路线第一优先**。

---

#### [DE-05] C4（pi-ai 的 createProvider / anthropicMessagesApi 形状）—— validate 函数存在性 + 失败面已可接受

- **维度**：解耦
- **严重度**：🔵
- **位置**：`lib/host-modules.js:31/39`（validate）；`index.js:449-469`（createProvider 消费）
- **证据/现状**：`createProvider`/`anthropicMessagesApi` 签名变化 → `registerZcodeProvider` 抛 → `apply` 的 catch（`index.js:633-636`）产出"provider 注册失败（未注册任何入口）"日志——fail-fast 且不拖垮宿主。残余：签名兼容但语义变化（如 models 字段含义调整）无防御——这类只能靠 DE-04 的版本日志 + 真机回归。
- **建议方案**：不改。README 增加"宿主升级后先跑 selfcheck 再真机冒烟"一句（并入 DE-04 的版本日志使用说明）。

---

#### [DE-06] C6（ctx.llm 注册三部曲 API）—— 失败面已有，无需加固

- **维度**：解耦
- **严重度**：🔵
- **位置**：`index.js:513-542`
- **证据/现状**：三个 register 方法缺失/改名 → TypeError → catch → 可操作日志（selfcheck"注册: 三部曲齐"与"失败面"组覆盖）。返回的 off 函数被 `disposeAll` 的 try/catch 保护（`index.js:605-613`）。
- **建议方案**：不改。

---

#### [DE-07] C7（ctx.slots / configForms / settings 契约）—— 全项目解耦最好的一条：全部软探测 + 只读降级

- **维度**：解耦
- **严重度**：🔵
- **位置**：`lib/client.js:471-532`（softGet/try-catch/降级只读）；`index.js:620-626`（settings 缺席静默跳过）
- **证据/现状**：`ctx.get('configForms')` 缺席 → 面板只读不崩；`ctx.slots` 注册失败 → console.error 且宿主 provider 不受影响（`client.js:528-530`）；client `apply` 整体 try/catch 绝不抛。残余即 R-17 的 NS 模糊匹配。
- **建议方案**：仅做 R-17。

---

#### [DE-08] C8（bigmodel 网关"失效 key 也返回 HTTP 200 + body.code=1000"）—— 验体逻辑方向 fail-safe，维持

- **维度**：解耦
- **严重度**：🔵
- **位置**：`lib/credential.js:104-115`
- **证据/现状**：三种上游演化方向逐一推演：① 网关"正常化"（失效 key 返回 401）→ `!res.ok` → 判无效，代码仍正确；② body 形态变化（如 `code` 字段消失）→ `code !== undefined` 分支跳过，仍以 `data` 非空为准；③ 有效 key 的 models 列表为空数组 → 误判失效 → 走回退 → 最终沿用 config 原值（保守，不炸）。所有演化的最坏结果都是"保守沿用原值"，无凭据外泄面。残余：`body.code === 0` 之类的成功形态会被误判（[未验证] 需网关实况；真机实证的两种形态都覆盖了）。
- **建议方案**：不改；S-01 完成后 scripts 与 lib 的验体逻辑也应共享（scripts:85-105 的 `validate` 与 `credential.js:91-122` 同构——可一并 import 复用，收益同 S-01）。

---

#### [DE-09] C9（key 形态正则 `^[0-9a-f]{32}\.[A-Za-z0-9]{16}$`）—— 形态判定与脱敏是同一契约的两个方向，改动必须三处联动

- **维度**：解耦
- **严重度**：🔵
- **位置**：`lib/credential-store.js:84`（形态判定，锚定）、`scripts/sync-key-to-config.mjs:51`（同，锚定）、`lib/ledger.js:26` 与 `lib/web-status.js:18`（脱敏，非锚定全局版）
- **证据/现状**：ZCode 换 key 形态 → 候选全滤 + 诊断已给出长度与期望形态（`credential-store.js:128-134`）——观测面合格。**真正的暗坑在脱敏侧**：若按诊断提示只更新了 `API_KEY_RE` 而忘改 `SECRET_PATTERNS`，新形态 key 将以明文进台账/状态响应——**脱敏失效是凭据泄漏**。
- **建议方案**：在 `credential-store.js:84` 与 `ledger.js:25` 两处注释互指（"改此处必须同步改对方 + scripts 副本，共三处"）；配合 S-02 把脱敏收敛到单实现后，联动点降为两处。
- **改动成本**：S
- **验证方式**：注释评审；selfcheck 零明文终扫（`selfcheck.mjs:1110-1124`）继续作为最后防线。

---

#### [DE-10] client/host 双副本（`STATUS_PATH` / `CONTEXT_1M` / `STATIC_MODEL_IDS`）零守卫—— 任务书 D4 点名的强制性优化，现缺失

- **维度**：解耦
- **严重度**：🟡
- **位置**：`lib/web-status.js:14` vs `lib/client.js:31`（`STATUS_PATH`）；`lib/client.js:41`（`CONTEXT_1M = 1000000`）vs 官方 meta 的 `limit.context`（fixture `selfcheck.mjs:58`）；`lib/discovery.js:19`（有守卫）vs `lib/client.js:47`（无守卫的字面量数组）
- **证据**：[实测 grep] `test/selfcheck.mjs` 对 client.js 的三个副本**没有任何比对断言**（client 半只做语法解析与 stub 渲染，`:952-1108`）；host 内部的 `STATIC_MODEL_IDS` ↔ `GLM53_FAMILY` 有守卫（`:423`），跨半没有。
- **影响**：三个副本漂移的具体后果各不相同且全部静默：`STATUS_PATH` 改一边 → 面板 fetch 404（有降级提示，可排查）；`STATIC_MODEL_IDS` 改一边 → 降级视图与实际目录不一致；**`CONTEXT_1M` 最危险**——面板写入的 1M 值（1000000）与 host `applyContextBudgets` 的比对值（官方 meta 的 context）不在同一处定义，官方若调整 `limit.context`，面板继续写 1000000 → `budgets[id] !== maxContextWindow` → **1M 勾选静默失效**（用户勾了，`contextWindow` 仍 200000，无任何提示）。
- **建议方案**：selfcheck 新增 3 条源码级守卫（client.js 无法 import，用字符串断言）：
  1. `clientSource.includes('STATUS_PATH = "/plugins/dsh-connect-zcode/status"')` 且与 `webStatus.ZCODE_STATUS_PATH` 值一致（模板字符串拼接）；
  2. 从 client 源码提取 `STATIC_MODEL_IDS = [...]` 字面量（正则 + `JSON5` 级解析或 `new Function('return ' + arr)`），与 `modelMeta.GLM53_FAMILY` 深比对；
  3. `clientSource.includes('CONTEXT_1M = 1000000')` 且与 fixture 官方 `limit.context` 比对——官方值变化时该断言失败，强制两处同步评审。
- **改动成本**：S（约 15-20 行 selfcheck 代码）
- **验证方式**：故意改 client 副本之一 → selfcheck FAIL。
- **依赖/冲突**：无。任务书 D4 明文："没有就是一条强制性优化"——**现缺失，成立**。

---

### 2.5 覆盖度核清：7 个高风险文件逐个点名

| 文件 | 结论摘要 |
|---|---|
| `index.js` | R-06（发现回调静默）、R-07（状态路由 catch）、R-08 关联、R-11（clamp 语义）、R-14/R-15（竞态与卸载）、DE-04（形状自检落点）；另核实：gate 诊断不泄漏 key（selfcheck 已断言）、`enabledModelIdsOf` 等活读函数与 client 半 canon 语义一致（[读码] 逐字段比对一致） |
| `lib/client.js` | R-16（writeField 非原子 / rebind catch）、R-17（NS 匹配）、DE-10（三副本无守卫）；XSS 面核实：全部 `createElement` 文本子节点、无 `innerHTML`/`dangerouslySetInnerHTML`、CSS 无 `url()`（[读码]）——未发现问题 |
| `lib/host-modules.js` | R-08（tried 丢弃）、DE-03（边界合格）、§10-8 核清（非问题）；`loadFile` 的 ESM→CJS 回退与"同一候选根内解析齐"语义与注释一致（[读码]）——除 R-08 外未发现问题 |
| `lib/api-instrument.js` | R-03（内层流不关闭）、R-04（`.next()` 绕过）、R-05（排队中止挂起）、R-13（Semaphore 非问题） |
| `lib/credential-store.js` | S-01（与 scripts 双副本）、DE-09（正则联动）；解密/诊断/排序/零明文语义与注释一致（[读码] + selfcheck 10 项）——除 S-01 外未发现问题 |
| `lib/credential.js` | R-01（回退默认路径）、R-02（超时失效）、DE-01/DE-02/DE-08（耦合边界合格）；JWT 拒绝、验体五态、诊断零明文与注释一致（[读码] + selfcheck 17 项） |
| `lib/model-meta.js` | S-03（128000）、H-02（显式集合取舍）、DE-10 关联；锁定语义（official 行跳过 applyXxx）与 `applyContextBudgets` 只认官方 Max 档的注释声称与实现一致（[读码] + selfcheck 30+ 项）——除上述外未发现问题 |

---

## 3. 跨维度综合判断

### 3.1 架构层面的整体判断

**这个项目的真实风险不在"会不会坏"，而在"坏了知不知道"。** 9 条耦合里，7 条已经有了合格的失败边界（可操作错误/回退/降级），真正欠账的是两件事：**观测**（R-06/R-07/R-08/H-02——四处失败零日志）与**守卫**（DE-10/S-01——三组同值副本零一致性断言）。这解释了为什么 §10 的 10 条疑点里有 5 条是"静默失效"类猜测——项目的失败模式确实是静默的，Lead 的直觉方向正确，只是具体点位不同。

**selfcheck 是这个项目最有价值的资产，也是最大的单点盲区。** 它把"注册三部曲""volatile 门禁""200 假绿"这些真机踩坑变成了可回归契约，质量远超同规模项目；但它自身存在 R-01（纪律破口）、R-10（stub 形态自相矛盾）、无 CI（H-01）三个问题——防线本身需要一次检修。

### 3.2 必须接受的耦合（避免 Lead 过度重构）

- **C2 的逆向解密不可解耦**：加密格式是 ZCode 私有实现，任何"抽象凭据提供者"接口都只是给同一份逆向知识换个名字。已有四层失败防护（DE-02），单实现化（S-01）是唯一值得做的。
- **跨半不能 import 是事实**：client 半是 ModuleLoader 信封 bundle（零静态 import 是防拒启红线），三个同值副本不可能用代码共享消除——**正确解法是守卫（DE-10），不是共享**。
- **每请求现读现验凭据**：零缓存红线的直接推论。它的成本（H-03）真实存在但可接受，正确处理是文档化 + 保持现状，不是缓存。
- **`registerZcodeProvider` 210 行不必拆**：分段清晰（gate/目录/三部曲/事件/状态路由），拆分的文件数成本大于可读性收益（见 §6）。

### 3.3 真复杂度 vs 假复杂度

- **真复杂度**：C8 的"200 假绿"、C2 的逆向解密、C5 的挂载位置陷阱——这些是外部系统强加的，注释与测试承载得很好。
- **假复杂度**：注释里的编号系统（T18-T23/§x/Z 编号，S-04）；双份解密实现（S-01）；`extractModelIds` 这类无生产调用方的导出（S-05）。合计是可净删约 150 行的纯负债。

---

## 4. 建议的简化清单（可量化）

| 编号 | 可删除/合并的对象 | 预估行数变化 | 风险 | 前置条件 |
|---|---|---|---|---|
| S-01 | scripts 的 `decrypt`/`resolveSecret`/`API_KEY_RE`/`validate` 改为 import lib 单实现 | 约 -40 行 | 低（dry-run 沙箱回归） | 保留脚本主流程不动 |
| S-02 | `SECRET_PATTERNS`+脱敏函数收敛到单处 | 约 -10 行 | 低 | 无 |
| S-03 | `128000` 三处合一 | 约 -2 行 | 低 | 无 |
| S-04 | 注释编号系统压缩为自包含短句（74+30+16+14 处） | 约 -120~-180 行 | 低（注意 selfcheck 源码包含类断言） | 单独 commit；先核对 `selfcheck.mjs:628-631` 等断言的文本依赖 |
| S-05 | `extractModelIds` 死代码 | 约 -5 行 | 低 | 同步删 selfcheck:533 断言 |
| R-12 | `originIsLoopback` 的 `'::1'` 死分支 | -1 行 | 低 | 无 |
| DE-10 | （负收益项）跨半守卫 +20 行 | 约 +20 行 | 无 | 必做，不属于"删"但同批评审 |
| R-01 | （负收益项）selfcheck 两行修复 | 约 +2 行 | 无 | 必做 |

**净估算**：不含注释压缩约 **-55 行**；含注释压缩约 **-175~-235 行**。涉及 7 个文件：`lib/credential-store.js`、`scripts/sync-key-to-config.mjs`、`lib/ledger.js`、`lib/web-status.js`、`lib/model-meta.js`、`lib/discovery.js`、`test/selfcheck.mjs`（注释压缩另涉 `index.js`、`lib/client.js`、`lib/credential.js`、`lib/host-modules.js`、`lib/api-instrument.js`、`lib/switch.js`）。

---

## 5. 建议的解耦路线图（按投入产出排序）

| 阶段 | 动作 | 收益 | 成本 | 风险 |
|---|---|---|---|---|
| P1 | R-01 + R-02 + R-03（三处 S 级修复） | 堵住凭据测试破口、验活超时、中止后额度漏账 | S×3 | 低，selfcheck 全覆盖回归 |
| P2 | DE-10 跨半守卫 + S-01 单实现 | 同值副本漂移从"静默"变"红测试" | S | 低 |
| P3 | DE-04 C5 形状自检 + 宿主包版本日志 | 最高危静默失效面（挂错位置类）变成启动期可见 | S~M | 低（warn 不阻断） |
| P4 | R-06/R-07/R-08/H-02 诊断补齐 + H-01 最小 CI | 四处零日志点全消灭；146 项资产上 CI | S×5 | 低 |
| P5 | S-04 注释压缩 + 附录 C 文档同步 | 可维护性，消除编号系统 | M | 低（机械编辑） |
| 暂缓 | R-05-B（排队中止竞速修复）、R-15（状态路由卸载真机验证） | 响应性/正确性确认 | M / 需真机 | 中——需 Lead 决策与真机环境 |

**第一优先项**：DE-04（C5）。理由：它是 9 条耦合中唯一"已两次真机翻车且翻车模式为静默失效"的条目，且修复成本最低（启动期断言 + 版本日志，不碰宿主契约）。

---

## 6. 不建议做的事（反建议）

1. **不要用"验活结果缓存"修 H-03/R-02 的性能面。** 即使只是进程内 TTL 缓存布尔值，也引入"key 被吊销后仍可用 N 秒"的新窗口，并改变"每次调用现读现验"的既定语义（`index.js:14` 红线注释）。正确动作是文档化（H-03）+ 修 R-02 的超时 bug。若未来确要缓存，应作为协议级决策单独评审，且只可缓存**验活结论与 source 判定**、绝不缓存 key 原文，并写明缓存失效条件。
2. **不要把 `observed` 的懒获取（首个 next 才 acquire）改成调用时立即 acquire。** "排队计入等待耗时"是记账语义的一部分（`lib/api-instrument.js:9` 注释 + selfcheck 断言依赖 elapsedMs 含义）。
3. **不要"修复"回环判定的死分支为更宽松的 IPv6 处理**（放行 IPv4-mapped、zone-id 等）。现状 fail-closed 是安全正确方向；删死分支可以，放宽不行（R-12）。
4. **不要删除手写 fallback config schema。** 它服务于 DSH 之外的真实运行环境（selfcheck 本身就在用，[实测] vendor=dsh-connect-zcode-fallback）。§2.8 的教训是"降级必须可见"（warn 已加），不是"删除降级"。
5. **不要给 `scripts/sync-key-to-config.mjs` 改备份策略**（写到 tmp、自动清理 bak 等）。备份与 config.json 同目录同权限是可还原性设计；`config.json` 本身就是明文 key，备份不构成新增暴露面（§10-7 经核实为低风险非问题）。可选的防御纵深仅一条：README 提醒"若把 HOME/.zcode 纳入版本控制或云同步，`config.json` 与 `*.bak-dsh-*` 均含明文 key"。
6. **不要拆分 `index.js` 为多文件。** 639 行中 27% 是注释（S-04 处理后会更短），`registerZcodeProvider` 的 210 行有清晰分段且与卸载数组强耦合；拆分的收益不抵"一次交付文件数翻倍 + 跨文件跳读"的成本。先做 S-04 再评估。
7. **不要让 client 半增加任何 host 数据通道**（如让它带 query 参数请求更多状态、读 localStorage 等）。方案 B（回环 GET 路由）是"client 无文件系统"红线下唯一正确形态，现有实现已是它的最小面。
8. **不要为了"对称"给 `Semaphore` 加超时/加权/取消令牌等通用化能力。** N=2、无超时、FIFO 转交就是全部需求（R-13 证明现状正确），通用化只会引入新的测试面。

### 6.1 红线论证：每请求验活的成本（对 §10-4 的正式回答）

"凭据零落盘、零缓存"红线（`index.js:14`）在当前实现中严格执行为"每请求现读 config.json + 现验活"。成本核算：正常路径每请求 +1 次轻量 GET（~100-500ms）；异常路径最坏 (1+N)×8s 串行。我的结论：**该红线本身没有问题，不应为了性能松动**——它的防御对象（key 明文驻留内存副本被意外持久化/泄漏）在本项目的威胁模型（寄生式读取他程序凭据）里是最高优先级。性能问题用 H-03 的文档化处理；若真实用户反馈卡顿，正确的演进是"验活仅对 source 判定做请求内 memo（同一请求的 gate 只跑一次）"——这已是现状（gate 每请求调一次、请求内无重复），再往下就走协议变更了。**结论：维持红线，无需单开修改。**

---

## 7. 附录

### 附录 A：实测命令与原始输出

```powershell
# 基线
PS> git log --oneline -3
a2742f2 docs(TROUBLESHOOTING): Start Plan 第二轮实验 —— 账号路径也用不了（三重证据）
PS> git status --porcelain
?? HANDOFF.md
?? REVIEW-TASK.md
PS> node --version
v24.14.1
PS> node test\selfcheck.mjs
SELFCHECK PASS：146/146
EXIT=0
# ↑ 注意输出中夹带（R-01 的证据）：
# [dsh-connect-zcode] config.json 中的 API Key 验活失败（401/网络），尝试回退到 ZCode 加密凭据库
# [dsh-connect-zcode] 凭据库中 2 个候选均验活失败，沿用 config.json 原值
```

```
# R-02 超时失效（TEMP\zcode-review\timeout3.test.mjs）
[B2fix] no signal, timeoutMs=200 → result=false elapsed=206ms
[B1fix] external signal, timeoutMs=200 → result=false elapsed=601ms   ← 超时未生效

# R-03/R-04/R-05/R-13（TEMP\zcode-review\sem.test.mjs / sem2.test.mjs）
[A1] after queue: active=2 r3=false r4=false
[A1] h1 release -> p3 got slot: active=2 r3=true r4=false
[A1] final active=0                                                   ← 转交语义正确
[A2] threw=mid-stream boom active=0 rec="error: mid-stream boom"      ← 中途抛错释放正确
[A3] Warning: Detected unsettled top-level await … await it.return(); ← 排队中止挂死（exit 13）
[A3fix] after release: return settled=true active=0 rec=["error: aborted"]  ← 最终配对正确
[A4] after raw .next(): value={"t":1} logs=0 semaphoreHeld=0          ← 绕过记账+预算
[A5] inner generator closed after consumer break: false               ← 内层流未关闭

# R-01 辅助证明（TEMP\zcode-review\gate2.test.mjs，USERPROFILE 重定向 + fetch 投毒）
[D] gate returned key = fixture key? true
[dsh-connect-zcode] config.json 中的 API Key 验活失败（401/网络），尝试回退到 ZCode 加密凭据库
[dsh-connect-zcode] 凭据库不可读或不是合法 JSON：
    C:\Users\ADMINI~1\AppData\Local\Temp\zcode-review-fakehome-mi3Eei\.zcode\v2\credentials.json（ENOENT）
← 证明回退读取路径 = <homedir>\.zcode\v2\credentials.json；selfcheck 未重定向时即真实凭据库

# R-12 回环边界（TEMP\zcode-review\loopback.test.mjs，节选）
[C] new URL("http://[::1]:3000").hostname = "[::1]"
[C] originIsLoopback("null") = false        originIsLoopback("http://localhost.evil.com") = false
[C] originIsLoopback("http://[::ffff:127.0.0.1]:3000") = false
[C] hostIsLoopback("::1:8080") = true       hostIsLoopback("127.0.0.1:99999x") = false

# R-09 台账性能（TEMP\zcode-review\ledger.test.mjs）
[E] rows=100000 fileBytes=24200000 readLastLedgerRow=62ms
[E] rows=400000 fileBytes=96800000 readLastLedgerRow=244ms

# R-11 边界（TEMP\zcode-review\edges.test.mjs，节选）
[F8] fallback normalize({contextWindow:-5,…}) → contextWindow: 1（非 200000）

# R-14 竞态（TEMP\zcode-review\race.test.mjs）
[H1] dispose-before-register: adapters=0（未注册，正确）
[H2] registered adapters=1 → after dispose adapters=0（对称卸载，正确）

# S-04 注释统计（grep）
T18–T23 标记 74 处；trae :NNNN 30 处；PROTOCOL §x 16 处；ZB/Z13/Z10/pitfalls 14 处
index.js 注释 175/639 行；discovery.js 54/126；switch.js 28/64
```

所有临时脚本位于 `%TEMP%\zcode-review\`，交付前已删除。

### 附录 B：未覆盖 / 无法验证的盲区（诚实清单）

1. **DSH 宿主进程内行为**：`ctx.llm`/`ctx.slots`/`configForms`/`webServer` 的真实签名与生命周期、`loader/volatile-update` 是否真被派发（README:174 也自认未实测）、R-15 的 `webServer.register` 返回类型。验证方法：真机 Cordis Inspect + 一次带图会话/面板保存冒烟。
2. **pi-ai / dsh-llm-pi-ai 真实形态**：`anthropicMessagesApi()` 返回对象除 `stream`/`streamSimple` 外是否还有其他调用入口绕过 `instrumentApi`（§10-6）；`toStreamChunks` 是否严格 `for await`。验证方法：宿主 asar 抽包后 `Object.keys(api)` 与消费点核对（同 T20 的方法）。
3. **bigmodel 网关**：`validateApiKey` 对 `body.code === 0` 等未观测形态的判定（DE-08 残余）；网关对并发 2 的实际限流行为。验证方法：受控网关探测（本审查禁止联网，未做）。
4. **DSH 对顶层 await 的容忍度**（§10-9）：有"插件已在真机加载运行"的事实佐证（README 已知限制 5 提及待确认项均为面板功能而非加载），但未单测加载期挂起场景。
5. **`scripts/sync-key-to-config.mjs` 运行时行为**：按铁律未执行，其写入路径/回读校验的现场行为未经本审查复现（源码审读结论见 S-01/DE-08/§6-5）。
6. **client 面板真实渲染**：stub react 与真实 React 18 的差异（`useEffect` 时序、`settingsScope.subscribe` 频率）未验证。

### 附录 C：README / TROUBLESHOOTING 一致性抽查（9 条）

| # | 声称 | 位置 | 结论 | 证据 |
|---|---|---|---|---|
| 1 | 自检"113/113"（README 两处）、"140 断言"（TROUBLESHOOTING） | README:91、README:299、TROUBLESHOOTING:622 | **不成立** | [实测] 146/146；三处数字三个值，且无守卫防再漂移 |
| 2 | "asar 内部不能用 `existsSync` 探测（恒 false），正确探测是读归档头部" | TROUBLESHOOTING §2.4 坑 B | **与代码直接矛盾** | [读码] `lib/host-modules.js:131` 正是用 `existsSync` 探测 asar 内部路径作为主解析机制，且生产可用——Electron 对 fs 的补丁使 `existsSync` 支持 asar 路径。文档表述缺"仅在未打补丁的纯 Node 上下文"限定，照文档理解会得出"插件解析机制不该工作"的错误结论 |
| 3 | "端点 baseURL 激活时读取一次；套餐端点变更需重启 DSH" | README:321（已知限制 4） | **成立** | [读码] `index.js:403`（boot 一次性）、`:428/:551`（重建也用 `boot.baseURL`） |
| 4 | 开关"缺文件/损坏 = 开启" | README:106 | **成立** | [读码] `lib/switch.js:40/50-51`；selfcheck 6 项断言 |
| 5 | "仅官方声明 1M 上下文的模型才出现 1M 单选；`applyContextBudgets` 只切到官方 Max 档" | README:147-150 | **成立** | [读码] `lib/model-meta.js:185-193`；selfcheck 预算 3 项 |
| 6 | 状态路由"GET-only、Host 与 Origin 都必须回环、响应零凭据" | README:167-171 | **成立** | [读码] `index.js:350-361`、`lib/web-status.js`；selfcheck 回环与状态文档断言；本审查 18 组边界实测无绕过 |
| 7 | "`loader/volatile-update` 联动尚未真机实测" | README:174-175 | **成立（诚实标注）** | [读码] selfcheck 的 fakeCtx 无 `on` 方法，该分支（`index.js:545-565`）从未被测试执行——文档与测试盲区互证 |
| 8 | "认证头 `x-api-key` 单头即充分，`anthropic-version` 非必需" | README:39-40 | **成立但易困惑** | [读码] 代码两处仍发送该头（`credential.js:101`、`discovery.js:115`）——发送非必需头无害，但与"非必需"表述并读易让人以为代码漏发 |
| 9 | 静态回退表带展示名（防首屏裸 id） | TROUBLESHOOTING §3.4 | **成立** | [读码] `lib/discovery.js:27-31`；selfcheck:432-439 断言 |

（另：任务书 §1.2 的行数表与 `wc -l` 系统性不符，如 index.js 560 vs 实测 639——推测为统计口径差异，不影响任务书引用的具体行号——抽查 `index.js:248`、`lib/web-status.js:47` 等引用均与当前文件吻合。）

### 附录 D：任务书 §10 十条疑点处置表

| # | 疑点 | 结论 | 对应 |
|---|---|---|---|
| 1 | `web-status.js:47` 的 `::1` 分支 | **非问题**（Lead 已排除；本审查复核 + 发现 host 侧 `'::1'` 分支对畸形 Host 仍活着但同样无害） | R-12 |
| 2 | `Semaphore.release` 不减 active | **非问题**——名额转交语义，实测守恒 | R-13 |
| 3 | Proxy 只拦 asyncIterator | **成立**——`.next()` 绕过实锤 | R-04 |
| 4 | 最坏 2+N 次串行验活 | **成立（修正细节）**：最坏 = 1+N 次×8s（config 1 次 + 候选 N 次）；发生在**每次 API 调用**（`index.js:498`，T20 实证适配器每请求 await）；缓存不做（见 §6.1），文档化 | H-03 |
| 5 | `filterGlm53Family` 硬编码 | **成立但属设计决策**（README 已知限制 8 如实声明）；补日志 | H-02 |
| 6 | `NS_PATTERN` 误绑 | **部分成立**：精确分支生产永不命中是实锤；双插件误绑是低概率理论面 | R-17 |
| 7 | bak 文件含明文 key + .gitignore 未覆盖 | **低风险非问题**：备份与 config.json 同目录同权限（config 本身明文），仓库 .gitignore 对 `~/.zcode` 不生效也无需生效；仅剩"用户把 HOME 纳入版本控制"的理论面，README 提示即可 | §6-5 |
| 8 | `bareAttempted` 永久失败 | **非问题**：仅裸导入乐观支路一次性，文件候选主路径不受影响 | DE-03 |
| 9 | 顶层 await | **基本非问题**：loadConfig 全 catch 永不 reject；DSH 容忍度有真机运行佐证；唯一残留是 `resolveSchemastery` 无超时（OS 级慢 I/O 才触发，概率极低） | 附录 B-4 |
| 10 | `apply()` disposed 竞态 | **非问题**：两时序实测均正确 | R-14 |

### 附录 E：test/selfcheck.mjs 评估（146 项保护了什么、盲区在哪）

**保护了什么**（按组）：凭据读取 5 态；凭据库解密/过滤/诊断 10 项；验活 5 态（含 200 假绿防线的假 fetch 契约）；回退 7 态（含 `fallback:false` 逃生口与诊断零明文）；开关 6 态；台账 4 项（追加写/字段/脱敏）；model-meta + discovery 约 30 项（官方元数据归一、5.3 显式过滤、buildCatalog 合并、锁定语义、预算管线、端到端发现回退）；信号量+拦截 5 项；manifest/patch/纪律 tripwire 12 项（防拒启、volatile 源码绊线、无静态宿主 import、schemastery API 面白名单、README 告示）；回环+状态文档 9 项；**全链路注册约 20 项**（stub 宿主栈 + fakeCtx：三部曲、adapter options 挂载位置、profile 预算、调用门、冻结路径、两种失败面、卸载对称）；client 半约 20 项（信封解析、slot 契约、双视图渲染、行控件锁定语义）；零明文终扫 + 主题 token 安全 4 项。

**盲区**（按危害排序）：
1. **测试自身纪律**（R-01）：投毒时机晚于 resolveApiKey；真实凭据库被读取——防线的地基问题。
2. **stub 与真实形态的无人守护**（R-10）：stub `async stream` 与注释声称的同步形态矛盾，promise 分支零断言。
3. **跨半副本**（DE-10）：client 半三个常量零比对守卫。
4. **DSH 进程内契约**：volatile-update 联动、webServer 契约、attachments 真实服务——全部依赖 fakeCtx 的签名假设。
5. **HTTP 层**：状态路由 handler 的 405/403/500 分支无测（`index.js:348-365`）。
6. **README 数字无守卫**：113→146 漂移三处无人报——可加一条 `results.length` 与 README 数字的一致性断言（或在 S-04 中修文档后加守卫）。

**立场**（任务书 D4 之问）：白盒直测内部函数在当前规模是**正确的**——它精确锁定了 `applyContextBudgets` 只认官方 Max 档、`filterGlm53Family` 显式集合等容易被"顺手重构"破坏的语义，且零框架依赖与项目无构建链的形态一致。代价是内部重构会碰测试，但这个项目的外部契约风险远大于内部重构频率，交换是划算的。真正要修的不是白盒，是上面 1-3 条防线自身的洞。

### 附录 F：交付前自检清单

- [x] 每条发现都有：维度 / 严重度 / 行号 / 证据 / 影响 / 建议 / 成本 / 验证方式 / 依赖冲突
- [x] 所有 `[实测]` 有可复制命令（附录 A）
- [x] C1–C9 全部有回应（DE-01 ~ DE-09，一条不漏）
- [x] 7 个高风险文件全部点名（§2.5 表格）
- [x] §4 输出结构的 6 个章节齐备（0 执行摘要 / 1 方法 / 2 发现清单 / 3 跨维度 / 4 简化清单 / 5 解耦路线 / 6 反建议 / 7 附录）
- [x] 全文无"建议加强""注意""可以考虑"式空话
- [x] 报告长度 ≥ 400 行
- [x] `git status --porcelain` 实测输出（交付时附于下）

```
?? HANDOFF.md
?? REVIEW-REPORT.md
?? REVIEW-TASK.md
```

**说明**：`HANDOFF.md` 与 `REVIEW-TASK.md` 是审查任务开始前即已存在的未跟踪文件（非本审查创建，见 §1.1 基线复现）。本审查创建的文件**仅** `REVIEW-REPORT.md`；未修改、未删除仓库内任何既有文件。若 Lead 需要严格的"仅一行"状态，请先处置这两个前置文件（提交或移出仓库），那是 Lead 的 git 决策，不属于本审查的授权范围。

---

*报告完。发现统计：🔴 0 / 🟠 3 / 🟡 13 / 🔵 19，共 35 条；§10 疑点 10 条全部处置（4 条核清为非问题、5 条成立或部分成立、1 条按设计决策处理）；简化净收益约 -55 行（不含注释压缩）至 -235 行（含）。*
