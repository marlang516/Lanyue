/**
 * 搜索域 domain —— 平台列表 / 源健康度业务编排
 * 纯业务逻辑，不依赖 electron、context.getCtx()、safeSend。
 *
 * 关键：返回形状必须与旧 IPC handler 完全一致。
 *   - getPlatforms 直接返回 api.registry.toClientPayload()（数组），不包装成 {platforms, error}
 *   - getSourceHealth 直接返回 api.getSourceHealthMap(...)（对象），不包装成 {healthMap, error}
 */

/**
 * 获取平台列表（供渲染层下拉）。
 * @param {Object} deps
 * @param {Function} deps.api.getPlatforms - 等价 api.registry.toClientPayload()
 * @returns {Promise<Array>} 直接返回平台清单数组；失败返回 []
 */
async function getPlatforms({ api }) {
  try {
    return await api.getPlatforms();
  } catch (_e) {
    return [];
  }
}

/**
 * 获取源健康度快照。
 * @param {Object} deps
 * @param {Function} deps.api.getSourceHealthMap
 * @param {Array<string>} [deps.sources]
 * @returns {Promise<Object>} 直接返回健康度映射对象；失败返回 {}
 */
async function getSourceHealth({ api, sources }) {
  try {
    return await api.getSourceHealthMap(sources);
  } catch (_e) {
    return {};
  }
}

/**
 * 记录探针结果。
 * @param {Object} deps
 * @param {Function} deps.api.recordProbeResult
 * @param {string} deps.source
 * @param {boolean} deps.ok
 * @returns {Promise<{ok, error}>}
 */
async function recordProbeResult({ api, source, ok }) {
  try {
    await api.recordProbeResult(source, !!ok);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message || '记录探针结果失败' };
  }
}

/**
 * 获取可探测的源列表。
 * @param {Object} deps
 * @param {Function} deps.api.getProbeSources
 * @returns {Promise<Array<string>>} 直接返回源名数组；失败返回 []
 */
async function getProbeSources({ api }) {
  try {
    const sources = await api.getProbeSources();
    return Array.isArray(sources) ? sources : [];
  } catch (_e) {
    return [];
  }
}

module.exports = {
  getPlatforms,
  getSourceHealth,
  recordProbeResult,
  getProbeSources,
};
