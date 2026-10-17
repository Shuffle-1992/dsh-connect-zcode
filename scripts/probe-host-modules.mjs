#!/usr/bin/env node
/**
 * probe-host-modules.mjs —— **离线**验证宿主模块解析链在当前 DSH 上是否命中（ZB-48）。
 *
 * 为什么要这个探针：真机事故（2026-10-17）—— `schemastery` 3.18.4 → 3.18.5 把入口从
 * `lib/index.js` 改成 `lib/index.mjs`/`lib/index.cjs`，插件的静态候选清单全部落空 ⇒ Config
 * 悄悄降级成手写 schema ⇒ DSH 0.2.1 直接抛 `Async config validation is not supported`，
 * 每次 toggle 插件都报错。修法是"清单驱动解析"（读包自己的 package.json），
 * 但**那只能在 DSH 进程里生效**（asar 是 Electron 的透明层，普通 Node 打不开）。
 *
 * 本探针用**纯 Node 解析 asar 头**来回答同一个问题：给定当前安装的 DSH，
 * 解析链会不会找到入口？不启动 DSH、不联网、零额度。
 *
 * 用法：
 *   node scripts/probe-host-modules.mjs                # 默认读 D:\DeepSeek\resources\app.asar
 *   node scripts/probe-host-modules.mjs --asar <path>
 *   node scripts/probe-host-modules.mjs --json
 * 判定：末行 `PROBE PASS` / `PROBE FAIL`；exit 0 = 所有必需包都能解析到入口。
 */
import { openSync, readSync, closeSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const ASAR = flag('asar', process.env.DSH_ASAR ?? 'D:\\DeepSeek\\resources\\app.asar');

/** 需要解析的包（与 lib/host-modules.js 的 REQUIRED/OPTIONAL 对应；required 缺失即判 FAIL）。 */
const PACKAGES = [
  { spec: '@deepseek-ai/schemastery', required: true, what: 'z.object' },
  { spec: '@deepseek-ai/dsh-llm', required: true, what: 'resolveRetryPolicy' },
  { spec: '@deepseek-ai/dsh-llm-pi-ai', required: true, what: 'PiAiAdapter' },
  { spec: '@earendil-works/pi-ai', required: true, what: 'createProvider' },
  { spec: '@earendil-works/pi-ai/anthropic', required: true, what: 'anthropicMessagesApi' },
];
/** 静态兜底候选（与 host-modules 的 files 同源；清单驱动失败时才用）。 */
const STATIC_FILES = ['lib/index.js', 'lib/index.mjs', 'lib/index.cjs', 'dist/index.js', 'dist/index.mjs', 'index.js', 'index.mjs', 'index.cjs'];

if (!existsSync(ASAR)) {
  console.log(`ASAR 不存在: ${ASAR}`);
  process.exit(1);
}
const fd = openSync(ASAR, 'r');
const b16 = Buffer.alloc(16);
readSync(fd, b16, 0, 16, 0);
const jsonLen = b16.readUInt32LE(12);
const hb = Buffer.alloc(jsonLen);
readSync(fd, hb, 0, jsonLen, 16);
const header = JSON.parse(hb.toString('utf8'));
const dataBase = 16 + jsonLen;
const readEntry = (entry) => {
  if (!entry || typeof entry.size !== 'number') return null;
  const off = typeof entry.offset === 'string' ? Number(entry.offset) : entry.offset;
  const buf = Buffer.alloc(entry.size);
  readSync(fd, buf, 0, entry.size, dataBase + off);
  return buf.toString('utf8');
};
/** 收集所有路径（'a/b/c'），用于"文件是否存在"判断。 */
const allPaths = new Set();
const walk = (node, parts) => {
  for (const [name, entry] of Object.entries(node?.files ?? {})) {
    const p = [...parts, name];
    allPaths.add(p.join('/'));
    if (entry.files) walk(entry, p);
  }
};
walk(header, []);
/** 找包目录：可能在 `dsh/node_modules` 或顶层 `node_modules`。 */
function findPackageDir(spec) {
  const segs = spec.split('/');
  const dirParts = segs.slice(0, segs[0].startsWith('@') ? 2 : 1); // @scope/name 或 name
  for (const root of ['dsh/node_modules', 'node_modules']) {
    const base = `${root}/${dirParts.join('/')}`;
    if (allPaths.has(`${base}/package.json`)) return base;
  }
  return null;
}
function manifestEntries(pkgDir) {
  const text = readEntry(getEntry(`${pkgDir}/package.json`));
  if (!text) return [];
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  const push = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (v !== null && typeof v === 'object') for (const k of ['import', 'require', 'default', 'node']) push(v[k]);
  };
  const dot = pkg?.exports;
  if (typeof dot === 'string') out.push(dot);
  else if (dot !== null && typeof dot === 'object') push(dot['.'] ?? dot);
  if (typeof pkg?.module === 'string') out.push(pkg.module);
  if (typeof pkg?.main === 'string') out.push(pkg.main);
  return [...new Set(out.filter((r) => typeof r === 'string' && r !== '' && !r.startsWith('/') && !r.includes('..')).map((r) => r.replace(/^\.\//, '')))];
}
function getEntry(pathStr) {
  let node = header;
  for (const seg of pathStr.split('/')) {
    if (!node?.files?.[seg]) return null;
    node = node.files[seg];
  }
  return node;
}

const rows = [];
for (const pkg of PACKAGES) {
  const dir = findPackageDir(pkg.spec);
  if (dir === null) {
    rows.push({ spec: pkg.spec, required: pkg.required, dir: null, entry: null, source: 'not-installed' });
    continue;
  }
  const manifest = manifestEntries(dir).filter((rel) => allPaths.has(`${dir}/${rel}`));
  const statics = STATIC_FILES.filter((rel) => allPaths.has(`${dir}/${rel}`));
  const entry = manifest[0] ?? statics[0] ?? null;
  rows.push({ spec: pkg.spec, required: pkg.required, dir, entry, source: manifest[0] ? 'manifest' : statics[0] ? 'static' : 'missing', tried: [...manifest, ...statics].slice(0, 4) });
}
closeSync(fd);

if (argv.includes('--json')) {
  console.log(JSON.stringify({ asar: ASAR, rows, ok: rows.every((r) => !r.required || r.entry !== null) }, null, 2));
} else {
  console.log(`ASAR: ${ASAR}`);
  for (const r of rows) {
    const ok = r.entry !== null;
    console.log(
      `  ${ok ? '✅' : r.required ? '❌' : '➖'} ${r.spec.padEnd(38)} ${ok ? `${r.entry}（${r.source}）` : '未找到入口'}` +
        (r.dir === null ? '  [包未安装]' : ''),
    );
  }
  const missingRequired = rows.filter((r) => r.required && r.entry === null);
  console.log(`\n${missingRequired.length === 0 ? 'PROBE PASS' : 'PROBE FAIL'}（必需包缺失 ${missingRequired.length} 个）`);
  process.exit(missingRequired.length === 0 ? 0 : 1);
}
process.exit(rows.every((r) => !r.required || r.entry !== null) ? 0 : 1);
