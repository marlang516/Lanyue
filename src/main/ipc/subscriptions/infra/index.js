/**
 * 订阅域 —— 基础设施层（infra）
 *
 * 封装对 prefs / api / history / logger 的读写，供 service 层调用。
 * 本层不包含业务判断，只负责 I/O 与第三方模块的适配。
 *
 * createInfra(deps) 组装上述适配器；deps 中可注入可测试的替身。
 */

const api = require('../../../../api');
const prefs = require('../../../../utils/prefs');
const history = require('../../../../utils/history');
const logger = require('../../../../utils/logger');

const PREFS_KEY = 'subscriptions';

/**
 * 读取全部订阅条目（过滤掉不合法条目）。
 * @returns {Array<object>}
 */
function loadAll() {
  const raw = prefs.get(PREFS_KEY);
  return Array.isArray(raw) ? raw.filter(e => e && typeof e === 'object' && e.key) : [];
}

/**
 * 持久化全部订阅条目。
 * @param {Array<object>} entries
 */
function saveAll(entries) {
  prefs.set(PREFS_KEY, entries);
}

/**
 * 拉取订阅条目对应的歌曲列表。
 * @param {object} entry
 * @returns {Promise<Array<object>>}
 */
async function fetchSongs(entry) {
  if (entry.type === 'playlist') {
    return await api.getPlaylistSongs(entry.platform, entry.targetId, 200);
  }
  return await api.getSingerSongs(entry.targetId, 50, entry.platform);
}

/**
 * 把新增歌曲排进下载队列（自动下载）。
 * @param {object} entry
 * @param {Array<object>} fresh
 * @param {object} deps 下载队列能力
 * @param {() => Array<object>} deps.getQueue
 * @param {() => void} deps.persistQueue
 * @param {() => void} deps.processQueue
 * @param {Function} [deps.safeSend] 渲染层推送
 * @returns {Promise<number>} 实际入队数
 */
async function autoEnqueue(entry, fresh, deps = {}) {
  const { getQueue, persistQueue, processQueue, safeSend } = deps;
  const downloadQueue = getQueue ? getQueue() : [];
  let queued = 0;
  for (const song of fresh) {
    const inQueue = downloadQueue.some(s =>
      s && String(s.id) === String(song.id) && s.source === song.source && s.status !== 'done');
    if (inQueue) continue;
    if (await history.findDownloadedAsync(song.id, song.source)) continue;
    downloadQueue.push({
      ...song,
      id: String(song.id),
      taskId: 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      status: 'pending',
      progress: 0,
      addedAt: Date.now(),
    });
    queued++;
  }
  if (queued > 0) {
    logger.log(`[subscriptions] ${entry.name || entry.key} 自动下载 ${queued} 首`);
    if (typeof safeSend === 'function') safeSend('queue-updated', downloadQueue);
    if (typeof persistQueue === 'function') persistQueue();
    if (typeof processQueue === 'function') processQueue();
  }
  return queued;
}

/**
 * 创建 infra 工厂：组装所有基础设施适配器。
 * @param {object} [deps]
 * @param {object} [deps.prefs]   替代 require('../../../../utils/prefs')（需有 get/set）
 * @param {object} [deps.api]     替代 require('../../../../api')（需有 getPlaylistSongs/getSingerSongs）
 * @param {object} [deps.history] 替代 require('../../../../utils/history')（需有 findDownloadedAsync）
 * @param {object} [deps.logger]  替代 require('../../../../utils/logger')（需有 log/warn）
 * @param {object} [deps.queue]   下载队列能力 { getQueue, persistQueue, processQueue, safeSend }
 * @returns {{loadAll, saveAll, fetchSongs, autoEnqueue, PREFS_KEY}}
 */
function createInfra(deps = {}) {
  const p = deps.prefs || prefs;
  const a = deps.api || api;
  const h = deps.history || history;
  const l = deps.logger || logger;
  const q = deps.queue || {};

  function loadAll() {
    const raw = p.get(PREFS_KEY);
    return Array.isArray(raw) ? raw.filter(e => e && typeof e === 'object' && e.key) : [];
  }

  function saveAll(entries) {
    p.set(PREFS_KEY, entries);
  }

  async function fetchSongs(entry) {
    if (entry.type === 'playlist') {
      return await a.getPlaylistSongs(entry.platform, entry.targetId, 200);
    }
    return await a.getSingerSongs(entry.targetId, 50, entry.platform);
  }

  async function autoEnqueue(entry, fresh) {
    const { getQueue, persistQueue, processQueue, safeSend } = q;
    const downloadQueue = getQueue ? getQueue() : [];
    let queued = 0;
    for (const song of fresh) {
      const inQueue = downloadQueue.some(s =>
        s && String(s.id) === String(song.id) && s.source === song.source && s.status !== 'done');
      if (inQueue) continue;
      if (await h.findDownloadedAsync(song.id, song.source)) continue;
      downloadQueue.push({
        ...song,
        id: String(song.id),
        taskId: 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        status: 'pending',
        progress: 0,
        addedAt: Date.now(),
      });
      queued++;
    }
    if (queued > 0) {
      l.log(`[subscriptions] ${entry.name || entry.key} 自动下载 ${queued} 首`);
      if (typeof safeSend === 'function') safeSend('queue-updated', downloadQueue);
      if (typeof persistQueue === 'function') persistQueue();
      if (typeof processQueue === 'function') processQueue();
    }
    return queued;
  }

  return {
    PREFS_KEY,
    loadAll,
    saveAll,
    fetchSongs,
    autoEnqueue,
  };
}

module.exports = { createInfra, loadAll, saveAll, fetchSongs, autoEnqueue, PREFS_KEY };
