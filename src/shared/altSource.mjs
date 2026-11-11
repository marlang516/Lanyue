/**
 * 换源记忆的写入与「要不要立刻保存播放队列」。
 *
 * 播放队列只在 setState('playQueue' | 'playIdx' | …) 时落盘。原地改
 * song._altSource 不会通知订阅者，退出前若没有下一次队列变更，记忆就丢了。
 * 这里回答两件事：写成什么样，以及队列里是否已经有这首歌（有才需要 flush）。
 *
 * 用 .mjs 的理由与 playReferer.mjs 相同：渲染层 Vite 要具名导出，
 * 主进程与单测用 require() 加载，.js 里的 export 在本仓库会被当成 CJS。
 */

function validAlt(matched) {
  return !!(matched && matched.source && matched.id != null);
}

/**
 * @param {Object} song
 * @param {{source?: string, id?: string|number}} matched
 * @returns {boolean} 是否写上了
 */
function assignAltSource(song, matched) {
  if (!song || typeof song !== 'object' || !validAlt(matched)) return false;
  song._altSource = { source: String(matched.source), id: String(matched.id) };
  return true;
}

function sameTrack(a, b) {
  return !!(a && b && a.source === b.source && String(a.id) === String(b.id));
}

/**
 * 写到 song 上。若队列里是同一对象，或另一份 id+source 相同的对象，返回 true
 * 表示调用方应立刻 notify('playQueue')。歌还不在队列里时只改 song，返回 false
 * （随后的 setState('playQueue') 会带上这份记忆）。
 *
 * @returns {boolean}
 */
function applyAltSourceToQueue(queue, song, matched) {
  if (!assignAltSource(song, matched)) return false;
  if (!Array.isArray(queue)) return false;
  if (queue.includes(song)) return true;
  const twin = queue.find((row) => row && row !== song && sameTrack(row, song));
  if (!twin) return false;
  assignAltSource(twin, matched);
  return true;
}

/**
 * 清掉记忆。队列里有这首歌（或它的另一份对象）时返回 true，调用方应 flush。
 * @returns {boolean}
 */
function clearAltSourceInQueue(queue, song) {
  if (!song || typeof song !== 'object' || !song._altSource) return false;
  delete song._altSource;
  if (!Array.isArray(queue)) return false;
  if (queue.includes(song)) return true;
  const twin = queue.find((row) => row && row !== song && sameTrack(row, song));
  if (!twin || !twin._altSource) return false;
  delete twin._altSource;
  return true;
}

/**
 * 会话快照只留 source 与 id。没有合法记忆时返回 undefined，JSON 会丢掉这个键。
 * @returns {{source: string, id: string}|undefined}
 */
function slimAltSource(song) {
  const alt = song && song._altSource;
  if (!validAlt(alt)) return undefined;
  return { source: String(alt.source), id: String(alt.id) };
}

export {
  assignAltSource,
  applyAltSourceToQueue,
  clearAltSourceInQueue,
  slimAltSource,
};
