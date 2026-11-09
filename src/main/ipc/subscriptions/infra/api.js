/**
 * 订阅域 infra —— api 适配器
 * 封装 require('../../../../api') 的 getPlaylistSongs / getSingerSongs
 */

const api = require('../../../../api');

/**
 * 拉取订阅条目对应的歌曲列表。
 * @param {object} entry
 * @returns {Promise<Array<object>>}
 */
async function fetchSongs(entry) {
  if (entry.type === 'playlist') {
    return await api.getPlaylistSongs(entry.platform, entry.targetId, 200);
  }
  return await api.getSingerSongs(entry.targetId, 50, entry.platform);
}

module.exports = { fetchSongs };
