/**
 * 下载队列数组的唯一所有者（模块）（ADR 0003 §5 步骤 3）。
 *
 * 为什么必须单独立一个模块：
 *   `engine.getQueue()` 返回的是**活数组引用** —— `src/main/index.js:447` 直接把它
 *   赋给模块级 `downloadQueue`，`src/main/subscriptions.js:211` 与
 *   `src/main/ipc/download/queue.js` 的多个 handler 也直接 push/splice 同一个数组。
 *   如果数组仍散落在引擎闭包里，任何一次「顺手重建数组」（`[...rows]`、`rows = list`）
 *   都会让外部持有的引用变成孤儿：界面不动、订阅往旧数组里塞任务，且**不报错**。
 *
 * 所有权规则（硬约束，见 ADR 0003 §6.1）：
 *   1. `rows` 在 `createStore()` 内用 `const` 声明，**永不重新赋值**；
 *   2. `getQueue()` 原样返回 `rows` 引用，**永不复制**；
 *   3. 一切变更只能是原地操作：`push` / `splice` / `length = 0`。
 *
 * 为每个引擎各建一个 store 实例（而非进程级单例）：数组身份契约是「同一个引擎
 * 内、引擎与 index.js/IPC 持有同一对象」，不是「全进程共用一个队列」。单测会在
 * 同一进程里依次构造多个引擎，共享数组会让上一个引擎的 100ms 重排定时器读/写
 * 到下一个引擎的队列（既有 137 项会出现串扰）。生产环境只构造一个引擎，
 * 两种实现的外部契约一致。
 *
 * 本模块刻意只做队列数组的持有与淘汰策略，不含调度、持久化、事件推送 ——
 * 那些职责分别留在主文件与 downloadQueue/persist.js。
 */

/** done 任务保留上限：超出的最旧记录淘汰，防止 queue.json 长期使用无限增长 */
const MAX_DONE_RETAINED = 200;

/**
 * 创建一份队列存储（每个引擎一份）。
 *
 * @param {Object} [opts]
 * @param {number} [opts.maxDoneRetained] done 保留上限（默认 MAX_DONE_RETAINED）
 * @returns {{
 *   getQueue: () => Object[],
 *   trimDoneTasks: () => void,
 * }} 队列存储实例
 */
function createStore({ maxDoneRetained = MAX_DONE_RETAINED } = {}) {
  /** 队列的物理存储。唯一 owner 就是这份绑定，数组身份即契约。 */
  const rows = [];

  /** 返回队列活数组（同一引用，调用方可直接 push/splice）。 */
  function getQueue() {
    return rows;
  }

  /**
   * 淘汰超出保留上限的最旧 done 任务（队列顺序即展示顺序）。
   *
   * 逐字沿用原引擎实现：先数 done 总数，超出部分从队首方向按入队顺序 splice。
   * 操作对象是本实例的 `rows`，数组身份不变。
   */
  function trimDoneTasks() {
    const doneCount = rows.filter(s => s && s.status === 'done').length;
    if (doneCount <= maxDoneRetained) return;
    let toDrop = doneCount - maxDoneRetained;
    for (let i = 0; i < rows.length && toDrop > 0;) {
      if (rows[i] && rows[i].status === 'done') {
        rows.splice(i, 1);
        toDrop--;
      } else {
        i++;
      }
    }
  }

  return { getQueue, trimDoneTasks };
}

module.exports = {
  createStore,
  MAX_DONE_RETAINED,
};