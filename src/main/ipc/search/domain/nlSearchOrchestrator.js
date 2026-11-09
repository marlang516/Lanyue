/**
 * 搜索域 domain —— NL 搜索业务编排
 * 纯业务逻辑，不依赖 electron、context.getCtx()、safeSend。
 *
 * 关键：返回形状必须与旧 IPC handler 完全一致。
 *   - 无 API Key 时返回 { songs: [], queries: [], error: '请先在「AI 音乐」中配置 API Key' }
 *   - 失败返回 { songs: [], queries: [], error: e.message }
 *   - 成功返回 searchByPhrase 的原始结果（{ songs, queries, ... }）
 */

const { validateKeyword } = require('./search');

/**
 * 执行自然语言搜索业务流程。
 * @param {Object} deps
 * @param {Object} deps.api - { searchMusic }
 * @param {Object} deps.ai - { rewriteSearchQueries, searchByPhrase, chatConfigFrom }
 * @param {Object} deps.prefs - { get }
 * @param {string} deps.phrase - 用户自然语言需求
 * @param {string} [deps.source='all'] - 平台来源
 * @param {number} [deps.page=1] - 页码
 * @param {Object} [deps.opts] - 透传选项（loggedIn 等）
 * @returns {Promise<{songs, queries, error, truncated, failedQueries}>}
 */
async function nlSearch({ api, ai, prefs, phrase, source = 'all', page = 1, opts }) {
  const check = validateKeyword(phrase);
  if (!check.ok) {
    return { songs: [], queries: [], error: check.error };
  }

  // 1. 读取 API Key（与旧 handler 同一权威来源：chatConfigFrom(prefs.get)）
  let apiKey;
  try {
    const cfg = ai.chatConfigFrom((k) => prefs.get(k));
    apiKey = cfg && cfg.apiKey;
  } catch (_) {
    apiKey = null;
  }
  if (!apiKey) {
    return { songs: [], queries: [], error: '请先在「AI 音乐」中配置 API Key' };
  }

  // 2. LLM 改写（失败/为空时退回原句，由 searchByPhrase 内部兜底）
  let queries = [];
  try {
    queries = await ai.rewriteSearchQueries({ phrase: check.phrase, apiKey });
  } catch (_) {
    queries = [];
  }

  // 3. 并行扇出聚合搜索
  try {
    const result = await ai.searchByPhrase({
      phrase: check.phrase,
      rewrite: async () => queries,
      searchAll: (q) => api.searchMusic(q, source, page, opts),
      limit: 60,
    });
    return {
      songs: result.songs || [],
      queries: result.queries || [],
      error: result.error || null,
      truncated: result.truncated,
      failedQueries: result.failedQueries,
    };
  } catch (e) {
    return { songs: [], queries: [], error: e.message };
  }
}

module.exports = {
  nlSearch,
};
