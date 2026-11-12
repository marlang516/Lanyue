/**
 * 下载调度器（Scheduler）（ADR 0003 §5 步骤 4）。
 *
 * 从 `src/main/downloadQueue.js` 外移：调度职责从「队列数据 / 持久化 / 单曲执行」
 * 里独立出来，本模块只回答三个问题：
 *   1. **现在能不能起新任务**（暂停？重入？全局并发 / 单源并发还有额度？）
 *   2. **下一个起谁**（按队列顺序取第一条 `pending` 且该源未到 cap 的条目）
 *   3. **什么时候再排一次**（终态后有 pending ⇒ 100ms 唤醒；重试退避 ⇒ 500ms）
 *
 * 本模块**不持有队列数组**：数组身份是引擎契约（`getQueue()` 返回活引用，
 * index.js / IPC / subscriptions 直写同一个对象），owner 是 `queueStore`。
 * 这里只经注入的 `getQueue` 读它，任何变更都是原地 push/splice（由外部完成）。
 *
 * 状态所有权（ADR 0003 §2.1）：`activeDownloads` / `processTimer` /
 * `_processQueueRunning` / `_paused` 只存在于本工厂的闭包里 —— 引擎（facade）
 * 不再保留同名变量，避免「两套调度」。
 *
 * 定时器归属（ADR 0003 §6.4）：本模块是**唯一**创建调度类定时器的地方：
 *   - `processTimer`：100ms 重排（终态后有 pending 时）
 *   - `backoffWaits`：500ms 重试退避等待
 * `stop()` 必须清掉两者，`dispose()` 只调用一次 `stop()` 即无残留。
 * 持久化的 500ms 防抖 timer 归 `persist.js`，与本模块无关。
 *
 * 行为契约（与拆分前逐字一致，改动等于改下载行为）：
 *   - 全局并发读 `prefs.concurrency`（1..10，越界回落 3），每次调度入口现读；
 *   - 单平台并发 `prefs.perSourceConcurrency`（1..10，默认 2）再 `min` 全局值；
 *   - 重入保护：同一时刻只有一次调度循环在跑；
 *   - 暂停只挡新任务，不打断在途协程；恢复时清重排 timer 并立即重排；
 *   - 终态后 `.finally` 立即推送/落盘（`notify(true)`），有 pending 才 100ms 后重排。
 */

/** 重试前的退避等待（毫秒，ADR 0003 §5 步骤 4 从主文件迁入） */
const RETRY_BACKOFF_MS = 500;
/** 终态后若有 pending，延迟这么久再排下一批（避免同步递归调度） */
const RESCHEDULE_DELAY_MS = 100;

/**
 * 创建调度器（每个引擎一份，无模块级可变单例）。
 *
 * @param {Object} deps
 * @param {() => Object[]} deps.getQueue 返回队列**活数组引用**（不得复制）
 * @param {(song: Object) => Promise<void>} deps.runSong 单曲协程（引擎的 processOneSong）
 * @param {(song: Object, to: string, reason?: string) => void} deps.transition 状态迁移出口
 * @param {(immediate?: boolean) => void} deps.notify 队列变更出口（推送 → 落盘）
 * @param {(key: string) => any} deps.readPrefs 读偏好（注入 prefs.get，便于单测）
 * @param {(taskId: string) => void} deps.cancelDownload 打断在途请求（引擎侧已做存在性/异常守卫）
 * @param {Object} [deps.logger] 日志器
 * @returns {{
 *   processQueue: () => Promise<void>,
 *   setPaused: (v: boolean) => void,
 *   isPaused: () => boolean,
 *   getActiveCount: () => number,
 *   resumeRestoredQueue: () => number,
 *   requestCancel: (taskId: string) => boolean,
 *   waitRetryBackoff: () => Promise<void>,
 *   stop: () => void,
 *   getConcurrency: () => number,
 *   getPerSourceCap: () => number,
 * }} 调度器实例
 */
