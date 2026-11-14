/**
 * 搜索域 domain —— 首页推荐业务编排
 * 纯业务逻辑，不依赖 electron、context.getCtx()、safeSend。
 *
 * 关键：返回形状必须与旧 IPC handler 完全一致。
 *   - getHomeRecommendations 直接返回 api.getHomeRecommendations() 原样；
 *     失败返回 { netease: { tops: [], playlists: [] }, qq: { playlists: [] }, error }
 *   - getHomeSection 直接返回 api.getHomeSection(section) 原样；
 *     失败返回 { ok: false, section, data: [], error }
 */

/**
 * 获取首页推荐。
 * @param {Object} deps
 * @param {Function} deps.api.getHomeRecommendations
 * @returns {Promise<Object>} 直接返回推荐数据；失败返回兜底形状
 */
async function getHomeRecommendations({ api }) {
  try {
    return await api.getHomeRecommendations();
  } catch (e) {
    return {
      netease: { tops: [], playlists: [] },
      qq: { playlists: [] },
      error: e.message || '获取首页推荐失败',
    };
  }
}

/**
 * 获取首页分区内容。
 * @param {Object} deps
 * @param {Function} deps.api.getHomeSection
 * @param {string} deps.section - 分区名
 * @returns {Promise<Object>} 直接返回分区数据；失败返回 { ok: false, section, data: [], error }
 */
async function getHomeSection({ api, section }) {
  if (!section) {
    return { ok: false, section, data: [], error: '分区名不能为空' };
  }
  try {
    return await api.getHomeSection(section);
  } catch (e) {
    return { ok: false, section, data: [], error: e.message || '获取分区内容失败' };
  }
}

module.exports = {
  getHomeRecommendations,
  getHomeSection,
};
