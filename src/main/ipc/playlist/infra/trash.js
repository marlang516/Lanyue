/**
 * 歌单域 infra · 回收站适配器
 *
 * 封装 require('../../../../utils/playlistTrash') 的纯数组函数，供 domain 层调用。
 * 不含业务判断，仅做 I/O 转发（实际 prefs 持久化由 domain 层通过 infra.prefs 完成）。
 */

const {
  trashRemove,
  trashRestore,
  purgeExpired,
  trashView,
  trashPurge,
} = require('../../../../utils/playlistTrash');

module.exports = {
  trashRemove,
  trashRestore,
  purgeExpired,
  trashView,
  trashPurge,
};
