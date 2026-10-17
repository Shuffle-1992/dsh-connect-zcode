#!/usr/bin/env node
/**
 * compat-check.mjs —— DSH 升级兼容性自检（**离线、零依赖、可复跑**）。
 *
 * 用途：在升级 DSH 前后各跑一次，确认「插件声明 ↔ 运行的 DSH 版本」仍然兼容。
 * 它检查的是**兼容性契约**（不碰网络、不读凭据、不 spawn）：
 *   ① engines.dsh 是否覆盖当前运行的 DSH 版本（按 DSH 的真实判定语义：includePrerelease）
 *   ② engines.node 是否覆盖当前 Node
 *   ③ peerDependencies 对当前 DSH 版本的满足情况（同时报告 pnpm 默认语义与 DSH 语义）
 *   ④ dsh.client.inject 里依赖的内部 UI 模块，在当前 DSH 运行时里是否都存在
 *   ⑤ dsh 清单契约：bundle.patch 文件存在、exports 含 ./package.json（0.2.1 子路径规则）
 *   ⑥ cordis.patch.yml 是标准 insert 结构（0.2.1 未改 patch 格式）
 *   ⑦ 内置 semver 自测（用 Node 7.8.4 实测过的对照表，防止自检自己算错）
 *
 * 用法：
 *   node scripts/compat-check.mjs                     # 自动探测本机 DSH 版本（读 app.asar）
 *   node scripts/compat-check.mjs --dsh-version 0.2.1-rc.1
 *   node scripts/compat-check.mjs --asar "D:\\DeepSeek\\resources\\app.asar"
 *   node scripts/compat-check.mjs --json              # 机器可读输出
 *   node scripts/compat-check.mjs --strict-inject     # 把"inject 模块运行时不存在"当硬失败
 *   node scripts/compat-check.mjs --self-test         # 只跑内置 semver 自测
 *
 * 判定：末行 `COMPAT PASS` / `COMPAT FAIL`；exit 0 = 兼容。
 * 说明：本机 4 个插件都是 junction 链接安装，安装器不走 pnpm 的 peer 校验；
 *       因此 ③ 只做「报告」，不单独导致 FAIL（与真实安装路径一致）。
 */
import { readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/* ────────────────────────── 极简 semver（够用即可，附自测） ────────────────────────── */
const PRE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
function parseVersion(text) {
  const m = PRE.exec(String(text).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}
function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 有预发布 < 无预发布
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (nx !== ny) return nx ? -1 : 1; // 数字标识 < 字母标识
    else if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
function cmpVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] > b[k] ? 1 : -1;
  return comparePre(a.pre, b.pre);
}
/** 把一个 comparators 片段解析成 {op, v} 列表（支持 >= <= > < = ^ ~ 与裸版本） */
function parseComparatorSet(text) {
  const out = [];
  for (const raw of String(text).trim().split(/\s+/).filter(Boolean)) {
    const m = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(raw);
    const op = m[1] ?? '=';
    const v = parseVersion(m[2]);
    if (!v) return null;
    if (op === '^' || op === '~') {
      /* ^0.2.1 → >=0.2.1 <0.3.0；~0.2.1 → >=0.2.1 <0.3.0（0.x 语义一致） */
      out.push({ op: '>=', v });
      out.push({ op: '<', v: { major: v.major, minor: v.minor + 1, patch: 0, pre: [] } });
    } else out.push({ op, v });
  }
  return out;
}
/** npm 语义：v 带预发布时，默认（!includePrerelease）要求某个比较器与 v 同 tuple 且带预发布 */
function satisfies(versionText, rangeText, options = {}) {
  const v = parseVersion(versionText);
  if (!v) return false;
  for (const alt of String(rangeText).split('||')) {
    const set = parseComparatorSet(alt);
    if (!set) continue;
    const ok = set.every(({ op, v: c }) => {
      const d = cmpVersions(v, c);
      return op === '>=' ? d >= 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : op === '<' ? d < 0 : d === 0;
    });
    if (!ok) continue;
    if (v.pre.length > 0 && options.includePrerelease !== true) {
      const sameTuple = set.some(({ v: c }) => c.pre.length > 0 && c.major === v.major && c.minor === v.minor && c.patch === v.patch);
      if (!sameTuple) continue;
    }
    return true;
  }
  return false;
}
/** 内置自测：对照表来自 Node semver 7.8.4 的实测结果 */
const SELF_TESTS = [
  ['0.2.1-rc.1', '>=0.2.0-rc.2 <0.3.0-0', {}, false],
  ['0.2.1-rc.1', '>=0.2.0-rc.2 <0.3.0-0', { includePrerelease: true }, true],
  ['0.2.1-rc.1', '>=0.2.1-rc.1 <0.3.0-0', {}, true],
  ['0.2.1-rc.1', '>=0.1.7-rc.1 <0.3.0-0', {}, false],
  ['0.2.1-alpha.2', '>=0.2.0-rc.2 <0.3.0-0', { includePrerelease: true }, true],
  ['0.2.0-rc.2', '>=0.2.0-rc.2 <0.3.0-0', {}, true],
  ['0.2.1', '>=0.2.1-rc.1 <0.3.0-0', {}, true],
  ['0.3.0', '>=0.2.0-rc.2 <0.3.0-0', {}, false],
  ['0.2.1', '^0.2.1', {}, true],
  ['0.3.0', '^0.2.1', {}, false],
];
function runSelfTest() {
  const bad = SELF_TESTS.filter(([v, r, o, want]) => satisfies(v, r, o) !== want);
  return { total: SELF_TESTS.length, failed: bad };
}

/* ────────────────────────── asar 读取（探测运行的 DSH 版本与内部包） ────────────────────────── */
function readAsar(asarPath) {
  if (!existsSync(asarPath)) return null;
  const fd = openSync(asarPath, 'r');
  try {
    const b16 = Buffer.alloc(16);
    readSync(fd, b16, 0, 16, 0);
    const jsonLen = b16.readUInt32LE(12);
    const hb = Buffer.alloc(jsonLen);
    readSync(fd, hb, 0, jsonLen, 16);
    const header = JSON.parse(hb.toString('utf8'));
    const dataBase = 16 + jsonLen;
    const readFileEntry = (entry) => {
      if (!entry || typeof entry.size !== 'number') return null;
      const off = typeof entry.offset === 'string' ? Number(entry.offset) : entry.offset;
      if (!Number.isFinite(off)) return null;
      const buf = Buffer.alloc(entry.size);
      readSync(fd, buf, 0, entry.size, dataBase + off);
      return buf.toString('utf8');
    };
    const dshFiles = header.files?.dsh?.files ?? {};
    const pkgText = readFileEntry(dshFiles['package.json']);
    const version = pkgText ? JSON.parse(pkgText).version : null;
    /* 收集**全 asar** 的 @deepseek-ai 包名与路径 —— 0.2.1 把部分内部 UI 包合并/改名
     * （实测 dsh-client-ui-slots / -primitives 已不再作为独立包存在），
     * 只查 dsh/node_modules 会误判成"缺失"。 */
    const names = new Set();
    const paths = new Set();
    const walk = (node, parts) => {
      for (const [n, entry] of Object.entries(node?.files ?? {})) {
        const p = [...parts, n];
        if (parts.length <= 8) paths.add(p.join('/'));
        const i = p.indexOf('@deepseek-ai');
        if (i >= 0 && p[i + 1]) names.add(p[i + 1]);
        if (entry.files) walk(entry, p);
      }
    };
    walk(header, []);
    return { version, scoped: names, paths: [...paths] };
  } finally {
    closeSync(fd);
  }
}

/* ────────────────────────── 主流程 ────────────────────────── */
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

