#!/usr/bin/env node
/**
 * sync-key-to-config.mjs —— **凭据失配恢复工具**（方案 A）。
 *
 * 何时需要（2026-10-01 真机事故）：
 *   ZCode 桌面端在 **OAuth 重新登录/重新授权**后，把新签发的 API Key 只写进加密凭据库
 *   `~/.zcode/v2/credentials.json`，**不回写** `~/.zcode/v2/config.json`；而 config.json
 *   里留着**已失效的旧 Key**。于是**一切读 config.json 的程序都 401** —— 包括 ZCode 自己的
 *   Agent CLI（`zcode.cjs -p ...` 实测同样 401）。
 *
 * 本工具做什么：
 *   1. 读加密凭据库，解出全部 coding-plan 的 api-key 候选；
 *   2. **逐把验活**（GET /v1/models，且**校验响应体** —— 网关对失效 key 也返回 HTTP 200）；
 *   3. 把第一把验活通过的 key **原子写回** config.json 的对应条目（写前备份、写后回读校验）。
 *
 * 与插件内建回退（方案 B）的关系：
 *   - 方案 B（`lib/credential-store.js`）只让**本插件**跟随凭据库；
 *   - 方案 A（本工具）修好 **config.json 本身**，因此 ZCode CLI、其他项目、任何读 config.json
 *     的工具都一起恢复。**建议先用本工具止血，插件回退作为长期保险。**
 *
 * 安全与纪律：
 *   - **全程不打印任何 key 原文**（只打指纹 head/tail）；
 *   - 只在验活通过后才写入；**验活不通过则拒绝写入**（绝不做无依据修改）；
 *   - 写入用「临时文件 + rename」原子替换；写前备份 `config.json.bak-dsh-<时间戳>`；
 *   - 明文写入 config.json 是 **ZCode 自身的设计**（它本来就明文存 key），本工具不新增暴露面，
 *     但请知悉该文件含明文凭据、勿提交入库。
 *
 * 用法：
 *   node scripts/sync-key-to-config.mjs            # 检查 + 恢复（有变更才写）
 *   node scripts/sync-key-to-config.mjs --dry-run  # 只检查与报告，不写
 *   node scripts/sync-key-to-config.mjs --plan-key builtin:bigmodel-coding-plan
 *
 * 退出码：0 = config.json 已是有效 key（无需改动）或已完成修复；1 = 无可用的有效 key（未改动）。
 */
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/* ⚠️ S-01（2026-10-06 复核）：解密 / secret 推导 / key 形态 / 验活**一律复用 lib 单实现**。
 * 原先本脚本把 credential-store.js 的 ENC_PREFIX/resolveSecret/decrypt/API_KEY_RE 与
 * credential.js 的验体逻辑整段复制了一份（约 40 行），构成 C2（逆向契约）的**两份手工同步副本**：
 * 任何一侧因 ZCode 加密格式变化而修改而另一侧遗漏 → 方案 A（修 config.json）与方案 B
 * （插件内建回退）行为分叉，用户按 README 跑完恢复工具"修好了"，插件回退却仍失败。
 * lib/credential-store.js 与 lib/credential.js 均为纯 ESM 且无宿主依赖，可安全相对 import
 * （注意：**不可** import 本包 index.js —— 它有顶层 await 与宿主模块解析）。 */
import { decryptCredentialValue, readStoredApiKeys } from '../lib/credential-store.js';
import { validateApiKey } from '../lib/credential.js';

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const PLAN_KEY = (() => {
  const i = ARGS.indexOf('--plan-key');
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : 'builtin:bigmodel-coding-plan';
})();

const V2 = join(homedir(), '.zcode', 'v2');
const CONFIG_PATH = join(V2, 'config.json');
const STORE_PATH = join(V2, 'credentials.json');
const DEFAULT_BASE = 'https://open.bigmodel.cn/api/anthropic';

const fp = (k) => (typeof k === 'string' && k.length >= 12 ? `head=${k.slice(0, 8)}*** tail=***${k.slice(-4)}` : '(invalid)');

/* ---------- 验活（复用 lib/credential.js 的 validateApiKey：含"HTTP 200 也可能是认证失败"的验体逻辑） ---------- */
async function validate(apiKey, baseURL, timeoutMs = 8000) {
  const ok = await validateApiKey(apiKey, baseURL, { timeoutMs });
  return { ok, why: ok ? '验活通过（/v1/models 返回非空 data）' : `验活失败（详见 lib/credential.js：非 2xx / body.success=false / body.code≠200 / data 空）` };
}

