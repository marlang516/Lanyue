/**
 * 换源记忆的渲染层入口：写入后，若这首歌已经在播放队列里，立刻通知保存。
 * 判据在 shared/altSource.js，这里只接 state。
 */

import { getState, notify } from './state.js';
import { applyAltSourceToQueue, clearAltSourceInQueue } from '../../shared/altSource.js';

export function rememberAltSource(song, matched) {
  if (applyAltSourceToQueue(getState('playQueue'), song, matched)) notify('playQueue');
}

export function forgetAltSource(song) {
  if (clearAltSourceInQueue(getState('playQueue'), song)) notify('playQueue');
}
