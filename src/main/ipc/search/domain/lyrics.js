/**
 * 搜索域 domain —— 歌词业务编排
 * 纯业务逻辑，不依赖 electron、context.getCtx()、safeSend。
 */

/**
 * 执行获取歌词业务流程。
 * @param {Object} deps
 * @param {Function} deps.api.getLyrics - 调用 api.getLyrics
 * @param {string} deps.id - 歌曲 id
 * @param {string} deps.source - 平台来源
 * @param {string} [deps.title] - 歌名（兜底搜索用）
 * @param {string} [deps.artist] - 歌手（兜底搜索用）
 * @returns {Promise<{lrc, error}>}
 */
async function getLyrics({ api, id, source, title, artist }) {
  if (!id) {
    return { lrc: '', error: '歌曲 id 不能为空' };
  }

  const result = await api.getLyrics(id, source, title, artist);
  return { lrc: result.lrc || '', error: null };
}

module.exports = {
  getLyrics,
};
