/**
 * 下载 / 队列 IPC（组装根）
 *
 * 按域拆分（等价迁移，样式同 ipc/library/）：
 *   stream.js          取流域：get-download-url(-smart) / proxy-play（播放链路，钉在 stream-*.test）
 *   queue.js           队列域：入队 / 取消 / 重试 / 移除 / 排序 / 暂停 / 清空 / 批量入队
 *   exportPlaylist.js  歌单导出：export-playlist（m3u / pls）
 *
 * 队列管理 + processQueue/processOneSong 留在 main/index.js（共享状态多）。
 *
 * M1.1-C：队列域能力由装配层显式注入（`register({ queue })`），
 * 见 docs/adr/0002-download-ports.md §5.2。
 */

const stream = require('./download/stream');
const queue = require('./download/queue');
const exportPlaylist = require('./download/exportPlaylist');

/**
 * @param {{ queue?: Object }} [opts] 队列域依赖，形状见 ipc/download/queue.js 的 QueueDeps
 */
function register(opts = {}) {
  stream.register();
  queue.register(opts.queue);
  exportPlaylist.register(opts.port);
}

module.exports = {
  register,
  // 兼容旧出口：makeTaskId 原挂在本文件，现由 queue.js 提供
  makeTaskId: queue.makeTaskId,
};
