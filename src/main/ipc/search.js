/**
 * 搜索 / 歌词 / 推荐 IPC —— 三层架构接线层
 *
 * 注册：search-music / nl-search-music / get-lyrics / get-home-recommendations /
 *       get-home-section / get-playlist-songs / search-singer / get-singer-songs /
 *       get-singer-albums / get-album-songs / search-album / get-song-by-link /
 *       get-platforms / get-source-health / probe-sources
 *
 * 参数形状校验（keyword 截断、page/limit 钳制）已上移至 IPC 契约
 * （src/shared/ipcContract.js，经 ./register 的 handle 统一执行），
 * handler 只接收规范化后的位置参数。
 *
 * 所有业务逻辑委托给 domain/*，所有外部依赖经 infra/* 注入。
 * 本模块不直接 require electron / api / prefs / cookieStore / ai 等全局模块。
 */

const { handle } = require('./register');

/**
 * @param {Object} deps
 * @param {Object} deps.domain - 搜索域业务函数集合（来自 domain/index.js）
 * @param {Object} deps.infra  - 搜索域基础设施适配器（来自 infra/createInfra()）
 */
function register(deps = {}) {
  const { domain, infra } = deps;

  // 注册期 fail-fast：缺失必填依赖立即抛错，避免拖到首个 IPC 调用才暴露
  if (!domain || typeof domain !== 'object') {
    throw new Error('[ipc/search] 必须注入 domain');
  }
  if (!infra || typeof infra !== 'object') {
    throw new Error('[ipc/search] 必须注入 infra');
  }
  const requiredDomain = [
    'searchMusic',
    'nlSearch',
    'getLyrics',
    'getHomeRecommendations',
    'getHomeSection',
    'getPlaylistSongs',
    'searchSinger',
    'getSingerSongs',
    'getSingerAlbums',
    'getAlbumSongs',
    'searchAlbum',
    'getSongByLink',
    'getPlatforms',
    'getSourceHealth',
    'probeSources',
  ];
  for (const name of requiredDomain) {
    if (typeof domain[name] !== 'function') {
      throw new Error(`[ipc/search] domain.${name} 必须是函数`);
    }
  }
  if (!infra.api || !infra.cookie || !infra.prefs || !infra.ai || !infra.logger) {
    throw new Error('[ipc/search] infra 必须包含 api/cookie/prefs/ai/logger');
  }

  const { api, cookie, prefs, ai, logger } = infra;

  // ── 搜索 ──────────────────────────────────────────────
  handle('search-music', async (_, keyword, source, page) => {
    try {
      return await domain.searchMusic({
        api,
        keyword,
        source,
        page,
        opts: { loggedIn: cookie.getLoggedInSources() },
      });
    } catch (e) {
      return { error: e.message, songs: [] };
    }
  });

  // 自然语言搜索（P0-A）：LLM 把口语需求改写成 1~3 个关键词，
  // 并行扇出走 'all' 聚合搜索再合并去重。改写失败退回原句，功能不回归。
  handle('nl-search-music', async (_, phrase) => {
    try {
      return await domain.nlSearch({
        api,
        ai,
        prefs,
        phrase,
        source: 'all',
        page: 1,
        opts: { loggedIn: cookie.getLoggedInSources() },
      });
    } catch (e) {
      logger.warn('AI 搜索失败:', e.message || e);
      return { songs: [], queries: [], error: e.message };
    }
  });

  // ── 歌词 ──────────────────────────────────────────────
  handle('get-lyrics', async (_, id, source, title, artist) => {
    try {
      return await api.getLyrics(id, source, title, artist);
    } catch (e) {
      logger.warn('获取歌词失败:', e.message || e);
      return { lrc: '', error: e.message || e };
    }
  });

  // ── 首页推荐 ──────────────────────────────────────────
  handle('get-home-recommendations', async () => {
    try {
      return await domain.getHomeRecommendations({ api });
    } catch (e) {
      logger.warn('获取推荐内容失败:', e.message);
      return { netease: { tops: [], playlists: [] }, qq: { playlists: [] }, error: e.message };
    }
  });

  handle('get-home-section', async (_, section) => {
    try {
      return await domain.getHomeSection({ api, section });
    } catch (e) {
      return { ok: false, section, data: [], error: e.message || String(e) };
    }
  });

  // ── 歌单 / 专辑曲目 ───────────────────────────────────
  handle('get-playlist-songs', async (_, platform, id, limit) => {
    try {
      return await domain.getPlaylistSongs({ api, platform, id, limit });
    } catch (e) {
      logger.warn('获取歌单歌曲失败:', e.message);
      return [];
    }
  });

  handle('get-album-songs', async (_, platform, albumMid, limit) => {
    try {
      return await domain.getAlbumSongs({ api, platform, albumMid, limit });
    } catch (e) {
      logger.warn('获取专辑歌曲失败:', e.message);
      return [];
    }
  });

  // ── 歌手 ──────────────────────────────────────────────
  handle('search-singer', async (_, keyword, source, page) => {
    try {
      return await domain.searchSinger({ api, keyword, source, page });
    } catch (e) {
      logger.warn('搜索歌手失败:', e.message);
      return { singers: [], total: 0 };
    }
  });

  handle('get-singer-songs', async (_, singerMid, limit) => {
    try {
      return await domain.getSingerSongs({ api, singerMid, limit });
    } catch (e) {
      logger.warn('获取歌手歌曲失败:', e.message);
      return [];
    }
  });

  handle('get-singer-albums', async (_, singerMid, source, pageNo, pageSize) => {
    try {
      return await domain.getSingerAlbums({ api, singerMid, source, pageNo, pageSize });
    } catch (e) {
      logger.warn('获取歌手专辑失败:', e.message);
      return { albums: [], total: 0 };
    }
  });

  // ── 专辑搜索 ──────────────────────────────────────────
  handle('search-album', async (_, keyword, source, page) => {
    try {
      return await domain.searchAlbum({ api, keyword, source, page });
    } catch (e) {
      return { albums: [], total: 0, error: e.message };
    }
  });

  // ── 链接识别 ──────────────────────────────────────────
  handle('get-song-by-link', async (_, text) => {
    try {
      return await domain.getSongByLink({ api, text: String(text || '') });
    } catch (e) {
      logger.warn('链接识别失败:', e.message || e);
      return { matched: false, error: e.message || e };
    }
  });

  // ── 平台清单（v3）────────────────────────────────────
  // 渲染层的平台名 / 图标 / 徽标配色 / 下拉选项 / 能力全部由这一次调用驱动。
  // 渲染层不再持有任何平台 id 清单，新增平台无需改动渲染层一行。
  handle('get-platforms', () => {
    try {
      return domain.getPlatforms({ api });
    } catch (e) {
      logger.warn('获取平台清单失败:', e.message || e);
      return [];
    }
  });

  // ── 源可用性探针（P2）─────────────────────────────────
  // 被动健康度快照：getDownloadUrlSmart 各环节记的滑动窗口统计
  handle('get-source-health', () => {
    try {
      return domain.getSourceHealth({ api, sources: api.getProbeSources() });
    } catch (_e) {
      return {};
    }
  });

  // 主动探测：各源搜一首公共曲并尝试取流。搜索通=源可达；取流通=源健康。
  // 探测结果记入 sourceHealth 滑动窗口（与真实下载共用同一分数）。
  handle('probe-sources', async () => {
    try {
      return await domain.probeSources({ api, logger });
    } catch (e) {
      logger.warn('探测源失败:', e.message || e);
      return { probes: [], health: {} };
    }
  });
}

module.exports = { register };