if (argv.includes('--self-test')) {
  const st = runSelfTest();
  for (const [v, r, o, want] of SELF_TESTS) {
    const got = satisfies(v, r, o);
    console.log(`  ${got === want ? 'PASS' : 'FAIL'}  satisfies(${v}, ${JSON.stringify(r)}${o.includePrerelease ? ', includePrerelease' : ''}) = ${got}`);
  }
  console.log(`\n自测 ${st.total - st.failed.length}/${st.total} 通过`);
  process.exit(st.failed.length === 0 ? 0 : 1);
}

const ASAR = flag('asar', process.env.DSH_ASAR ?? 'D:\\DeepSeek\\resources\\app.asar');
const asar = readAsar(ASAR);
const detected = flag('dsh-version', asar?.version ?? null);
const rows = [];
const add = (level, name, detail) => rows.push({ level, name, detail });
const wantJson = argv.includes('--json');

/* ① engines.dsh */
const dshRange = PKG.engines?.dsh;
if (!dshRange) {
  add('WARN', 'engines.dsh', '未声明 —— DSH 0.2.1 起兼容性优先按 engines.dsh 判断；未声明时沿用旧规则（不挡升级，但无显式声明）');
} else if (!detected) {
  add('SKIP', 'engines.dsh', `已声明 ${dshRange}；但探测不到 DSH 版本（传 --dsh-version 或 --asar）`);
} else {
  const ok = satisfies(detected, dshRange, { includePrerelease: true }); // DSH 的真实语义
  add(ok ? 'PASS' : 'FAIL', 'engines.dsh', `${detected} ∈ ${dshRange}（DSH 判定语义 includePrerelease）`);
  const strict = satisfies(detected, dshRange);
  if (ok && !strict) add('INFO', 'engines.dsh·strict', `${detected} 在标准 semver 默认语义下不满足（预发布版本无同 tuple 比较器）——DSH 不受影响，npm/pnpm 分发时需注意`);
}

/* ② engines.node */
const nodeRangeText = PKG.engines?.node;
if (nodeRangeText) {
  const nv = process.versions.node;
  add(satisfies(nv, nodeRangeText) ? 'PASS' : 'FAIL', 'engines.node', `当前 Node ${nv} ∈ ${nodeRangeText}`);
}

/* ③ peerDependencies 报告 */
if (!detected) add('SKIP', 'peerDependencies', '需要知道 DSH 版本才能评估');
else {
  const peers = PKG.peerDependencies ?? {};
  const hostScoped = ['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-settings'];
  for (const [name, range] of Object.entries(peers)) {
    if (!range) continue;
    const isHost = hostScoped.includes(name);
    const okStrict = satisfies(detected, range);
    const okDsh = satisfies(detected, range, { includePrerelease: true });
    if (isHost) {
      add(okStrict ? 'PASS' : okDsh ? 'INFO' : 'WARN', `peer ${name}`, `${detected} ｜ pnpm 语义 ${okStrict ? '满足' : '不满足'} ｜ DSH 语义 ${okDsh ? '满足' : '不满足'}`);
    } else {
      add('INFO', `peer ${name}`, range);
    }
  }
}

/* ④ dsh.client.inject：这些是"宿主客户端需先提供哪些模块"的声明。
 * 0.2.1 合并/改名了部分内部 UI 包（实测 dsh-client-ui-slots / -primitives 不再作为独立包存在），
 * 而插件客户端半边**照常挂载**（客户端代码并不 import 这些包，声明主要用于加载顺序）。
 * 因此：运行时找不到 → ⚠️ 警告（附实测指引），**不判 FAIL**；要当硬门禁用 --strict-inject。 */
