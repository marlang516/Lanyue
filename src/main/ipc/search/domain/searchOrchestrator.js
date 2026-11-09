/**
 * 搜索域 domain —— 搜索业务编排
 * 纯业务逻辑，不依赖 electron、context.getCtx()、safeSend。
 *
 * 关键：返回形状必须与旧 IPC handler 完全一致。
 *   - 成功直接返回 api.searchMusic(...) 原样
 *   - 失败返回 { error: e.message, songs: [] }
 */

const { validateKeyword } = require('./search');

/**
 * 执行搜索业务流程。
 * @param {Object} deps
 * @param {Function} deps.api.searchMusic - 调用 api.searchMusic
 * @param {string} deps.keyword - 用户输入的关键词
 * @param {string} [deps.source='all'] - 平台来源
 * @param {number} [deps.page=1] - 页码
 * @param {Object} [deps.opts] - 透传选项（loggedIn 等）
 * @returns {Promise<Object>} 直接返回 api.searchMusic 的原始结果；失败返回 { error, songs: [] }
 */
async function searchMusic({ api, keyword, source = 'all', page = 1, opts }) {
  const check = validateKeyword(keyword);
  if (!check.ok) {
    return { error: check.error, songs: [] };
  }
  try {
    return await api.searchMusic(check.keyword, source, page, opts);
  } catch (e) {
    return { error: e.message, songs: [] };
  }
}

module.exports = {
  searchMusic,
};
