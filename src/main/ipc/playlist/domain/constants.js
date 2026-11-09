/**
 * 歌单域常量（纯数据，无依赖）
 */

// 收藏歌单（红心）：userPlaylists 里 id 固定的系统歌单
const FAVORITES_ID = 'favorites';
const FAVORITES_NAME = '收藏';

// 回收站单独一个 prefs 键，不掺进 userPlaylists
const TRASH_KEY = 'playlistTrash';

module.exports = { FAVORITES_ID, FAVORITES_NAME, TRASH_KEY };
