/**
 * 心动模式（渲染层接线）
 *
 * 职责只有一件：播放队列「自然播完」时，向主进程要一批相似歌追加到队尾。
 *  - 只追加、不替换；开关默认关闭（设置 → 播放 → 心动模式）
 *  - 生成失败 / 没有开关 / 没有新歌 → 返回 0，调用方维持原来的「播完即停」
 *  - 追加前按 source:id 去重，避免同一首在队列里出现两次
 *  - 60s 冷却：手动连续触发（例如切歌到底）不会反复打网关
 *
 * 过滤/瘦身判据在 heartbeatPick.js（纯函数，单测直接跑）；
 * 本文件只做「读开关 → 调 IPC → 追加 → 提示」这条副作用链。
 */

import { getState, setState } from './state.js';
import { showToast } from './toast.js';
import { t } from './i18n.js';
import { logger } from './logger.js';
import { slimHeartbeatSong, pickHeartbeatSongs } from './heartbeatPick.js';

const REFILL_LIMIT = 30;
const REFILL_COOLDOWN_MS = 60_000;

let _busy = false;
let _lastRefillAt = 0;

/** 开关读取失败按「关」处理：心动模式是可选增强，不能靠猜 */
export async function isHeartbeatEnabled() {
  try {
    const api = window.api;
    if (!api || typeof api.getPref !== 'function') return false;
    return (await api.getPref('heartbeatEnabled')) === true;
  } catch (_e) {
    return false;
  }
}

/**
 * 队列播完时调用：满足条件就追加一批歌并返回实际追加数量。
 * @returns {Promise<number>} 0 = 没追加，调用方照常停止
 */
export async function refillPlayQueue() {
  if (_busy) return 0;
  if (Date.now() - _lastRefillAt < REFILL_COOLDOWN_MS) return 0;

  const api = window.api;
  if (!api || typeof api.generateHeartbeat !== 'function') return 0;

  _busy = true;
  try {
    if (!(await isHeartbeatEnabled())) return 0;

    const queue = Array.isArray(getState('playQueue')) ? getState('playQueue') : [];
    const idx = Number(getState('playIdx'));
    const current = getState('currentPlaying') || queue[idx] || null;

    const exclude = queue
      .slice(-500)
      .map(slimHeartbeatSong)
      .filter(Boolean);

    const r = await api.generateHeartbeat({
      currentSong: slimHeartbeatSong(current),
      exclude,
      limit: REFILL_LIMIT,
    });
    if (!r || r.ok !== true || !Array.isArray(r.songs) || !r.songs.length) {
      _lastRefillAt = Date.now();
      return 0;
    }

    const fresh = pickHeartbeatSongs(getState('playQueue') || [], r.songs, REFILL_LIMIT);
    if (!fresh.length) {
      _lastRefillAt = Date.now();
      return 0;
    }

    // 只追加：订阅链会负责重渲染、持久化与徽标刷新
    setState('playQueue', (getState('playQueue') || []).concat(fresh));
    _lastRefillAt = Date.now();
    showToast(t('heartbeat.added', { n: fresh.length }), 'info', 3000);
    return fresh.length;
  } catch (e) {
    logger.warn('[heartbeat] 追加失败:', e && e.message ? e.message : e);
    _lastRefillAt = Date.now();
    return 0;
  } finally {
    _busy = false;
  }
}

/** 测试/设置页切换时用于清冷却 */
export function _resetHeartbeatState() {
  _busy = false;
  _lastRefillAt = 0;
}

window.refillPlayQueue = refillPlayQueue;
