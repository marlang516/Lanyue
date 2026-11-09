/**
 * 歌单域 infra · Cookie 适配器
 *
 * 封装 require('../../../../utils/cookieStore')，供 domain 层读取已登录平台集合。
 * 不含业务判断，仅做 I/O 转发。
 */

const cookieStore = require('../../../../utils/cookieStore');

/** 已登录平台集合（小写，供 pickRepresentative 择优排序用） */
function getLoggedInSources() {
  return Object.entries(cookieStore.getAll())
    .filter(([, v]) => !!v)
    .map(([k]) => String(k).trim().toLowerCase());
}

module.exports = {
  getLoggedInSources,
};
