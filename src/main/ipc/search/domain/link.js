/**
 * 搜索域 domain —— 链接识别业务编排
 * 纯业务逻辑，不依赖 electron、context.getCtx()、safeSend。
 *
 * 关键：返回形状必须与旧 IPC handler 完全一致。
 *   - getSongByLink 直接返回 api.getSongByLink(...) 原样；失败返回 { matched: false, error }
 */

const { validateKeyword } = require('./search');

/**
 * 解析音乐链接。
 * @param {Object} deps
 * @param {Function} deps.api.getSongByLink
 * @param {string} deps.text - 用户输入文本
 * @returns {Promise<Object>} 直接返回识别结果；失败返回 { matched: false, error }
 */
async function getSongByLink({ api, text }) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { matched: false, error: '输入不能为空' };
  }
  try {
    return await api.getSongByLink(text.trim());
  } catch (e) {
    return { matched: false, error: e.message || '解析链接失败' };
  }
}

module.exports = {
  getSongByLink,
};
