/**
 * 事件端口（Port）的默认实现与调用守卫。
 *
 * 从 `src/main/downloadQueue.js` 外移（ADR 0003 §5 步骤 1）。本模块只依赖 logger，
 * 不持有引擎状态；端口契约本身（ProgressPort / NotifyPort typedef）仍留在主文件，
 * 因为那是 `createDownloadQueueEngine(deps)` 的入参说明。
 */

const logger = require('../../utils/logger');

/** 未注入通知能力时的空实现 */
const noopNotifyPort = Object.freeze({
  downloadDone() {},
  showInFolder() {},
});

/**
 * 端口调用守卫：外部能力（IPC/通知）的失败绝不能影响下载状态机。
 *
 * 队列推送、错误事件必包；进度事件虽属热路径（每 chunk 一次），其容错本应由
 * Port 实现内部负责（IPC 实现已是 try/catch），但注入实现抛错同样不得中断下载，
 * 故一并兜住 —— 端口抖动只丢一条事件，不污染队列状态。
 *
 * @param {() => any} fn
 * @param {string} label 日志标签
 */
function guardPort(fn, label) {
  try {
    return fn();
  } catch (e) {
    logger.warn(`[port] ${label} 失败:`, e && e.message);
  }
}

module.exports = {
  noopNotifyPort,
  guardPort,
};