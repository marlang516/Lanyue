/**
 * 搜索域 domain —— 歌单/专辑曲目业务编排
 * 纯业务逻辑，不依赖 electron、context.getCtx()、safeSend。
 *
 * 关键：返回形状必须与旧 IPC handler 完全一致。
 *   - getPlaylistSongs 成功返回 api.getPlaylistSongs(...) 原样（数组）；失败返回 []
 *   - getAlbumSongs 成功返回 api.getAlbumSongs(...) 原样（数组）；失败返回 []
 */

const { validateKeyword } = require('./search');

/**
 * 获取歌单曲目。
 * @param {Object} deps
 * @param {Function} deps.api.getPlaylistSongs
 * @param {string} deps.platform - 平台 id
 * @param {string} deps.id - 歌单 id
 * @param {number} [deps.limit] - 条数上限
 * @returns {Promise<Array>} 直接返回歌曲数组；失败返回 []
 */
async function getPlaylistSongs({ api, platform, id, limit }) {
  if (!platform || !id) {
    return [];
  }
  try {
    const songs = await api.getPlaylistSongs(platform, id, limit);
    return Array.isArray(songs) ? songs : [];
  } catch (_e) {
    return [];
  }
}

/**
 * 获取专辑曲目。
 * @param {Object} deps
 * @param {Function} deps.api.getAlbumSongs
 * @param {string} deps.platform - 平台 id
 * @param {string} deps.albumMid - 专辑 id
 * @param {number} [deps.limit] - 条数上限
 * @returns {Promise<Array>} 直接返回歌曲数组；失败返回 []
 */
async function getAlbumSongs({ api, platform, albumMid, limit }) {
  if (!platform || !albumMid) {
    return [];
  }
  try {
    const songs = await api.getAlbumSongs(platform, albumMid, limit);
    return Array.isArray(songs) ? songs : [];
  } catch (_e) {
    return [];
  }
}

module.exports = {
  getPlaylistSongs,
  getAlbumSongs,
};
