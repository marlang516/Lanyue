/**
 * 搜索域 infra —— Cookie 读取封装
 */

const cookieStore = require('../../../../utils/cookieStore');

/** 已登录平台集合（与 aggregate-cross-source 同一权威来源） */
function getLoggedInSources() {
  return Object.entries(cookieStore.getAll())
    .filter(([, v]) => !!v)
    .map(([k]) => String(k).trim().toLowerCase());
}

module.exports = {
  getAll: () => cookieStore.getAll(),
  getLoggedInSources,
};
