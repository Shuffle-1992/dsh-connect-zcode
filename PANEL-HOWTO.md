# 自定义插件面板：怎么配、怎么让它**真的显示出来**

> 本文由 `dsh-connect-zcode` 的实测经验写成（2026-10，DSH 0.2.1-rc.2，面板见该插件详情页 v0.6.0）。
> 目标读者：**正在做 client 半面板、但面板一直不显示**的插件作者。
> 本文所有代码片段都取自本仓库**已在真机跑通**的实现，可直接对照。

---

## 0. 先记住生效链路（90% 的"改了没反应"都在这里）

| 你改了什么 | 生效方式 |
|---|---|
| `lib/client.js`（组件/render 逻辑） | **重载页面**（F5）。若同时跑 `pnpm run dev:web` 才可能 HMR |
| `index.js`（host 半） | **toggle 插件**（关→开）或重启 DSH |
| `package.json` 的 `dsh.client` / `exports` / `cordis.patch.yml` | **重启 DSH**（清单在启动时读） |
| `cordis.patch.yml` 的 `- id:`（= settingsNs） | 重启 DSH；client 侧要同步改常量 |

**排查第一动作永远是：打开浏览器控制台**，搜你的插件名。面板注册失败**不会**弹 UI 错误，只会 `console.error`。

---

## 1. 四处必配（缺一处就是"面板不显示"）

### ① `package.json`：清单 + client 入口

```json
{
  "exports": {
    ".": "./index.js",
    "./client": "./lib/client.js",      // ← client 半入口，缺了 DSH 找不到
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [                        // ← 客户端依赖的**加载顺序**声明
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-settings-plugins",
        "@deepseek-ai/dsh-client-ui-primitives",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```

**这份 `inject` 清单里，与"面板能不能显示/能不能写"直接相关的是前五个**：

| 包 | 提供什么（与面板的关系） |
|---|---|
| `@deepseek-ai/dsh-api-remotes` | `remote` 服务 —— `configForms` 的依赖链起点 |
| `@deepseek-ai/dsh-client-ui-settings` | **`configForms`**（面板可读写的关键） |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | `plugins.bundle.config` 槽位的宿主侧渲染 |
| `@deepseek-ai/dsh-client-ui-slots` | `slots` 服务（你 `ctx.slots.register` 的落点） |
| `@deepseek-ai/dsh-client-ui-renderer` | 基础渲染 |

> 后两个（`...ui-primitives` / `...client-locale`）在本插件是**照 trae 同款声明**，0.2.1 已把部分 UI 包合并进别的包
> （compat-check 会给信息性警告）。**我们没逐个隔离做过实验**：删掉某个是否仍能挂载，未验证 —— 建议**先照抄这份清单**。

### ② `lib/client.js`：必须是**信封 bundle**（自足、零静态 import）

```js
window.__ModuleLoader__.load({
  id: "dsh-connect-zcode",          // ← 必须 = 包名（ModuleLoader 表的 key）
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");   // ← 唯一允许的外部 require
    const el = react.createElement; // 手写 createElement：不引 JSX、不引构建链
    // ...组件与 apply...
    exports.apply = apply;
    exports.inject = inject;        // ["slots", "locale", "remote"]
    exports.name = "your-plugin-client";
    return module.exports;
  },
});
```

**红线**：文件里**不能出现静态 `import`**，`require("...")` 也只能是 `"react"`。
（本仓库自检断言：`!/\bimport\s/.test(src) && !/require\("(?!react")/.test(src)`）
**违反的后果是"拒启"** —— client 半整体不加载，页面看起来就是"面板没出来"。

### ③ `apply(ctx)`：注册槽位 —— `key` 必须是**包名**

