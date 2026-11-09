/**
 * 搜索域 infra —— API 调用封装
 * 仅负责调用 src/api 的各路由，不含业务判断。
 */

const api = require('../../../../api');

module.exports = {
  searchMusic: (keyword, source, page, opts) =>
    api.searchMusic(keyword, source, page, opts),

  getLyrics: (id, source, title, artist) =>
    api.getLyrics(id, source, title, artist),

  getHomeRecommendations: () => api.getHomeRecommendations(),

  getHomeSection: (section) => api.getHomeSection(section),

  getPlaylistSongs: (platform, id, limit) =>
    api.getPlaylistSongs(platform, id, limit),

  searchSinger: (keyword, source, page) =>
    api.searchSinger(keyword, source, page),

  getSingerSongs: (singerMid, limit) =>
    api.getSingerSongs(singerMid, limit),

  getSingerAlbums: (singerMid, source, pageNo, pageSize) =>
    api.getSingerAlbums(singerMid, source, pageNo, pageSize),

  getAlbumSongs: (platform, albumMid, limit) =>
    api.getAlbumSongs(platform, albumMid, limit),

  searchAlbum: (keyword, source, page) =>
    api.searchAlbum(keyword, source, page),

  getSongByLink: (text) => api.getSongByLink(text),

  getPlatforms: () => api.registry.toClientPayload(),

  getSourceHealthMap: (sources) => api.getSourceHealthMap(sources),

  recordProbeResult: (source, ok) => api.recordProbeResult(source, ok),

  getProbeSources: () => api.registry.getProbeSources(),

  getDownloadUrl: (id, source, quality) =>
    api.getDownloadUrl(id, source, quality),
};
