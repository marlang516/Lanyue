/**
 * 本地音乐库 IPC · infra · 用户偏好
 *
 * 封装 prefs.get/set，供 domain 层调用。
 */

const prefs = require('../../../../utils/prefs');

module.exports = {
  get: prefs.get,
  set: prefs.set,
};
