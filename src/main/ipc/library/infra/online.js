/**
 * 本地音乐库 IPC · infra · 在线服务
 *
 * 封装 onlineCover / onlineLrc / api，供 domain 层调用。
 */

const { fetchOnlineCover } = require('../../../../utils/onlineCover');
const { scheduleOnlineLrcFetch } = require('../../../../utils/onlineLrc');
const api = require('../../../../api');

module.exports = {
  fetchOnlineCover,
  scheduleOnlineLrcFetch,
  getLyrics: api.getLyrics,
};