/* ---------- 主流程 ---------- */
async function main() {
  console.log('[sync-key] 目标条目:', PLAN_KEY);
  console.log('[sync-key] config.json :', CONFIG_PATH);
  console.log('[sync-key] 凭据库      :', STORE_PATH, DRY_RUN ? '（--dry-run，不写入）' : '');

  if (!existsSync(CONFIG_PATH)) {
    console.error('[sync-key] ❌ 找不到 config.json；请先在 ZCode 桌面端登录后重试。');
    return 1;
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const entry = cfg?.provider?.[PLAN_KEY];
  if (!entry || typeof entry !== 'object') {
    console.error(`[sync-key] ❌ config.json 里找不到条目 ${PLAN_KEY}；请先在 ZCode 桌面端启用该套餐。`);
    return 1;
  }
  const baseURL = entry?.options?.baseURL ?? DEFAULT_BASE;
  const current = entry?.options?.apiKey;

  // 1) 现状验活
  if (typeof current === 'string' && current.length > 0) {
    const r = await validate(current, baseURL);
    console.log(`[sync-key] 现状 key ${fp(current)} → ${r.ok ? '✅ 有效' : `❌ 无效（${r.why}）`}`);
    if (r.ok) {
      console.log('[sync-key] config.json 已是有效 key，无需改动。');
      return 0;
    }
  } else {
    console.log('[sync-key] 现状：config.json 无 apiKey');
  }

  // 2) 收集凭据库候选（解密/形态过滤/诊断一律走 lib 单实现，S-01）
  if (!existsSync(STORE_PATH)) {
    console.error('[sync-key] ❌ 找不到凭据库，且现状 key 无效；无法自动恢复。请打开 ZCode 桌面端重新登录。');
    return 1;
  }
  /* readStoredApiKeys 已是"只认 coding-plan + 只认 api-key 形态 + 解密失败/形态不符带诊断"的单实现，
   * 且诊断文案与插件方案 B 完全一致（同一函数），方案 A/B 行为不会再分叉。 */
  const candidates = readStoredApiKeys(STORE_PATH, {
    onDiagnostic: (msg) => console.warn(`[sync-key]   ⚠️ ${msg}`),
  });
  console.log(`[sync-key] 凭据库候选 ${candidates.length} 把`);
  if (candidates.length === 0) {
    console.error(
      '[sync-key] ❌ 凭据库中没有可用的 coding-plan api-key 候选（原因见上面的 ⚠️ 诊断：' +
        '条目缺失 / 解密失败（secret 不匹配或 ZCode 更换了加密格式）/ 形态不符）。' +
        '请打开 ZCode 桌面端重新登录。'
    );
    return 1;
  }

  // 3) 逐把验活，取第一把通过的
  let chosen = null;
  for (const c of candidates) {
    const r = await validate(c.apiKey, baseURL);
    console.log(`[sync-key]   候选 ${c.id} ${fp(c.apiKey)} → ${r.ok ? `✅ ${r.why}` : `❌ ${r.why}`}`);
    if (r.ok && chosen === null) chosen = c;
  }
  if (chosen === null) {
    console.error('[sync-key] ❌ 凭据库中所有候选均验活失败，**拒绝写入**（不做无依据修改）。请打开 ZCode 桌面端重新登录。');
    return 1;
  }

  // 4) 备份 + 原子写入 + 回读校验
  console.log(`\n[sync-key] 选定：${chosen.id} ${fp(chosen.apiKey)}`);
  if (DRY_RUN) {
    console.log('[sync-key] --dry-run：跳过写入。去掉该参数即可执行。');
    return 0;
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const backup = `${CONFIG_PATH}.bak-dsh-${stamp}`;
  copyFileSync(CONFIG_PATH, backup);
  console.log(`[sync-key] 已备份 → ${backup}`);

  entry.options = { ...(entry.options ?? {}), apiKey: chosen.apiKey, baseURL };
  entry.enabled = true;
  const tmp = `${CONFIG_PATH}.dsh-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  renameSync(tmp, CONFIG_PATH);

  const back = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const ok = back?.provider?.[PLAN_KEY]?.options?.apiKey === chosen.apiKey;
  console.log(`[sync-key] 回读校验：${ok ? '✅ 一致' : '❌ 不一致'}`);
  if (!ok) {
    console.error(`[sync-key] 回读失败；可用备份还原：copy "${backup}" "${CONFIG_PATH}"`);
    return 1;
  }
  console.log('[sync-key] ✅ 完成。ZCode CLI 与其他读 config.json 的工具应已恢复；必要时重启 ZCode/DSH。');
  return 0;
}

/**
 * 收尾方式说明：**不要用 process.exit()**。
 * 本脚本用过 fetch（undici），其 keep-alive 套接字未关闭时硬 exit 会触发 Windows 上的
 * libuv 断言崩溃（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，
 * 退出码 -1073740791）。改为设置 process.exitCode 让事件循环自然收尾。
 */
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[sync-key] 意外错误:', String(err?.message ?? err).slice(0, 200));
    process.exitCode = 1;
  });
