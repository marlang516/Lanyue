/**
 * 下载队列引擎（Download Queue Engine）
 *
 * 从 src/main/index.js 抽出（Sprint C）。抽出的理由：
 *   这段代码是**下载链路的完整状态机** —— 队列状态、持久化（防抖+原子写+淘汰）、
 *   并发调度、单曲处理（换源取流→落盘→ID3→歌词→历史→通知）、失败重试。
 *   它原先与「窗口创建 / 托盘 / 快捷键 / 应用生命周期」挤在同一文件，
 *   既难阅读，也让「下载」这个核心能力无法被独立测试与审视。
 *
 * 依赖注入：所有外部能力（prefs / history / 下载器 / 歌词 / API / 通知）
 * 通过 `createDownloadQueueEngine({...})` 传入，原因有二：
 *   1. main 进程模块在 Node 单测环境下无法 require electron —— 注入使
 *      「调度逻辑」与「Electron 运行时」解耦，可测；
 *   2. 避免本模块再 require 一堆单例，让依赖关系显式可读。
 *
 * ⚠️ 行为契约（改这里等于改下载行为，务必对照既有测试与实测）：
 *   - 并发数动态读 prefs.concurrency（1..10，越界回落 3）；
 *     单平台并发另受 prefs.perSourceConcurrency 钳制（默认 2，越界回落 2，
 *     且不超过全局 concurrency）—— 同源齐发最易触发平台风控/封 IP；
 *   - done 任务保留上限 200，超出按入队顺序淘汰最旧；
 *   - 持久化防抖 500ms + 原子写；done/error 终态绕开防抖立即落盘；
 *   - 仅 HTTP 403/404/410（CDN 签名过期）重试，其余错误直接放弃；
 *   - urlInfo.fatal=true（VIP/登录/无流）直接短路，不消耗重试配额；
 *   - 重启时 downloading → error；pending 超 24h → error。
 */

const logger = require('../utils/logger');
const prefs = require('../utils/prefs');
const historyDefault = require('../utils/history');
const fsaDefault = require('../utils/fsAsync');
const downloaderDefault = require('../utils/downloader');
const { evaluateQualityPolicy, normalizeQuality } = require('../utils/qualityPolicy');
// 注：单曲链路的文件系统/命名/容量/码表依赖（path、fs、naming、downloadPath、
// diskSpace、relinkRefs、netClass）随 12 个 phase 一起迁至
// downloadQueue/songTask.js（ADR 0003 §5 步骤 6），本文件不再持有它们。
// 队列状态迁移的唯一真相：状态集合与合法迁移表都在 downloadQueue/statemachine.js。
// 本文件此前内联了另一套「赋值即迁移」的逻辑（没有任何合法性约束），与那张表
// 描述的是同一语义 —— 两处真相必然漂。现在只保留这一处出口。
const statemachine = require('./downloadQueue/statemachine');
// ADR 0003 §5 步骤 1：零状态纯函数/端口已外移到 downloadQueue/ 子模块。
// 本文件只做 re-export（见文件末尾 module.exports），导出成员与形状保持不变。
const { sanitizeFilename } = require('./downloadQueue/naming');
const { noopNotifyPort, guardPort } = require('./downloadQueue/ports');

const {
  createPersistence,
  sanitizeRestoredTask,
  MAX_RESTORED_TASKS,
  QUEUE_STATUSES,
  MAX_DONE_RETAINED,
} = require('./downloadQueue/persist');
// ADR 0003 §5 步骤 3：队列数组的唯一 owner 由 store 模块的工厂产出。
// getQueue() 返回同一活数组引用，引擎闭包与外部（index.js / subscriptions.js / IPC）
// 共享的必须是这一个对象；每个引擎一份实例，互不串扰。
const storeModule = require('./downloadQueue/store');
// ADR 0003 §5 步骤 4：调度职责（并发钳制 / 重入保护 / 暂停恢复 / 100ms 重排 /
// 500ms 重试退避）已外移到 downloadQueue/scheduler.js。本文件只装配 + 转调，
// 不再持有并发计数、重排定时器、重入标志或暂停标志中的任何一个。
const schedulerModule = require('./downloadQueue/scheduler');
// ADR 0003 §5 步骤 5：进度节流与事件出口（notifyQueueChanged / emitProgress /
// emitError / speedStates / PROGRESS_THROTTLE_MS）已外移到 downloadQueue/events.js。
// 本文件只装配一个实例并转调，不再持有任何节流状态或速度采样状态。
const eventsModule = require('./downloadQueue/events');
// ADR 0003 §5 步骤 6：单曲任务流水线（12 个 phase）已外移到 downloadQueue/songTask.js。
// 本文件只保留一个编排入口：scheduler 的 runSong 直接转调 songTask.processOneSong，
// 队列数组仍由本文件注入活引用（身份不变），`_processing` 收口仍在该模块的 finally。
const songTaskModule = require('./downloadQueue/songTask');

