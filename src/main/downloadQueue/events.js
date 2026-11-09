/**
 * 进度与事件出口（Events）（ADR 0003 §5 步骤 5）。
 *
 * 从 `src/main/downloadQueue.js` 外移。本模块是引擎向外部（IPC / 任务栏 / 托盘）
 * 推送事件的**唯一出口**，回答三件事：
 *   1. 队列快照什么时候推（`notifyQueueChanged`，推送 → 落盘的顺序固定）；
 *   2. 单曲进度怎么节流（`PROGRESS_THROTTLE_MS`，100% 必发）；
 *   3. 传输速度/ETA 的采样状态存在哪（`speedStates`，任务终态即删）。
 *
 * 状态所有权（ADR 0003 §2.1）：
 *   - `speedStates` 与每个 attempt 的节流时钟（`lastAt`）只存在于本工厂闭包里，
 *     引擎（facade）不再保留同名变量 —— 全仓不得出现第二份节流状态。
 *   - 500ms 持久化防抖 timer **不在**本模块：它归 `persist.js`，由注入的
 *     `persistQueue` 调用。本模块自己不排任何定时器（`dispose` 仍保留一个
 *     幂等的清理入口，见 `dispose()` 注释）。
 *
 * 行为契约（与拆分前逐字一致，改动等于改下载行为）：
 *   - `notifyQueueChanged(immediate)` 必须先 `emitQueueUpdated(活数组)`、再
 *     `persistQueue({ immediate })`；终态传 `true` 绕开防抖（§6.3）。
 *   - 进度事件：`pct < 100 && now - lastAt < 120` 丢弃；否则发送并刷新 lastAt。
 *     判据是「距上次上报多久」而不是「百分比有没有变」（§5 步骤 5 退出判据）。
 *   - `song.progress` 每次都更新（队列摘要直接读它，不依赖事件）。
 *   - 端口抛错只丢这一条事件，不冒泡回下载循环（`guardPort`，M1.1 验收回归）。
 */

const speedMeter = require('../speedMeter');
const { guardPort } = require('./ports');

/**
 * 下载进度上报的最小间隔（毫秒）。
 *
 * 120ms 约等于 8 fps：进度条与速度/ETA 的观感毫无差别，IPC 量降一到两个数量级。
 * 进度达到 100 时**总是**发，否则最后一个包到达就被节流吃掉，界面停在 99%
 * 直到终态推送。
 *
 * 本常量是**唯一来源**；主文件只保留名称引用（渲染层注释交叉检索用）。
 */
const PROGRESS_THROTTLE_MS = 120;

/**
 * 创建进度与事件出口实例（每个引擎一份，无模块级可变单例）。
 *
 * @param {Object} deps
 * @param {() => Object[]} deps.getQueue 返回队列**活数组引用**（不得复制）
 * @param {{ emitQueueUpdated: Function, emitProgress: Function, emitError: Function }} deps.progress
 *   事件推送端口（实现侧负责 IPC 与 UI 副作用；本模块负责守卫与节流）
 * @param {(opts: {immediate?: boolean}) => void} deps.persistQueue 持久化入口
 *   （必须是「推送之后」调用；persist 内部再决定防抖或立即落盘）
 * @returns {{
 *   notifyQueueChanged: (immediate?: boolean) => void,
 *   emitError: (taskId: string, payload: Object) => void,
 *   makeOnProgress: (song: Object, cancelToken?: string) => ((pct: number, bytes?: Object) => void),
 *   forget: (taskId: string) => void,
 *   dispose: () => void,
 * }} 事件实例
 */
