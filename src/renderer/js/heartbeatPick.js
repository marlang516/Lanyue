/**
 * 心动模式 —— 纯过滤逻辑（零 import，可在 node:test 里直接跑）
 *
 * 与接线层（heartbeat.js）分开，是为了让「哪些歌能进队列」这条判据只有一份：
 * 主进程返回的候选可能和现有队列重叠、可能缺 id/source，过滤规则不能被
 * 网络代码或 DOM 代码顺手改写。
 */

/** 队列/候选的统一键：source:id。缺任一项返回空串（不可播放，直接丢） */
export function heartbeatSongKey(song) {
  if (!song || song.id === null || song.id === undefined) return '';
  if (song.source === null || song.source === undefined || song.source === '') return '';
  return `${song.source}:${song.id}`;
}

/** 只把播放链路需要的最小字段送过 IPC（契约只声明这些字段，多送会被拒） */
export function slimHeartbeatSong(song) {
  if (!song || typeof song !== 'object') return null;
  const out = {
    id: song.id,
    title: song.title === undefined ? undefined : String(song.title),
    artist: song.artist === undefined ? undefined : String(song.artist),
    album: song.album === undefined ? undefined : String(song.album),
    source: song.source === undefined ? undefined : String(song.source),
  };
  return heartbeatSongKey(out) ? out : null;
}

/**
 * 从候选里挑出「队列里还没有的」歌（保持候选顺序）。
 * @param {Array} existing 当前队列
 * @param {Array} incoming 主进程返回的候选
 * @param {number} limit
 * @returns {Array}
 */
export function pickHeartbeatSongs(existing, incoming, limit = 30) {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 30;
  const seen = new Set();
  for (const s of Array.isArray(existing) ? existing : []) {
    const k = heartbeatSongKey(s);
    if (k) seen.add(k);
  }
  const out = [];
  for (const s of Array.isArray(incoming) ? incoming : []) {
    const k = heartbeatSongKey(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}
