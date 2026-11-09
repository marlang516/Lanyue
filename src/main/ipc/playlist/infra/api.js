/**
 * 歌单域 infra · API 适配器
 *
 * 封装 require('../../../../api') 的 getPlaylistSongs，供 domain 层拉取平台歌单。
 * 不含业务判断，仅做 I/O 转发与参数归一。
 */

const { SOURCE_FETCH_LIMIT } = require('../../../../utils/crossSourceAggregate');

/** 平台 id 归一（QQ 歌单有时带 mid 前缀，这里只做去空白与小写） */
function platformIdOf(s) {
  return String(s || '').trim();
}

/** 拉取平台歌单曲目（3-B 聚合用） */
async function getPlatformPlaylistSongs(source, playlistId) {
  const { getPlaylistSongs } = require('../../../../api');
  const r = await getPlaylistSongs(platformIdOf(source), playlistId, SOURCE_FETCH_LIMIT);
  return (r && (r.songs || r.list)) || [];
}

module.exports = {
  getPlatformPlaylistSongs,
  platformIdOf,
};