function createScheduler({
  getQueue,
  runSong,
  transition,
  notify,
  readPrefs,
  cancelDownload,
  logger,
} = {}) {
  if (typeof getQueue !== 'function') throw new Error('[Scheduler] 必须注入 getQueue');
  if (typeof runSong !== 'function') throw new Error('[Scheduler] 必须注入 runSong');
  if (typeof transition !== 'function') throw new Error('[Scheduler] 必须注入 transition');
  if (typeof notify !== 'function') throw new Error('[Scheduler] 必须注入 notify');
  if (typeof readPrefs !== 'function') throw new Error('[Scheduler] 必须注入 readPrefs');
  if (typeof cancelDownload !== 'function') throw new Error('[Scheduler] 必须注入 cancelDownload');
  if (!logger) throw new Error('[Scheduler] 必须注入 logger');

  /** 在途协程数（含退避等待中的协程：status 可能是 pending） */
  let activeDownloads = 0;
  /** 100ms 重排定时器（唯一实例，避免重复 setTimeout 堆叠） */
  let processTimer = null;
  /** 调度循环重入保护 */
  let running = false;
  /** 暂停开关：只挡新任务启动 */
  let paused = false;
  /** dispose 之后不再起任何新任务 / 不再重排（退出后拉起的下载是真实泄漏） */
  let disposed = false;
  /** 在途的退避等待：{ timer, resolve }，stop() 必须能清掉 */
  const backoffWaits = new Set();

  /** 读取全局并发数（1..10，越界回落 3；设置变更实时生效） */
  function getConcurrency() {
    try {
      const v = readPrefs('concurrency');
      return (v >= 1 && v <= 10) ? v : 3;
    } catch (_e) {
      return 3;
    }
  }

  /**
   * 单平台并发上限（perSourceConcurrency，默认 2，越界回落 2）。
   * 钳制到全局 concurrency 之内 —— 只会比全局更紧，不会更松。
   */
  function getPerSourceCap() {
    let cap;
    try {
      const v = readPrefs('perSourceConcurrency');
      cap = (v >= 1 && v <= 10) ? v : 2;
    } catch (_e) {
      cap = 2;
    }
    return Math.min(cap, getConcurrency());
  }

  /** 某请求源当前在途任务数（从队列状态派生，不另立计数器避免漂移）。
   *  含重试退避中的协程（status=pending 但 _processing=true）—— 它仍占并发额度。 */
  function activeCountBySource(source) {
    let n = 0;
    for (const s of getQueue()) {
      if (!s || s.source !== source) continue;
      if (s.status === 'downloading' || (s.status === 'pending' && s._processing)) n++;
    }
    return n;
  }

  /** 取下一个可调度任务：pending 且协程不在途、其平台未到并发上限（按队列顺序即展示顺序） */
  function pickSchedulable(cap) {
    for (const s of getQueue()) {
      if (!s || s.status !== 'pending' || s._processing) continue;
      if (activeCountBySource(s.source) < cap) return s;
    }
    return null;
  }

  /**
   * 调度下载队列（最多并发 N 首，N 动态读 prefs）。
   *
   * 重入保护：`running` 防止并发调度导致 `activeDownloads` 计数混乱。
   * 空队列 / 额度用尽 / 没有可调度项时自然退出（不抛错）——「空队列退出」是
   * 合法终态，不再由调用方判空。
   */
  async function processQueue() {
    if (disposed) return;
    if (paused) return; // 暂停：不调度新任务（在途任务不打断，与取消语义一致）
    if (running) return;
    running = true;
    const concurrency = getConcurrency();
    const perSourceCap = getPerSourceCap();
    try {
      while (activeDownloads < concurrency) {
        const song = pickSchedulable(perSourceCap);
        if (!song) break;
        transition(song, 'downloading', '开始下载');
        song.error = null;
        song.progress = 0;
        activeDownloads++;
        notify();
        // 异步处理（不阻塞调度）
        runSong(song).finally(() => {
          activeDownloads--;
          // 任务到达终态（done/error/cancelled）：立即落盘，不等防抖 ——
          // 崩溃窗口里丢终态 = 用户看到已完成的任务消失
          notify(true);
          if (disposed) { running = false; return; } // 已退出：不得再排下一批
          // 还有 pending 时调度下一批（统一使用 processTimer，避免重复 setTimeout）
          if (getQueue().some(s => s.status === 'pending')) {
            if (processTimer) clearTimeout(processTimer);
            processTimer = setTimeout(() => {
              processTimer = null;
              running = false;
              processQueue();
            }, RESCHEDULE_DELAY_MS);
          } else {
            running = false;
          }
        });
      }
    } finally {
      // 如果循环正常结束（没有 pending 歌曲），重置标志
      if (activeDownloads < concurrency) {
        running = false;
      }
    }
  }

  /**
   * 恢复之后把待下载任务重新推上调度器（2026-10-13 复审 P0-1）。
   *
   * 为什么必须是独立方法而不是顺手塞进 loadPersistedQueue：
   * 加载是「读盘 + 清洗 + 入队」的纯数据动作，调度是**行为**动作 —— 合成
   * 一个方法既没法单测「恢复后到底开没开跑」，也让「只加载不启动」这种
   * 合法用法（例如先看一眼队列再决定）变得不可能。
   *
   * error 状态**不**自动重试：失败任务的语义是「等用户决定」。
   *
   * @returns {number} 本次推上调度器的任务数
   */
  function resumeRestoredQueue() {
    const pending = getQueue().filter(s => s && s.status === 'pending').length;
    if (!pending) return 0;
    logger.log(`[Queue] 恢复后自动调度 ${pending} 个待下载任务`);
    // processQueue 自带 finally 复位，理论上不 reject；仍兜一层，
    // 免得调度器里任何未来的抛错变成未处理拒绝把主进程掀翻。
    Promise.resolve()
      .then(() => processQueue())
      .catch(e => logger.warn('[Queue] 恢复后调度失败:', e && e.message));
    return pending;
  }

  /**
   * 取消任务（协作式）：下载中置标记 + 打断在途请求；重试等待期（status=pending
   * 但 _processing=true，协程在退避 await 中）只置标记，协程在下一轮循环顶退出。
   *
   * @returns {boolean} 是否命中一个在途任务
   */
  function requestCancel(taskId) {
    const song = getQueue().find(s => s.taskId === taskId &&
      (s.status === 'downloading' || (s.status === 'pending' && s._processing)));
    if (!song) return false;
    song._cancelRequested = true;
    cancelDownload(String(taskId));
    return true;
  }

  /** 暂停/继续调度：暂停只挡新任务启动；恢复时立即重新调度 */
  function setPaused(v) {
    paused = !!v;
    if (!paused) {
      if (processTimer) { clearTimeout(processTimer); processTimer = null; }
      running = false;
      processQueue();
    }
  }

  /**
   * 重试退避等待（500ms）。
   *
   * 定时器归本模块：`stop()` 会清掉所有在途退避 timer（退出时不留下 500ms 句柄）。
   * 被 stop() 清掉的等待**不会**再兑现 —— 引擎已退出，协程不需要继续重试；
   * 未兑现的 Promise 不持有事件循环句柄，不构成泄漏。
   *
   * @returns {Promise<void>}
   */
  function waitRetryBackoff() {
    return new Promise((resolve) => {
      const wait = { timer: null };
      wait.timer = setTimeout(() => {
        backoffWaits.delete(wait);
        resolve();
      }, RETRY_BACKOFF_MS);
      backoffWaits.add(wait);
    });
  }

  /**
   * 停止调度（dispose 专用，幂等）。
   *
   * 清 processTimer + 复位重入标志 + 丢弃在途退避等待，并竖起 disposed 旗：
   * 正在收尾的协程 `.finally` 不会在退出后再拉起一次 processQueue（§6.4）。
   */
  function stop() {
    disposed = true;
    if (processTimer) {
      clearTimeout(processTimer);
      processTimer = null;
    }
    running = false;
    for (const wait of backoffWaits) clearTimeout(wait.timer);
    backoffWaits.clear();
  }

  return {
    processQueue,
    setPaused,
    isPaused: () => paused,
    getActiveCount: () => activeDownloads,
    resumeRestoredQueue,
    requestCancel,
    waitRetryBackoff,
    stop,
    // 只读暴露给文档/单测核对并发钳制口径（不属于引擎对外 API）
    getConcurrency,
    getPerSourceCap,
  };
}

module.exports = {
  createScheduler,
  RETRY_BACKOFF_MS,
  RESCHEDULE_DELAY_MS,
};