/** 单曲最大尝试次数默认值（含首次）——用户可用 prefs.maxAttempts（1..5）覆盖 */
const MAX_RETRY = 2;
// 注：RETRY_BACKOFF_MS 随重试退避定时器迁至 downloadQueue/scheduler.js（步骤 4）。
// 注：MAX_DONE_RETAINED / STALE_PENDING_MS / PERSIST_DEBOUNCE_MS / QUEUE_STATUSES /
// MAX_RESTORED_TASKS 随持久化职责迁至 downloadQueue/persist.js（ADR 0003 §5 步骤 2），
// 对外导出的常量名与值保持不变（见文件末尾 module.exports）。

// 注：PROGRESS_THROTTLE_MS（120ms）与「进度 100 必发」判据随进度事件迁至
// downloadQueue/events.js（唯一来源）。本行保留常量名，供渲染层注释与源码护栏
// （test/queue-progress-throttle.test.js）交叉检索；本文件不得再定义同名常量。

/**
 * 状态迁移的唯一出口。
 *
 * 「谁能迁到谁」只有一份定义：downloadQueue/statemachine.js 的 TRANSITIONS。
 * 本函数只负责落状态并清掉状态机写入的审计字段 —— 队列条目会整条原子落盘
 * （queue.json）并原样推给渲染层，审计字段没有消费方，不外溢才不改变既有
 * 持久化/ IPC 负载的形态。
 *
 * 非法迁移会抛错：那不是运行时输入问题，而是调用顺序写错了（例如忘了把
 * 退避期的 pending 拉回 downloading），应当炸在测试里而不是悄悄写出脏状态。
 *
 * @param {Object} song 队列条目
 * @param {string} to 目标状态
 * @param {string} [reason] 迁移原因（出错/审计时可读）
 */
function applyStatus(song, to, reason) {
  statemachine.transition(song, to, reason);
  delete song._lastTransition;
}

/**
 * 队列/进度/错误事件推送端口（Port）。
 *
 * 引擎不知道「主窗口」这个概念存在 —— 它只知道有个地方能收队列快照与事件。
 * 实现体（IPC / 任务栏刷新 / 托盘刷新）只允许出现在主进程装配层。
 *
 * @typedef {Object} ProgressPort
 * @property {(rows?: readonly Object[]) => void} emitQueueUpdated 队列整表快照推送（不得抛）
 * @property {(taskId: string, payload: Object) => void} emitProgress 单任务增量进度（引擎已节流，不得抛）
 * @property {(taskId: string, payload: Object) => void} emitError 失败终态事件（不得抛）
 */

/**
 * 桌面通知端口（Port）。是否通知由引擎的偏好门禁决定，Port 只管「弹」。
 *
 * @typedef {Object} NotifyPort
 * @property {(song: Object, savePath: string) => void} downloadDone 单曲完成桌面通知（不得抛）
 * @property {(filePath: string) => void} showInFolder 在系统文件管理器中定位文件（不得抛）
 */

/**
 * 创建下载队列引擎。
 *
 * @param {Object} deps
 * @param {() => (string|null)} deps.userDataDir  用户数据目录（惰性，app ready 后才有值）
 * @param {ProgressPort} deps.progress 队列/进度/错误事件推送（实现侧负责 IPC 与 UI 副作用）
 * @param {(song:Object, quality:string) => Promise<Object>} deps.getDownloadUrlSmart 智能取流（含换源）
 * @param {(id:string, source:string, title:string, artist:string) => Promise<{lrc:string}>} deps.getLyrics
 * @param {NotifyPort} [deps.notify] 桌面通知能力（缺省为 no-op）
 * @param {Object} [deps.history] 下载历史模块（默认 utils/history；注入便于单测）
 * @param {Object} [deps.fsa] 异步文件工具（默认 utils/fsAsync）
 * @param {Object} [deps.downloader] 下载器（默认 utils/downloader），需含 downloadFileWithRetry / embedId3Tags
 * @param {(dir:string) => boolean} [deps.isSaveDirAllowed] C1: 渲染层传入 saveDir 的沙箱校验（默认不限制，单测用）
 * @param {() => string} [deps.getDefaultDownloadDir] 未设 prefs.saveDir 时的默认下载目录
 *   （必须与 get-default-dir 展示给 UI 的值同源；缺省回落 userData，仅单测路径）
 * @returns {Object} 引擎实例
 */
