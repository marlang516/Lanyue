/**
 * 歌单域 infra · prefs 适配器
 *
 * 封装 require('../../../../utils/prefs') 的 userPlaylists / playlistTrash 读写，
 * 供 domain 层调用。不含业务判断，仅做 I/O 转发。
 */

const prefs = require('../../../../utils/prefs');

/** 加载用户歌单列表（缺失时返回空数组） */
function loadUserPlaylists() {
  return prefs.get('userPlaylists') || [];
}

/** 持久化用户歌单列表 */
function saveUserPlaylists(playlists) {
  prefs.set('userPlaylists', playlists);
}

/** 加载回收站（缺失时返回空数组） */
function getTrash() {
  return prefs.get('playlistTrash') || [];
}

/** 持久化回收站 */
function saveTrash(trash) {
  prefs.set('playlistTrash', trash);
}

module.exports = {
  loadUserPlaylists,
  saveUserPlaylists,
  getTrash,
  saveTrash,
};
