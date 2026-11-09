/**
 * 搜索域 domain —— 歌手业务编排
 * 纯业务逻辑，不依赖 electron、context.getCtx()、safeSend。
 *
 * 关键：返回形状必须与旧 IPC handler 完全一致。
 *   - searchSinger 成功返回 api.searchSinger(...) 原样；失败返回 { singers: [], total: 0 }
 *   - getSingerSongs 成功返回 api.getSingerSongs(...) 原样；失败返回 []
 *   - getSingerAlbums 成功返回 api.getSingerAlbums(...) 原样；失败返回 { albums: [], total: 0 }
 */

const { validateKeyword } = require('./search');

/**
 * 搜索歌手。
 * @param {Object} deps
 * @param {Function} deps.api.searchSinger
 * @param {string} deps.keyword - 关键词
 * @param {string} [deps.source='all'] - 平台来源
 * @param {number} [deps.page=1] - 页码
 * @returns {Promise<Object>} 直接返回搜索结果；失败返回 { singers: [], total: 0 }
 */
async function searchSinger({ api, keyword, source = 'all', page = 1 }) {
  const check = validateKeyword(keyword);
  if (!check.ok) {
    return { singers: [], total: 0 };
  }
  try {
    return await api.searchSinger(check.keyword, source, page);
  } catch (_e) {
    return { singers: [], total: 0 };
  }
}

/**
 * 获取歌手歌曲。
 * @param {Object} deps
 * @param {Function} deps.api.getSingerSongs
 * @param {string} deps.singerMid - 歌手 id
 * @param {number} [deps.limit] - 条数上限
 * @returns {Promise<Array>} 直接返回歌曲数组；失败返回 []
 */
async function getSingerSongs({ api, singerMid, limit }) {
  if (!singerMid) {
    return [];
  }
  try {
    const songs = await api.getSingerSongs(singerMid, limit);
    return Array.isArray(songs) ? songs : [];
  } catch (_e) {
    return [];
  }
}

/**
 * 获取歌手专辑。
 * @param {Object} deps
 * @param {Function} deps.api.getSingerAlbums
 * @param {string} deps.singerMid - 歌手 id
 * @param {string} [deps.source] - 平台来源
 * @param {number} [deps.pageNo=1] - 页码
 * @param {number} [deps.pageSize] - 每页条数
 * @returns {Promise<Object>} 直接返回专辑列表；失败返回 { albums: [], total: 0 }
 */
async function getSingerAlbums({ api, singerMid, source, pageNo = 1, pageSize }) {
  if (!singerMid) {
    return { albums: [], total: 0 };
  }
  try {
    return await api.getSingerAlbums(singerMid, source, pageNo, pageSize);
  } catch (_e) {
    return { albums: [], total: 0 };
  }
}

module.exports = {
  searchSinger,
  getSingerSongs,
  getSingerAlbums,
};
