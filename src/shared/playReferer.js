/**
 * 播放 / 探测所需 Referer 的唯一判定。
 *
 * 优先取流结果自带的 referer（B 站直链会带），其余按平台查表。
 * kugou / kuwo / migu / soda / 5sing 的 CDN 不要求 Referer，返回空串。
 * 渲染层 utils.playReferer 与主进程换源预检都走这里，避免两份表各改各的。
 */

const PLAY_REFERERS = {
  bilibili: 'https://www.bilibili.com/',
  qq: 'https://y.qq.com/',
  netease: 'https://music.163.com/',
};

/**
 * @param {string} [source] 平台 id
 * @param {{referer?: string}|null} [result] 取流结果
 * @returns {string}
 */
function playReferer(source, result) {
  return (result && result.referer) || PLAY_REFERERS[source] || '';
}

/**
 * 给 testAudioLink 的请求头。没有 Referer 时返回空对象，不送一个空头。
 * @param {{source?: string, referer?: string}|null} result
 * @returns {Object}
 */
function probeHeaders(result) {
  const referer = playReferer(result && result.source, result);
  return referer ? { Referer: referer } : {};
}

module.exports = {
  PLAY_REFERERS,
  playReferer,
  probeHeaders,
};