function createDownloadQueueEngine({
  userDataDir,
  progress,
  getDownloadUrlSmart,
  getLyrics,
  isSaveDirAllowed,
  getDefaultDownloadDir,
  notify = noopNotifyPort,
  history = historyDefault,
  fsa = fsaDefault,
  downloader = downloaderDefault,
  getPolicyFacts,
} = {}) {
  if (typeof userDataDir !== 'function') throw new Error('[DownloadQueue] 必须注入 userDataDir');
  if (!progress) throw new Error('[DownloadQueue] 必须注入 progress');
  if (typeof getDownloadUrlSmart !== 'function') throw new Error('[DownloadQueue] 必须注入 getDownloadUrlSmart');
  if (typeof getLyrics !== 'function') throw new Error('[DownloadQueue] 必须注入 getLyrics');
  const { downloadFileWithRetry, embedId3Tags } = downloader;
  if (typeof downloadFileWithRetry !== 'function') throw new Error('[DownloadQueue] downloader 缺少 downloadFileWithRetry');

  // ── 状态（引擎私有，通过 getter 暴露）────────────────────
  // 队列数组由 downloadQueue/store.js 持有（ADR 0003 §5 步骤 3）：这里拿到的是
  // **同一引用**，不得复制、不得重新赋值。store 每引擎一份，保证测试同进程多实例
  // 之间队列互不串扰。
  const store = storeModule.createStore();
  const downloadQueue = store.getQueue();
  // 事件侧状态（速度采样 / 进度节流时钟）全部归 downloadQueue/events.js：
  // 本文件不再持有 speedStates、lastAt 或任何合并 timer（禁止第二份节流状态）。
  // 调度状态（并发计数 / 重排定时器 / 重入标志 / 暂停标志）全部归
  // downloadQueue/scheduler.js；本文件不再持有同名变量（禁止两套调度）。

  // 持久化能力（防抖写盘 / 原子写 / 读盘 / 恢复校验）。队列数组由 queueStore 持有：
  // 只把 getQueue 的活引用注入 persist，persist 不复制、不重赋值（ADR 0003 §5 步骤 2/3）。
  const persistence = createPersistence({
    getQueue: () => downloadQueue,
    // 淘汰策略归 queueStore（步骤 3）：persist 只调用，不保留第二份实现。
    trimDone: store.trimDoneTasks,
    userDataDir,
    transition: applyStatus,
    // 淘汰后的补推只走 UI 端口，不回触 notifyQueueChanged（那会再排一次落盘，
    // 防抖自激）。端口抛错由 guardPort 兜住，不得影响写盘。
    onTrim: (rows) => guardPort(() => progress.emitQueueUpdated(rows), 'emitQueueUpdated'),
    logger,
  });
  const { persistQueue, loadPersistedQueue } = persistence;

  // 事件出口（ADR 0003 §5 步骤 5）：队列快照推送 → 落盘的顺序、120ms 进度节流、
  // 100% 必发、速度采样全部封在 events 内部。本文件只保留这一个实例；
  // 所有调用点一律走 events.notifyQueueChanged / events.makeOnProgress / events.forget。
  const events = eventsModule.createEvents({
    getQueue: () => downloadQueue,
    progress,
    persistQueue,
  });

  /**
   * Quality-policy evaluation (3-C) -- pure function + injected external facts.
   *
   * Why facts are injected: the evaluator is a pure function, so "which artists/albums
   * already exist locally" must come from the caller, keeping unit tests free of
   * Electron and disk. With no getPolicyFacts injected, ctx is empty => already_have
   * simply does not match (prefer not acting over acting wrongly); other rules still apply.
   *
   * prefs read failure degrades to "no rules": one bad rule must never stall the queue.
   */
  async function evaluatePolicy(song) {
    const keep = { action: 'keep', quality: normalizeQuality(song.quality), ruleId: null, reason: '' };
    let rules = null;
    try {
      rules = prefs.get('qualityPolicyRules');
    } catch (e) {
      logger.warn('[qualityPolicy] read rules failed, treat as none:', e && e.message);
      return keep;
    }
    if (!rules) return keep;

    let facts = {};
    if (typeof getPolicyFacts === 'function') {
      try {
        facts = (await getPolicyFacts(song)) || {};
      } catch (e) {
        // fact-source failure is not a rule failure: only already_have opts out this run
        logger.warn('[qualityPolicy] read local facts failed, that rule opts out:', e && e.message);
        facts = {};
      }
    }
    return evaluateQualityPolicy(rules, song, facts);
  }

  /**
   * 单曲最大尝试次数（含首次；prefs.maxAttempts，1..5，越界回落 MAX_RETRY）。
   * 每首歌协程启动时快照一次——下载中途改设置不回溯影响在途任务。
   *
   * 注：本函数留在 facade 上而非随调度迁走（ADR 0003 §5 步骤 4 原文要求 scheduler
   * 内部复用同一实现）：`engine.getMaxAttempts()` 是外部 API，且
   * test/retry-attempts-setting.test.js 的源码断言要求 `const MAX_RETRY = N` 与
   * `n >= 1 && n <= 5 ? n : MAX_RETRY` 留在 downloadQueue.js。逐曲快照由
   * downloadQueue/songTask.js 的 initContext 注入调用本函数完成（步骤 6）。
   */
  function getMaxAttempts() {
    try {
      const n = Number(prefs.get('maxAttempts'));
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : MAX_RETRY;
    } catch (_e) {
      return MAX_RETRY;
    }
  }

  // 队列变更统一出口（notifyQueueChanged）已随事件出口迁至
  // downloadQueue/events.js：签名、内部顺序（推送 → 落盘）与终态 immediate=true
  // 语义原样保留；本文件只通过 events 实例调用，不保留第二份实现。

  // ── 单曲流水线装配（ADR 0003 §5 步骤 6）───────────────────────
  // 12 个 phase 在 downloadQueue/songTask.js 里按顺序排成一条可读流水线；
  // 本文件只注入能力（状态迁移 / 事件 / 偏好 / 取流 / 歌词 / 下载器 / 历史），
  // 不持有任何单曲流程细节。getQueue 注入的是同一个活数组引用（身份不变）。
  const songTask = songTaskModule.createSongTask({
    getQueue: () => downloadQueue,
    transition: applyStatus,
    notify: events.notifyQueueChanged,
    events,
    notification: notify,
    readPrefs: (key) => prefs.get(key),
    getMaxAttempts,
    evaluatePolicy,
    getDownloadUrlSmart,
    getLyrics,
    isSaveDirAllowed,
    getDefaultDownloadDir,
    userDataDir,
    history,
    fsa,
    downloadFileWithRetry,
    embedId3Tags,
    // 退避定时器归 scheduler（`stop()` 会清掉在途等待），本文件与 songTask 都不排 timer。
    waitRetryBackoff: () => scheduler.waitRetryBackoff(),
    logger,
  });

  // ── 调度器装配（ADR 0003 §5 步骤 4）─────────────────────────────
  // 所有可变调度状态（并发计数 / 重排定时器 / 重入标志 / 暂停标志）
  // 与调度类定时器都只存在于这个实例里；依赖全部显式注入，不持有模块级单例。
  // 定时器归属：scheduler.stop() 清调度 timer，events.dispose() 清事件侧残留，
  // persistence.flush() 清防抖 timer，dispose 按序调用三者（§6.4）。
  const scheduler = schedulerModule.createScheduler({
    getQueue: () => downloadQueue,
    // processOneSong（含 _processing 的 try/finally）在 downloadQueue/songTask.js。
    runSong: (song) => songTask.processOneSong(song),
    transition: applyStatus,
    notify: events.notifyQueueChanged,
    readPrefs: (key) => prefs.get(key),
    cancelDownload: (taskId) => {
      if (typeof downloader.cancelDownload === 'function') {
        try { downloader.cancelDownload(String(taskId)); } catch (e) { logger.warn('[requestCancel]', e.message); }
      }
    },
    logger,
  });

  /**
   * 恢复之后把待下载任务重新推上调度器（2026-10-13 复审 P0-1）。
   *
   * 为什么必须是独立方法而不是顺手塞进 loadPersistedQueue：
   * 加载是「读盘 + 清洗 + 入队」的纯数据动作，调度是**行为**动作 —— 合成
   * 一个方法既没法单测「恢复后到底开没开跑」，也让「只加载不启动」这种
   * 合法用法（例如先看一眼队列再决定）变得不可能。
   *
   * 旧实现的洞：全仓 processQueue() 只在「新增单曲 / 重试 / 批量入队 /
   * 订阅自动下载 / 内部重入」这些**用户动作**里被调用，重启后恢复的 pending
   * 没人推一把 —— 界面显示「排队中 N 首」，实际一首都不下，直到用户手动
   * 加一首歌或切一次暂停/继续；只等着的用户，这些任务 24 小时后还会被
   * STALE_PENDING_MS 判死。
   *
   * error 状态**不**自动重试：失败任务的语义是「等用户决定」，
   * 自动重跑会把用户主动取消/失败的结果悄悄翻掉。
   *
   * @returns {number} 本次推上调度器的任务数
   */
  function resumeRestoredQueue() {
    // 实现在 downloadQueue/scheduler.js（读 pending 计数 → 异步推上调度器）。
    return scheduler.resumeRestoredQueue();
  }

  // 注：单曲协程本体（shouldAbort / processOneSong / 12 个 phase / userDataDirSafe）
  // 已按 ADR 0003 §8.1 外移到 downloadQueue/songTask.js（步骤 6）。
  // 本文件不再持有任何单曲流程细节，只保留上面 songTask 一个编排入口装配。

  /**
   * 调度下载队列（最多并发 N 首，N 动态读 prefs）。
   *
   * ADR 0003 §5 步骤 4：主循环、并发钳制、重入保护、暂停/恢复、空队列退出、
   * 100ms 重排定时器全部在 downloadQueue/scheduler.js；本方法只是对外入口的
   * 转调，不再保留第二套实现。
   */
  function processQueue() {
    return scheduler.processQueue();
  }

  /**
   * 取消任务（协作式）：下载中置标记 + 打断在途请求；重试等待期（status=pending
   * 但 _processing=true，协程在退避 await 中）只置标记，协程在下一轮循环顶退出。
   * @returns {boolean} 是否命中一个在途任务
   */
  function requestCancel(taskId) {
    return scheduler.requestCancel(taskId);
  }

  /** 暂停/继续调度：暂停只挡新任务启动；恢复时立即重新调度 */
  function setPaused(v) {
    scheduler.setPaused(v);
  }

  return {
    // 状态访问
    getQueue: () => downloadQueue,
    getActiveCount: () => scheduler.getActiveCount(),
    // 持久化
    persistQueue,
    loadPersistedQueue,
    resumeRestoredQueue,
    // 调度
    processQueue,
    requestCancel,
    setPaused,
    isPaused: () => scheduler.isPaused(),
    // 工具（队列 IPC 需要）
    sanitizeFilename,
    sanitizeRestoredTask,
    /**
     * 退出清理：停掉调度类定时器，并把待写的队列**立即**落盘。
     *
     * 为什么需要：persistQueue 是 500ms 防抖 —— 若退出时刚好在防抖窗口内，
     * 最后一次队列变更会丢（用户看到「下完的任务重启后不见了」）。
     * 在 window-all-closed 调用本方法可保证不丢。
     *
     * 顺序固定（ADR 0003 §6.4）：先 scheduler.stop()（清重排定时器、在途退避
     * timer、复位重入标志并竖起退出旗，防止 .finally 再拉起调度），再
     * events.dispose()（清事件侧可能残留的合并 timer / 节流采样；本步实现是
     * 前沿节流、不排 timer，但清理链必须包含它，且必须在 flush 之前 —— 事件侧
     * 若还有迟到推送，不得再排一次防抖写盘），最后 persistence.flush()（清防抖
     * timer + 立即落盘）。三者都幂等，连续调用 dispose() 不抛错、不重复写盘。
     */
    dispose() {
      scheduler.stop();
      events.dispose();
      persistence.flush();
    },
    // 常量（测试与文档引用）
    MAX_DONE_RETAINED,
    MAX_RETRY,
    MAX_RESTORED_TASKS,
    getMaxAttempts,
  };
}

module.exports = {
  createDownloadQueueEngine,
  sanitizeFilename,
  sanitizeRestoredTask,
  MAX_RESTORED_TASKS,
  QUEUE_STATUSES,
};
