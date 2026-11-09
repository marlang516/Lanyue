/**
 * 订阅域 infra —— 下载队列适配器
 * 封装下载队列能力（经 deps 注入，不直接 require context）。
 *
 * @typedef {object} QueueDeps
 * @property {() => Array<object>} getQueue
 * @property {() => void} persistQueue
 * @property {() => void} processQueue
 * @property {Function} [findDownloadedAsync] 查重函数（默认 utils/history.findDownloadedAsync）
 */

const logger = require('../../../../utils/logger');
const history = require('../../../../utils/history');

/** 取引擎内部队列数组（活引用）。 */
function getQueue(deps) {
  return deps.getQueue ? deps.getQueue() : [];
}

/** 落盘（引擎内部已做 500ms 防抖）。 */
function persistQueue(deps) {
  if (typeof deps.persistQueue === 'function') deps.persistQueue();
}

/** 触发调度。 */
function processQueue(deps) {
  if (typeof deps.processQueue === 'function') deps.processQueue();
}

/**
 * 把新增歌曲排进下载队列（自动下载）。
 * @param {object} entry
 * @param {Array<object>} fresh
 * @param {QueueDeps} deps
 * @param {Function} [deps.safeSend] 渲染层推送
 * @returns {Promise<number>} 实际入队数
 */
async function autoEnqueue(entry, fresh, deps = {}) {
  const downloadQueue = getQueue(deps);
  // 注入优先；未注入时用 utils/history 的默认实现（保证无隐式全局引用）
  const findDownloadedAsync = deps.findDownloadedAsync || history.findDownloadedAsync;
  let queued = 0;
  for (const song of fresh) {
    const inQueue = downloadQueue.some(s =>
      s && String(s.id) === String(song.id) && s.source === song.source && s.status !== 'done');
    if (inQueue) continue;
    if (await findDownloadedAsync(song.id, song.source)) continue;
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
    if (typeof deps.safeSend === 'function') deps.safeSend('queue-updated', downloadQueue);
    persistQueue(deps);
    processQueue(deps);
  }
  return queued;
}

module.exports = { getQueue, persistQueue, processQueue, autoEnqueue };
