/**
 * 订阅域 infra —— history 适配器
 * 封装 require('../../../../utils/history') 的 findDownloadedAsync
 */

const history = require('../../../../utils/history');

/**
 * 判断歌曲是否已下载（异步判活，避免在网络盘上阻塞主进程）。
 * @param {string|number} id
 * @param {string} source
 * @returns {Promise<boolean>}
 */
async function findDownloadedAsync(id, source) {
  return await history.findDownloadedAsync(id, source);
}

module.exports = { findDownloadedAsync };
