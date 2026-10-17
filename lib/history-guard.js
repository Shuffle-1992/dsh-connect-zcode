/**
 * history-guard.js —— app-server 会话「历史是否被改写」的判据（ZB-43）。
 *
 * **为什么需要它**：旧判据是"把**整数组**消息 hash 存起来，下轮不等就重建"。但 DSH 每轮交给
 * 适配器的 `messages` 是**全量派生历史**（正常对话第 2 轮必然是第 1 轮的超集）⇒ 整数组指纹
 * 必然不等 ⇒ **第 2 轮起每轮都被判成"历史改写"，于是每轮重建 app-server 会话 + 首轮全量
 * 重放**（多 4 个 RPC、多次固定 sleep、整段 token 重发、agent 侧会话堆积）。README 里
 * "续轮只发当轮真实用户消息"的设计因此形同虚设。
 *
 * **正确判据**：只看**前缀**是否被改写 ——
 *   - 纯增长（`next.slice(0, prev.len)` 的 hash 不变）⇒ 会话复用，续轮只发最新用户消息；
 *   - 前缀被改写或整体变短（`/compact` 压缩、编辑/回退历史、恢复草稿）⇒ 重建并按首轮重放。
 *
 * 本模块**纯函数、零依赖 Cordis**，可直接离线断言（旧判据长期未被发现，正是因为
 * e2e 测试一律预置 `sentFingerprint: undefined`，从未跑过"自然两轮"）。
 */
import { createHash } from 'node:crypto';

/** 对消息数组做稳定 hash（JSON 序列化后 sha256）。 */
export function hashMessages(messages) {
  return createHash('sha256').update(JSON.stringify(Array.isArray(messages) ? messages : [])).digest('hex');
}

/**
 * 生成"发出去时的历史快照"——重建判据与诊断都用它。
 * @param {readonly object[]} messages
 * @returns {{ len: number, hash: string }}
 */
export function makeHistorySnapshot(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return { len: list.length, hash: hashMessages(list) };
}

/**
 * 下轮消息相对上次快照是否只是**纯追加**（= 历史没被改写，会话可复用）。
 * @param {{ len: number, hash: string } | undefined} previous 上次发出时的快照
 * @param {readonly object[]} nextMessages 本轮收到的全量消息
 * @returns {boolean} true = 纯增长（不重建）；false = 改写/变短/无快照
 */
export function isPureAppend(previous, nextMessages) {
  if (previous === undefined || previous === null) return false;
  if (!Number.isInteger(previous.len) || previous.len < 0) return false;
  const list = Array.isArray(nextMessages) ? nextMessages : [];
  if (list.length < previous.len) return false; // 变短 ⇒ 被压缩或回退
  return hashMessages(list.slice(0, previous.len)) === previous.hash;
}
