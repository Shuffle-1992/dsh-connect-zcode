/**
 * switch.js —— ZCode 派发总开关检查（PROTOCOL §7.1，只读）。
 *
 * 语义与宿主仓库 scripts/collab/zcode-switch.mjs 的 readDispatchSwitch 完全一致：
 *   缺文件 = 开启（保持历史行为）；读取失败 = 开启（不因开关文件损坏而误锁）；
 *   `enabled !== false` = 开启。
 * 独立实现（约 30 行，零跨仓库 import），避免宿主仓库路径耦合——T20 §3.2 的建议选项。
 * `enabled:false` = 既不派发、也不经 provider 通道烧套餐：provider 接入件在
 * resolveApiKey / 每次实际调用之前检查，关闭时抛 SwitchFrozenError（可操作文案）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 默认真值文件（可移植）：
 *   1. env `ZCODE_CONNECT_SWITCH_PATH`（最高优先，便于多机/多仓库部署）
 *   2. `~/.dsh/zcode-dispatch.switch.json`（本插件的通用默认位置）
 *   3. 亦可在插件 config 里用 `switchPath` 覆盖（见 index.js）
 * 缺文件 = 开启，因此未部署开关的场景无需任何配置。
 */
export const DEFAULT_SWITCH_PATH =
  process.env.ZCODE_CONNECT_SWITCH_PATH || join(homedir(), '.dsh', 'zcode-dispatch.switch.json');

/** 套餐冻结错误（PROTOCOL §7.1 规定文案）。 */
export class SwitchFrozenError extends Error {
  constructor() {
    super('派发总开关已关闭：套餐冻结中（含 provider 通道）');
    this.name = 'SwitchFrozenError';
  }
}

/**
 * 读开关状态（永不抛）。
 * @param {string} [file] 开关文件路径。
 * @returns {{ enabled: boolean, source: string, path: string, updatedAt?: string, updatedBy?: string, note?: string }}
 */
export function readDispatchSwitch(file = DEFAULT_SWITCH_PATH) {
  try {
    if (!existsSync(file)) return { enabled: true, source: 'default(无文件=开启)', path: file };
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return {
      enabled: raw.enabled !== false,
      path: file,
      updatedAt: raw.updatedAt,
      updatedBy: raw.updatedBy,
      note: raw.note,
      source: 'file',
    };
  } catch (err) {
    return { enabled: true, source: `default(读取失败: ${err?.message ?? err})`, path: file };
  }
}

/**
 * 断言开关开启（provider 通道调用门禁）。
 * @param {string} [file] 开关文件路径。
 * @throws {SwitchFrozenError} 开关关闭时。
 */
export function assertSwitchEnabled(file = DEFAULT_SWITCH_PATH) {
  const state = readDispatchSwitch(file);
  if (!state.enabled) throw new SwitchFrozenError();
  return state;
}