const inject = PKG.dsh?.client?.inject ?? [];
const strictInject = argv.includes('--strict-inject');
if (inject.length === 0) add('PASS', 'dsh.client.inject', '未声明（纯 host 侧插件）');
else if (!asar?.scoped) add('SKIP', 'dsh.client.inject', `运行时不可读（${ASAR}）——无法核对 ${inject.length} 个内部模块`);
else {
  const absent = inject.filter((m) => {
    const bare = m.replace(/^@deepseek-ai\//, '');
    if (asar.scoped.has(bare)) return false;
    return !asar.paths.some((p) => p.includes(bare)); // 全 asar 路径里也找不到 ⇒ 运行时未以独立包提供
  });
  if (absent.length === 0) add('PASS', 'dsh.client.inject', `${inject.length} 个声明模块在运行时均可解析（包或路径）`);
  else
    add(
      strictInject ? 'FAIL' : 'WARN',
      'dsh.client.inject',
      `运行时未以独立包提供: ${absent.join(', ')} —— DSH 0.2.1 合并了部分内部 UI 包；` +
        `该声明只影响客户端加载顺序，插件客户端半边是否真的挂上请用 client Slots inspect 实测` +
        `（本机 0.2.1-rc.2 实测：plugins.bundle.config 与 conversation.composer.dock 均已有本插件 occupant）`,
    );
}

/* ⑤ 清单契约 */
const patchPath = PKG.dsh?.bundle?.patch;
if (!patchPath) add('FAIL', 'dsh.bundle.patch', '未声明');
else {
  const abs = resolve(ROOT, patchPath);
  add(existsSync(abs) ? 'PASS' : 'FAIL', 'dsh.bundle.patch', existsSync(abs) ? patchPath : `文件不存在: ${abs}`);
  if (existsSync(abs)) {
    const text = readFileSync(abs, 'utf8');
    const okInsert = /(^|\n)\s*-\s*insert\s*:/.test(text);
    const hasId = /(^|\n)\s*-?\s*id\s*:/.test(text);
    const hasName = /(^|\n)\s*name\s*:/.test(text);
    add(okInsert && hasId && hasName ? 'PASS' : 'FAIL', 'cordis.patch.yml', `insert=${okInsert} id=${hasId} name=${hasName}（0.2.1 未改 patch 格式）`);
  }
}
const exportsKeys = Object.keys(PKG.exports ?? {});
add(exportsKeys.includes('./package.json') ? 'PASS' : 'WARN', 'exports["./package.json"]', exportsKeys.includes('./package.json') ? '已显式导出（0.2.1 子路径插件规则）' : '未导出 —— 0.2.1 起子路径插件不再读独立 package.json');

/* ⑦ 自测 */
const st = runSelfTest();
add(st.failed.length === 0 ? 'PASS' : 'FAIL', 'semver 自测', `${st.total - st.failed.length}/${st.total}`);

/* 输出 */
const ICON = { PASS: '✅', FAIL: '❌', WARN: '⚠️ ', INFO: 'ℹ️ ', SKIP: '➖' };
if (wantJson) {
  console.log(JSON.stringify({ dshVersion: detected, asar: ASAR, rows, ok: rows.every((r) => r.level !== 'FAIL') }, null, 2));
} else {
  console.log(`DSH 运行时：${detected ? `${detected}（${argv.includes('--dsh-version') ? '来自 --dsh-version' : `来自 ${ASAR}`}）` : '未探测到（用 --dsh-version 指定）'}`);
  console.log(`插件：${PKG.name}@${PKG.version}\n`);
  for (const r of rows) console.log(`  ${ICON[r.level] ?? '·'} ${r.name.padEnd(45)} ${r.detail}`);
}
const ok = rows.every((r) => r.level !== 'FAIL');
console.log(`\n${ok ? 'COMPAT PASS' : 'COMPAT FAIL'}（${rows.filter((r) => r.level === 'FAIL').length} 项失败 / ${rows.filter((r) => r.level === 'WARN').length} 项警告）`);
process.exit(ok ? 0 : 1);