```js
function apply(ctx) {
  try {
    const registerCard = (slotName, key) => {
      try {
        ctx.slots.inject(slotName, () => ctx.slots.register({
          name: slotName,                              // "plugins.bundle.config"
          key,                                         // ← 插件**包名**（bundle key）
          priority: 30,
          inject: () => ({ settingsScope, statusRef }), // 传给组件的 props
        }, ZcodePanelCard));
      } catch (error) {
        console.error(`[your-plugin] card slot "${slotName}" failed to register:`, error);
      }
    };
    registerCard("plugins.bundle.config", "your-plugin-package-name");
  } catch (error) {
    /* apply 整体 try/catch：面板坏了也**不能**影响 host 的 provider */
    console.error("[your-plugin] client panel failed to load:", error);
  }
}
```

- 槽位名：`plugins.bundle.config`（插件详情页卡片）、`conversation.composer.dock`（输入框下方，list 型，注册描述符还需 `id` + `order`）。
- **`key` 写错 = 卡不显示**（不是 entry id、不是 displayName、是**包名**）。

### ④ `settingsScope`：面板"可写"的硬前提（`configForms` + settingsNs）

```js
const forms = ctx.get("configForms");                 // 软取，缺席 → 面板降级只读
const all = forms?.describe().getSnapshot().view?.namespaces ?? [];
const exact = all.find((e) => e.ns === NS_EXACT);     // ← 精确 = cordis.patch.yml 的 `- id:`
const fuzzy = all.filter((e) => NS_PATTERN.test(e.ns));
const served = exact ?? fuzzy[0];
const scope = forms?.get(served?.ns);
```

- **`NS_EXACT` 必须等于 `cordis.patch.yml` 里的 `- id:`**（本插件是 `zcode-connect`）。用 `displayName`/包名去比一律不命中 ⇒ `scope` 恒 undefined ⇒ 面板**永远只读**（控件 disabled / 提示"设置命名空间不可写"）。
- 读到 `undefined` 时先 `forms.describe().load()` 再重绑一次（镜像就绪有延迟）；并 `forms.describe().subscribe(rebind)` 跟随重绑。
- **写后必须回读校验**：`scope.set()` resolve **不等于**真的写进去了（见下"volatile"）。

---

## 2. host 半：只读状态从哪来（面板要显示"事实"就得有它）

client 半拿不到文件系统/配置，**显示用的数据一律走 host 的回环路由**：

```js
export const inject = ['llm'];                    // host 半的必需服务
// 可选：软取 webServer，缺席只降级不报错
ctx.inject(['webServer'], (webCtx) => {
  webCtx.effect(() => webCtx.webServer.register({
    kind: 'exact',
    path: '/plugins/<包名>/status',
    handler: async (req, res) => {
      if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' });
      if (!hostIsLoopback(req.headers?.host)) return writeJson(res, 403, { error: 'host_not_allowed' });
      if (!originIsLoopback(req.headers?.origin)) return writeJson(res, 403, { error: 'origin_not_allowed' });
      writeJson(res, 200, buildStatusDocument(deps));   // 纯函数、零凭据
    },
  }), '<包名>: panel status route');
});
```

**注意**：
- 路由路径在 **client 与 host 两处各有一份字面量**（client 不能 import host）⇒ 用断言钉死一致性，否则一边改就 404。
- 该路由**只在内嵌 web 服务上可达且需 DSH 连接鉴权**：用 curl 直连端口会 **401/403**，这不代表没注册。验证要在页面里看面板，而不是 curl。
- 响应**零凭据**（只出 host/计数/短字符串），且每项独立 try/catch —— 一项读不到不许打挂整份文档（否则面板整块空白）。

---

## 3. 面板"显示了但内容不对/不生效"的四条铁律

1. **写入字段必须在 host 的 Config schema 里打 `volatile`**。DSH 的写入门禁只放行 volatile 字段；漏标时 `set()` 照样 resolve，表现为"**面板看着保存成功、实际没生效**"。
   （本插件真机事故：`appServerReasoningLevel` 漏标 ⇒ 报 `Host 拒绝写入 …`。修法：`asVolatile(z.string()...)`，并把每个面板写入字段都加一条 tripwire 断言。）
