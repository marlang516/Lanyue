/**
 * 歌单域 —— 纯业务逻辑层（domain）
 *
 * 设计约束：零外部依赖。不 require electron、不 require prefs、
 * 不 require cookieStore、不 require api。所有函数接收数据数组并返回新数组 + 结果，不做 I/O。
 *
 * 由 IPC 层（src/main/ipc/playlist.js）组装使用，由 infra 层
 * 提供 prefs/api/cookie/trash 等外部能力。
 */

const { FAVORITES_ID, FAVORITES_NAME, TRASH_KEY } = require('./constants');

// ── 常量 ─────────────────────────────────────────────────────
// (FAVORITES_ID / FAVORITES_NAME / TRASH_KEY 已在 constants.js 定义)

/** 歌曲在歌单内的唯一键：只按 id 会跨平台撞车（网易云与 QQ 常有相同数字 id） */
function songKey(s) {
  return String(s && s.id) + ':' + String((s && s.source) || '');
}

/** 确保收藏歌单存在，返回最新的歌单数组（纯函数，不写 prefs） */
function ensureFavorites(playlists) {
  const list = Array.isArray(playlists) ? playlists.slice() : [];
  if (!list.some(p => p && p.id === FAVORITES_ID)) {
    const now = Date.now();
    list.unshift({
      id: FAVORITES_ID,
      name: FAVORITES_NAME,
      desc: '红心收藏的歌曲',
      songs: [],
      system: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  return list;
}

/**
 * 返回歌单列表；opts.trash 时返回 null 信号（IPC 层自行走 trashView）。
 * @param {Array} playlists
 * @param {Object} [opts]
 * @returns {Array|null}
 */
function listPlaylists(playlists, opts) {
  if (opts && opts.trash) return null;
  return Array.isArray(playlists) ? playlists : [];
}

/**
 * 新建或更新歌单。
 * @param {Array} playlists
 * @param {Object} playlist
 * @returns {{success, playlist?, playlists, error?}}
 */
function savePlaylist(playlists, playlist) {
  if (!playlist || !playlist.name) return { success: false, error: '歌单名称不能为空', playlists };
  const list = Array.isArray(playlists) ? playlists.slice() : [];
  const now = Date.now();

  if (playlist.id) {
    const idx = list.findIndex(p => p && p.id === playlist.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...playlist, updatedAt: now };
      return { success: true, playlist: list[idx], playlists: list };
    }
    // 带 id 却不在列表：返回 notFound 信号，由 IPC 层走 trashRestore
    return { success: false, notFound: true, playlist, playlists: list };
  }

  // 新建歌单
  const newPlaylist = {
    id: 'pl_' + now + '_' + Math.random().toString(36).slice(2, 8),
    name: playlist.name,
    desc: playlist.desc || '',
    cover: playlist.cover || '',
    songs: playlist.songs || [],
    createdAt: now,
    updatedAt: now,
  };
  list.unshift(newPlaylist);
  return { success: true, playlist: newPlaylist, playlists: list };
}

/**
 * 硬删/移回收站/彻底删除。
 * @param {Array} playlists
 * @param {Array} trash
 * @param {string} playlistId
 * @param {number} now
 * @returns {{success, playlists, trash, purged?, error?}}
 */
function deletePlaylist(playlists, trash, playlistId, now) {
  if (!playlistId) return { success: false, error: '缺少歌单ID', playlists, trash };
  const list = Array.isArray(playlists) ? playlists.slice() : [];
  const tr = Array.isArray(trash) ? trash.slice() : [];
  const pl = list.find(p => p && p.id === playlistId);
  if (pl && pl.system) return { success: false, error: '收藏歌单不能删除', playlists: list, trash: tr };
  // 列表里没有、回收站里倒是有 ⇒ 彻底删除（由 IPC 层调 trashPurge）
  if (!pl) {
    return { success: false, notInList: true, playlists: list, trash: tr };
  }
  // 移回收站：返回 removed 信号，IPC 层调 trashRemove
  return { success: true, moveToTrash: true, playlists: list, trash: tr };
}

/**
 * 添加歌曲到歌单。
 * @param {Array} playlists
 * @param {string} playlistId
 * @param {Object} song
 * @returns {{success, playlist?, playlists, skipped?, error?}}
 */
function addToPlaylist(playlists, playlistId, song) {
  if (!playlistId || !song) return { success: false, error: '参数不完整', playlists };
  const list = Array.isArray(playlists) ? playlists.slice() : [];
  const idx = list.findIndex(p => p && p.id === playlistId);
  if (idx < 0) return { success: false, error: '歌单不存在', playlists: list };

  const pl = { ...list[idx] };
  const exists = Array.isArray(pl.songs) && pl.songs.some(s => s && s.source === song.source && s.id === song.id);
  if (exists) return { success: true, skipped: true, playlist: pl, playlists: list };

  const now = Date.now();
  pl.songs = (pl.songs || []).concat({ ...song, addedAt: now });
  pl.updatedAt = now;
  list[idx] = pl;
  return { success: true, playlist: pl, playlists: list };
}

/**
 * 从歌单移除歌曲。
 * @param {Array} playlists
 * @param {string} playlistId
 * @param {*} songId
 * @param {*} source
 * @returns {{success, playlist?, playlists, error?}}
 */
function removeFromPlaylist(playlists, playlistId, songId, source) {
  if (!playlistId || !songId) return { success: false, error: '参数不完整', playlists };
  const list = Array.isArray(playlists) ? playlists.slice() : [];
  const pl = list.find(p => p && p.id === playlistId);
  if (!pl) return { success: false, error: '歌单不存在', playlists: list };

  const wantId = String(songId);
  const wantSrc = source == null || source === '' ? null : String(source);
  const now = Date.now();
  const nextPl = { ...pl };
  nextPl.songs = (pl.songs || []).filter(s => !(
    String(s && s.id) === wantId &&
    (wantSrc === null || String((s && s.source) || '') === wantSrc)
  ));
  nextPl.updatedAt = now;
  const idx = list.findIndex(p => p && p.id === playlistId);
  list[idx] = nextPl;
  return { success: true, playlist: nextPl, playlists: list };
}

/**
 * 红心切换。
 * @param {Array} playlists
 * @param {string} source
 * @param {*} songId
 * @param {Object} song
 * @returns {{success, favorited?, playlist?, playlists, error?}}
 */
function toggleFavorite(playlists, source, songId, song) {
  if (!songId || !song || typeof song !== 'object') {
    return { success: false, error: '参数不完整', playlists };
  }
  const list = ensureFavorites(Array.isArray(playlists) ? playlists : []);
  const pl = list.find(p => p && p.id === FAVORITES_ID);
  if (!pl) return { success: false, error: '收藏歌单不存在', playlists: list };

  const wantKey = String(songId) + ':' + String(source || '');
  const idx = (pl.songs || []).findIndex(s => songKey(s) === wantKey);
  const now = Date.now();
  const nextPl = { ...pl };
  if (idx >= 0) {
    nextPl.songs = pl.songs.slice();
    nextPl.songs.splice(idx, 1);
  } else {
    nextPl.songs = (pl.songs || []).concat({ ...song, source, id: songId, addedAt: now });
  }
  nextPl.updatedAt = now;
  const plIdx = list.findIndex(p => p && p.id === FAVORITES_ID);
  list[plIdx] = nextPl;
  return { success: true, favorited: idx < 0, playlist: nextPl, playlists: list };
}

module.exports = {
  FAVORITES_ID,
  FAVORITES_NAME,
  TRASH_KEY,
  songKey,
  ensureFavorites,
  listPlaylists,
  savePlaylist,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  toggleFavorite,
};
// 重新导出 constants 以保持兼容
module.exports.FAVORITES_ID = FAVORITES_ID;
module.exports.FAVORITES_NAME = FAVORITES_NAME;
module.exports.TRASH_KEY = TRASH_KEY;
