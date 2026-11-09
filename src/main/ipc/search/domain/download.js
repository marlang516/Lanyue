/**
 * 搜索域 domain —— 下载 URL / 源探测业务编排
 * 纯业务逻辑，不依赖 electron、context.getCtx()、safeSend。
 */

/**
 * 获取歌曲下载 URL。
 * @param {Object} deps
 * @param {Function} deps.api.getDownloadUrl
 * @param {string} deps.id - 歌曲 id
 * @param {string} deps.source - 平台来源
 * @param {string} [deps.quality] - 音质
 * @returns {Promise<{url, ext, error}>}
 */
async function getDownloadUrl({ api, id, source, quality }) {
  if (!id || !source) {
    return { url: null, ext: null, error: '歌曲 id 和平台不能为空' };
  }
  try {
    const result = await api.getDownloadUrl(id, source, quality);
    return { url: result.url || null, ext: result.ext || null, error: null };
  } catch (e) {
    return { url: null, ext: null, error: e.message || '获取下载 URL 失败' };
  }
}

/**
 * 主动探测各源可用性：各源搜一首公共曲并尝试取流。
 * 搜索通=源可达；取流通=源健康。结果记入 sourceHealth 滑动窗口。
 * 返回形状与旧 IPC handler 完全一致：{ probes, health }。
 *
 * @param {Object} deps
 * @param {Object} deps.api - { getProbeSources, searchMusic, getDownloadUrl, recordProbeResult, getSourceHealthMap }
 * @param {Object} [deps.logger]
 * @returns {Promise<{probes:Array, health:Object}>}
 */
async function probeSources({ api, logger }) {
  const PROBE_SOURCES = api.getProbeSources ? api.getProbeSources() : [];
  const KEYWORD = '周杰伦 晴天';
  const withTimeout = (p) =>
    Promise.race([
      p,
      new Promise((r) => setTimeout(() => r({ error: 'timeout' }), 8000)),
    ]);
  const probes = [];
  for (const src of PROBE_SOURCES) {
    let ok = false;
    let stage = 'search';
    let error = null;
    try {
      const r = await withTimeout(api.searchMusic(KEYWORD, src, 1));
      const songs = (r && r.songs) || [];
      if (songs.length > 0) {
        stage = 'getUrl';
        const u = await withTimeout(api.getDownloadUrl(songs[0].id, src, 'standard'));
        ok = !!(u && u.url);
        if (!ok) error = (u && (u.error || u.code)) || 'no-url';
      } else {
        error = (r && r.error) || 'empty-result';
      }
    } catch (e) {
      error = e.message || 'probe-error';
    }
    try {
      api.recordProbeResult(src, ok);
    } catch (_e) {
      // 记录失败不影响探测结果
    }
    probes.push({ source: src, ok, stage, error, latency: null });
  }
  let health = {};
  try {
    health = api.getSourceHealthMap(PROBE_SOURCES);
  } catch (_e) {
    health = {};
  }
  return { probes, health };
}

module.exports = {
  getDownloadUrl,
  probeSources,
};