function createEvents({ getQueue, progress, persistQueue } = {}) {
  if (typeof getQueue !== 'function') throw new Error('[Events] 必须注入 getQueue');
  if (!progress || typeof progress !== 'object') throw new Error('[Events] 必须注入 progress');
  if (typeof persistQueue !== 'function') throw new Error('[Events] 必须注入 persistQueue');

  /** taskId → 速度采样状态（瞬态，任务终态即删） */
  const speedStates = {};
  /** taskId → 当前 attempt 的节流时钟（每次 makeOnProgress 新建一份，与原 prog 同语义） */
  const progressThrottles = new Map();
  /**
   * 合并/节流定时器句柄。当前实现是**前沿节流**（不排 timer），此变量保留给
   * dispose 的清理链：任何未来引入的 trailing-edge 合并窗口都必须挂在这里，
   * 否则退出后可能多推一条事件、多排一次落盘。
   */
  let flushTimer = null;

  /**
   * 队列变更统一出口：推送 + 持久化；immediate=true 跳过防抖（终态用）。
   *
   * 顺序被固化在本函数内部（ADR 0003 §6.3）：先推活数组，再落盘。persist
   * 只能被它调用，不许反向调用；调度器/任务协程一律走本方法表达终态，
   * 不自己拼事件。
   *
   * @param {boolean} [immediate]
   */
  function notifyQueueChanged(immediate) {
    guardPort(() => progress.emitQueueUpdated(getQueue()), 'emitQueueUpdated');
    persistQueue({ immediate: !!immediate });
  }

  /**
   * 失败终态事件（emitError）的守卫封装。
   *
   * 端口抛错只丢这一条错误事件，不改变已写入的历史/队列状态。
   *
   * @param {string} taskId
   * @param {Object} payload
   */
  function emitError(taskId, payload) {
    guardPort(() => progress.emitError(taskId, payload), 'emitError');
  }

  /**
   * 生成一次传输尝试的 `onProgress` 回调。
   *
   * 节流状态按 attempt 隔离：原实现每次调用 `downloadFileWithRetry` 前新建
   * `prog = { lastAt: 0 }`，因此重试后的第一拍必定发；这里保持同一语义。
   * Map 里按 taskId 覆盖引用，只为让 `dispose()` 能一次性清掉残留时钟，
   * 回调本身仍闭包持有自己的 state（不读 Map），不受 delete 影响。
   *
   * @param {Object} song 队列条目（读 taskId / 写 progress）
   * @param {string} [cancelToken] 取消令牌（当前仅语义对齐：取消判断走 song._cancelRequested）
   * @returns {(pct: number, bytes?: {receivedBytes?: number, totalBytes?: number}) => void}
   */
  function makeOnProgress(song, cancelToken) {
    const state = { lastAt: 0 };
    const taskId = song && song.taskId;
    if (taskId !== undefined) progressThrottles.set(taskId, state);
    void cancelToken; // 保留签名（ADR §5 步骤 5）；取消判断仍以 song._cancelRequested 为准

    return function onProgress(pct, bytes) {
      // 取消后底层回调可能迟到一拍：不得再写进度/推送事件（UI 闪烁来源）
      if (song._cancelRequested) return;
      song.progress = pct;
      const now = Date.now();
      // 100% 必须发出去（否则界面停在 99% 直到终态推送），其余按时间窗合并。
      // 注意判据是「距上次上报多久」，**不是**「百分比有没有变」：后者等于
      // 没节流 —— 每个 chunk 的百分比几乎都是新的。
      if (pct < 100 && now - state.lastAt < PROGRESS_THROTTLE_MS) return;
      state.lastAt = now;
      const payload = { id: taskId, progress: pct };
      if (bytes) {
        const r = speedMeter.nextSpeed(speedStates[taskId], Date.now(), bytes.receivedBytes, bytes.totalBytes);
        speedStates[taskId] = r.state;
        payload.receivedBytes = bytes.receivedBytes;
        payload.totalBytes = bytes.totalBytes || null;
        payload.speedBps = r.speedBps;
        payload.etaSec = r.etaSec;
      }
      // 端口抛错（如 webContents 已销毁）只丢这一条进度事件，不得冒泡回下载循环
      // 中断传输 —— 与「端口抖动不污染队列状态」的承诺一致（M1.1 验收回归）。
      guardPort(() => progress.emitProgress(taskId, payload), 'emitProgress');
    };
  }

  /**
   * 丢弃某个任务的瞬态采样/节流状态（终态调用）。
   *
   * 与原 `delete speedStates[song.taskId]` 等价；多清一格 throttle Map 不改变
   * 行为（终态后不再有进度回调；迟到的取消回调由 `_cancelRequested` 拦住）。
   *
   * @param {string} taskId
   */
  function forget(taskId) {
    delete speedStates[taskId];
    progressThrottles.delete(taskId);
  }

  /**
   * 退出清理（幂等）。
   *
   * 本模块当前不创建定时器（前沿节流无 timer），所以这里只做两件事：
   *   1. 清掉未来可能挂上的 `flushTimer`；
   *   2. 丢弃残留的采样/节流状态，避免 disposed 后的闭包继续持有引用。
   * 调用顺序见 facade.dispose()：scheduler.stop() → events.dispose() →
   * persistence.flush()。放在 flush 之前，保证事件侧不会再排新的防抖写盘。
   */
  function dispose() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    for (const key of Object.keys(speedStates)) delete speedStates[key];
    progressThrottles.clear();
  }

  return {
    notifyQueueChanged,
    emitError,
    makeOnProgress,
    forget,
    dispose,
  };
}

module.exports = {
  createEvents,
  PROGRESS_THROTTLE_MS,
};