/**
 * 心动模式 IPC
 *
 * 渲染层在播放队列自然播完时调用 generate-heartbeat：
 *   入参：{ currentSong, exclude, limit }
 *   出参：{ ok, songs, error? }
 *
 * 依赖显式注入（与 playlist / library 等域一致）：
 *   - getFavorites：读红心歌单（主进程 prefs 是唯一事实来源）
 *   - gateway：推荐网关（api/recommendations.js），算法核不直连平台
 *
 * 这个通道是只读的：不写歌单、不动队列。追加动作由渲染层做，
 * 因为「追加到哪个队列、是否处于播放态」只有渲染层知道。
 */

const { handle } = require('./register');
const heartbeatEngine = require('../../utils/heartbeatEngine');
const logger = require('../../utils/logger');

/**
 * @param {{
 *   getFavorites?: () => Array<object> | Promise<Array<object>>,
 *   gateway: object,
 * }} deps
 */
function register(deps = {}) {
  const getFavorites = typeof deps.getFavorites === 'function' ? deps.getFavorites : () => [];
  const gateway = deps.gateway;
  if (!gateway || typeof gateway !== 'object') {
    throw new Error('heartbeat.register: 缺少 gateway');
  }

  handle('generate-heartbeat', async (_, opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    const currentSong = o.currentSong && typeof o.currentSong === 'object' ? o.currentSong : null;
    const exclude = Array.isArray(o.exclude) ? o.exclude : [];
    try {
      const favorites = (await Promise.resolve(getFavorites())) || [];
      const songs = await heartbeatEngine.generate({
        currentSong,
        favorites: Array.isArray(favorites) ? favorites : [],
        exclude,
        gateway,
        limit: o.limit,
      });
      return { ok: true, songs };
    } catch (e) {
      // 生成失败不是致命错误：渲染层收到 ok:false 就维持「播完即停」
      logger.warn('[heartbeat] 生成失败:', e.message || e);
      return { ok: false, songs: [], error: (e && e.message) || String(e) };
    }
  });
}

module.exports = { register };
