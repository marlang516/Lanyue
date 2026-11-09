/**
 * 搜索域 domain —— 搜索参数校验与结果包装
 * 纯业务逻辑，不依赖 electron、context.getCtx()、safeSend。
 */

const MAX_KEYWORD_LEN = 200;

/**
 * 校验搜索关键词，返回 { ok, keyword } 或 { ok: false, error }。
 * @param {string} keyword
 * @returns {{ok:true, keyword:string}|{ok:false, error:string}}
 */
function validateKeyword(keyword) {
  if (typeof keyword !== 'string' || !keyword.trim()) {
    return { ok: false, error: '搜索关键词不能为空' };
  }
  const k = keyword.trim();
  if (k.length > MAX_KEYWORD_LEN) {
    return { ok: false, error: '搜索关键词过长' };
  }
  return { ok: true, keyword: k };
}

/**
 * 包装搜索结果，统一返回形状。
 * @param {Object} result - api.searchMusic 的返回
 * @returns {{songs:Array, source:string, error:string|null, stats?:Object, failed?:Array}}
 */
function wrapSearchResult(result) {
  return {
    songs: Array.isArray(result.songs) ? result.songs : [],
    source: result.source || 'all',
    error: result.error || null,
    stats: result.stats,
    failed: result.failed,
  };
}

module.exports = {
  MAX_KEYWORD_LEN,
  validateKeyword,
  wrapSearchResult,
};
