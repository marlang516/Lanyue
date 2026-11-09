/**
 * 搜索域 domain 入口：汇总所有业务编排函数
 */

const search = require('./search');
const searchOrchestrator = require('./searchOrchestrator');
const nlSearchOrchestrator = require('./nlSearchOrchestrator');
const lyrics = require('./lyrics');
const home = require('./home');
const playlist = require('./playlist');
const singer = require('./singer');
const album = require('./album');
const link = require('./link');
const platform = require('./platform');
const download = require('./download');

module.exports = {
  ...search,
  searchMusic: searchOrchestrator.searchMusic,
  nlSearch: nlSearchOrchestrator.nlSearch,
  getLyrics: lyrics.getLyrics,
  getHomeRecommendations: home.getHomeRecommendations,
  getHomeSection: home.getHomeSection,
  getPlaylistSongs: playlist.getPlaylistSongs,
  getAlbumSongs: playlist.getAlbumSongs,
  searchSinger: singer.searchSinger,
  getSingerSongs: singer.getSingerSongs,
  getSingerAlbums: singer.getSingerAlbums,
  searchAlbum: album.searchAlbum,
  getSongByLink: link.getSongByLink,
  getPlatforms: platform.getPlatforms,
  getSourceHealth: platform.getSourceHealth,
  recordProbeResult: platform.recordProbeResult,
  getProbeSources: platform.getProbeSources,
  getDownloadUrl: download.getDownloadUrl,
  probeSources: download.probeSources,
};
