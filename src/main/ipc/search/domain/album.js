/**
 * 搜索域 domain —— 专辑搜索业务编排
 * 纯业务逻辑，不依赖 electron、context.getCtx()、safeSend。
 *
 * 关键：返回形状必须与旧 IPC handler 完全一致。
 *   - searchAlbum 成功返回 { albums, total }；失败返回 { albums: [], total: 0, error }
 */

const { validateKeyword } = require('./search');

/**
 * 搜索专辑。
 * @param {Object} deps
 * @param {Function} deps.api.searchAlbum
 * @param {string} deps.keyword - 关键词
 * @param {string} [deps.source='qq'] - 平台来源
 * @param {number} [deps.page=1] - 页码
 * @returns {Promise<{albums, total, error?}>} 直接返回 { albums, total }；失败返回 { albums: [], total: 0, error }
 */
async function searchAlbum({ api, keyword, source = 'qq', page = 1 }) {
  const check = validateKeyword(keyword);
  if (!check.ok) {
    return { albums: [], total: 0 };
  }
  try {
    const result = await api.searchAlbum(check.keyword, source, page);
    return {
      albums: Array.isArray(result.albums) ? result.albums : [],
      total: result.total || 0,
    };
  } catch (e) {
    return { albums: [], total: 0, error: e.message || '搜索专辑失败' };
  }
}

module.exports = {
  searchAlbum,
};