2. **必须活读**：面板写入的是 volatile 活引用，host 要每次 `*Of(rawConfig)` 现读，**不要缓存快照**，否则"改完要重启才生效"。
3. **显示以状态文档为准，不要用静态表猜**：数据缺席时给**可操作原因**（例："未注册：<reason>"）而不是空列表，也不要显示不存在的行。
4. **写后回读校验**：`await scope.set(f, v)` 之后 `getSnapshot()` 比对，不一致就报错（否则静默回弹）。

---

## 4. 「面板一直不显示」排查表（按可能性排序）

| # | 现象 | 最可能原因 | 怎么定位 |
|---|---|---|---|
| 1 | 插件详情页完全没有卡片，控制台无报错 | `package.json` 缺 `dsh.client` 或 `exports["./client"]` | 对 package.json 逐字比对第 1 节①；改完**重启 DSH** |
| 2 | 同上 + 控制台有 "refused/refuse to load" | client bundle 里有静态 `import` 或非 react 的 `require` | 跑一条断言：`!/\bimport\s/ && !/require\("(?!react")/` |
| 3 | 卡片区域空白/不出现，控制台有你的前缀 error | 组件抛错被 `apply` 的 try/catch 吞了 | 看那条 error 的 stack；`slots.register` 的签名/参数写错是最常见 |
| 4 | 卡片出现但控件全灰、"设置命名空间不可写" | `configForms` 缺席（`inject` 缺 `dsh-client-ui-settings`/`dsh-api-remotes`）或 `NS_EXACT` 不等于 entry id | 控制台打印 `forms?.describe().getSnapshot()`，看 `view.namespaces[].ns` 的真实值 |
| 5 | 卡片出现但只显示 loading/空 | 状态路由：路径两处不一致 / 未注册 / 直连端口被 401 | 页面 Network 里找 `/plugins/<包名>/status` 的状态码 |
| 6 | 卡片干脆不渲染（组件返回 `null`） | 你的组件在数据缺席时 `return null`；或视图门禁（dock 类槽位只在 composer + 有会话时渲染） | 临时把 `return null` 换成占位文案，确认是"没渲染"还是"渲染成空" |
| 7 | 保存后重开页面又变回去 | 字段没打 `volatile`，或 host 没活读 | host 侧 `Config` 投影里查该字段有没有 `x-cordis.volatile` |
| 8 | 只在某个视图/位置不显示 | 槽位名选错（`plugins.bundle.config` 只在**插件详情页**；`conversation.composer.dock` 只在 composer 变体且有会话） | 换到正确页面/有会话时再看 |
| 9 | 改完 client 完全没反应 | 页面没重载（client bundle 有缓存） | F5；确认是否配了 `pnpm run dev:web`（没有 HMR 就只能刷新） |
| 10 | 改完 host 完全没反应 | 没 toggle / 没重启 | toggle 插件（关→开） |

---

## 5. 最小骨架自检（贴进你的 test 里就能防住前 4 类）

```js
/* client 半：信封自足 + 卡注册键正确（源码级，client 不能 import host） */
const src = readFileSync('lib/client.js', 'utf8');
assert(!/\bimport\s/.test(src) && !/require\("(?!react")/.test(src));       // 防拒启
assert(src.includes('window.__ModuleLoader__.load({'));                     // 信封
assert(src.includes(`id: "你的包名"`));                                     // 信封 id = 包名
assert(src.includes('"plugins.bundle.config"'));                            // 槽位名
assert(src.includes('registerCard("plugins.bundle.config", "你的包名")'));   // key = 包名

/* 清单契约 */
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert(pkg.exports['./client'] && pkg.dsh.client.platform === 'web');
assert(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));

/* 常量副本一致性（client 与 host 各写一份，必须钉死） */
assert(src.includes(`STATUS_PATH = "/plugins/你的包名/status"`));
```

> 本仓库对应文件：清单 `package.json`、信封与卡 `lib/client.js`、状态路由 `index.js#registerStatusRoute`、
> 契约自检 `test/selfcheck.mjs`（7.5 段）、离线清单检查 `scripts/compat-check.mjs`。
