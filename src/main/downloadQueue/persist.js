/**
 * 队列持久化（落盘 / 读盘 / 恢复校验）。
 *
 * 从 `src/main/downloadQueue.js` 外移（ADR 0003 §5 步骤 2）。本模块**不持有队列
 * 数组**：队列仍是主文件里的那一个活数组（`getQueue()` 返回同一引用，`index.js:447`
 * 持有它），这里只在需要时经注入的 getter 读取 —— 数组 owner 迁移到 queueStore
 * 是 §5 步骤 3 的事，本步不动，`getQueue()` 的引用身份必须保持不变。
 *
 * 迁移内容（逐字搬运，无行为变更）：
 *   - 防抖写盘（PERSIST_DEBOUNCE_MS / queuePersistTimer）与原子写（atomicWriteJson）
 *   - 落盘前调用 queueStore.trimDoneTasks()（done 淘汰策略已随数组迁至 §5 步骤 3）
 *   - 读盘与 JSON 损坏处理（safeReadJson：损坏先备份 .bak，再从空队列恢复）
 *   - 恢复时的逐条校验（sanitizeRestoredTask / QUEUE_STATUSES）与超量截断
 *     （MAX_RESTORED_TASKS）
 *
 * 状态迁移仍走注入的 transition（主文件的 applyStatus），本模块不直写 status。
 */

const path = require('path');

const defaultLogger = require('../../utils/logger');
const { atomicWriteJson, safeReadJson } = require('../../utils/atomicFile');
// 队列状态迁移的唯一真相：状态集合与合法迁移表都在 downloadQueue/statemachine.js。
// 词汇表本身来自 statemachine.STATES，这里不再手抄一遍字面量。
const statemachine = require('./statemachine');
// done 保留上限仍由 queueStore 定义（唯一来源），本模块只做 re-export。
// trim 实现本身也在 queueStore，由主文件以 trimDone 注入 —— 本模块不保留第二份。
const { MAX_DONE_RETAINED } = require('./store');

/** 重启时 pending 超过该时长未启动则标记失败，避免永久阻塞「加入新歌单」 */
const STALE_PENDING_MS = 24 * 60 * 60 * 1000;
/** 持久化防抖窗口（毫秒） */
const PERSIST_DEBOUNCE_MS = 500;
/**
 * 队列条目合法状态（持久化白名单，与状态机共用同一词汇表）。
 *
 * 词汇表本身来自 statemachine.STATES，本文件不再手抄一遍字面量。
 * 刻意排除 `cancelled`：状态机为「用户移除」定义了这个终态，但运行期的取消
 * 一律落 `error`（带"下载已取消"消息，UI 有对应渲染分支）；接受 `cancelled`
 * 反而会把一条渲染层不认识的条目从 queue.json 恢复出来。
 */
const QUEUE_STATUSES = new Set(Object.values(statemachine.STATES)
  .filter((s) => s !== statemachine.STATES.CANCELLED));
/**
 * 恢复时的条目数上限。纯粹防「被写坏/被伪造的 queue.json 撑爆内存」——
 * 正常用户量级远低于此值，触顶只会在日志里留一条 warn。
 */
const MAX_RESTORED_TASKS = 20000;

/**
 * 校验并归一化一条从磁盘恢复的任务。
 *
 * 2026-09 审计 P1：旧实现只判了「顶层是数组」就逐条 `delete item._processing`，
 * 一旦数组里混进 null / 字符串 / 缺 status 的脏对象，delete 就会抛
 * TypeError，整批恢复随之中止 —— 一条坏记录等于整个队列丢失。
 *
 * 判据刻意只认「下游真的会用到」的三件事：普通对象、有 id、status 在词汇表内。
 * 其余字段（saveDir/quality/url/…）原样保留：它们各自有消费侧的兜底，
 * 这里收紧反而会把老队列里合法的历史字段清掉。
 *
 * @returns {Object|null} 合法返回原条目（已剔除瞬态标记），非法返回 null
 */
function sanitizeRestoredTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { id, status } = raw;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  if (typeof status !== 'string' || !QUEUE_STATUSES.has(status)) return null;
  // 瞬态调度标记不应跨重启存活（持久化文件可能携带）
  delete raw._processing;
  delete raw._cancelRequested;
  return raw;
}

/**
 * 创建持久化能力。
 *
 * @param {Object} deps
 * @param {() => Object[]} deps.getQueue 返回队列**活数组**（引用必须稳定，不得复制）
 * @param {() => void} deps.trimDone 队列 done 淘汰策略（queueStore.trimDoneTasks）
 * @param {() => (string|null)} deps.userDataDir 用户数据目录（惰性，app ready 后才有值）
 * @param {(song:Object, to:string, reason?:string) => void} deps.transition 状态迁移出口（主文件 applyStatus）
 * @param {(rows:Object[]) => void} [deps.onTrim] 淘汰真的删了条目时的补推出口（只推 UI，
 *   不得回触 persistQueue —— 否则防抖自激）。缺省不推（单测/无 UI 场景）。
 * @param {Object} [deps.logger] 日志器（默认 utils/logger）
 * @returns {{
 *   persistQueue: (opts?: {immediate?: boolean}) => void,
 *   loadPersistedQueue: () => Promise<void>,
 *   flush: () => void,
 * }} 持久化实例
 */
function createPersistence({
  getQueue,
  trimDone,
  userDataDir,
  transition,
  onTrim = null,
  logger = defaultLogger,
} = {}) {
  let queuePersistTimer = null;

  const QUEUE_FILE = () => path.join(userDataDir(), 'queue.json');

  /** 立即整写队列文件（trim + 原子写）；异常吞掉并记日志 */
  function writeQueueNow() {
    try {
      const before = getQueue().length;
      trimDone();
      atomicWriteJson(QUEUE_FILE(), getQueue());
      // 淘汰原地 splice 了活数组：不补推快照，UI 会停在淘汰前的条数，
      // 与磁盘脱节（重启后任务「凭空消失」）。只在真删了条目时推。
      if (getQueue().length !== before && typeof onTrim === 'function') onTrim(getQueue());
    } catch (e) {
      logger.warn('队列持久化失败:', e.message);
    }
  }

  /**
   * 持久化：默认 500ms 防抖合并（进度/入队等高频变更）；
   * { immediate: true } 用于 done/error **终态** —— 终态丢在防抖窗口里
   * 意味着崩溃后「已完成的任务消失 / 回到下载中」，必须绕开防抖立即落盘。
   */
  function persistQueue(opts) {
    if (opts && opts.immediate) {
      if (queuePersistTimer) {
        clearTimeout(queuePersistTimer);
        queuePersistTimer = null;
      }
      writeQueueNow();
      return;
    }
    if (queuePersistTimer) return;
    queuePersistTimer = setTimeout(() => {
      queuePersistTimer = null;
      writeQueueNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** 启动时加载队列（异常关闭后恢复；损坏文件备份 .bak 后放弃） */
  async function loadPersistedQueue() {
    try {
      const downloadQueue = getQueue();
      const res = safeReadJson(QUEUE_FILE());
      if (!res.ok) {
        logger.warn('队列文件损坏，已备份为 queue.json.bak，从空队列恢复');
        return;
      }
      if (res.empty) return;
      const list = res.data;
      if (!Array.isArray(list)) return;
      // 重启时：downloading 视为异常关闭 -> error
      //         pending 超过 1 天没动 -> error（避免阻塞"加入新歌单"）
      //         pending 不到 1 天 / error / done -> 保留
      const now = Date.now();
      let dropped = 0;
      for (const raw of list) {
        if (downloadQueue.length >= MAX_RESTORED_TASKS) { dropped++; continue; }
        // 逐条校验：一条脏记录只丢它自己，绝不中止整批恢复
        const item = sanitizeRestoredTask(raw);
        if (!item) { dropped++; continue; }
        if (item.status === 'downloading') {
          // 异常关闭：downloading → error（与运行期同一条迁移规则）
          transition(item, 'error', '应用异常关闭');
          item.error = '应用异常关闭，请重试';
        } else if (item.status === 'pending' && item.addedAt && (now - item.addedAt > STALE_PENDING_MS)) {
          // 排队超时：pending → error
          transition(item, 'error', '排队超时');
          item.error = '排队超过 24 小时未启动，已标记失败（可重试）';
        }
        downloadQueue.push(item);
      }
      if (dropped) {
        logger.warn(`[Queue] 丢弃 ${dropped} 条非法/超限队列条目（其余 ${downloadQueue.length} 条照常恢复）`);
      }
      if (downloadQueue.length) {
        logger.log(`[Queue] 从磁盘恢复 ${downloadQueue.length} 个任务`);
      }
    } catch (e) {
      logger.warn('队列加载失败:', e.message);
    }
  }

  /**
   * 退出清理：把防抖窗口内的队列**立即**落盘。
   *
   * 为什么需要：persistQueue 是 500ms 防抖 —— 若退出时刚好在防抖窗口内，
   * 最后一次队列变更会丢（用户看到「下完的任务重启后不见了」）。
   */
  function flush() {
    if (queuePersistTimer) {
      clearTimeout(queuePersistTimer);
      queuePersistTimer = null;
      try {
        trimDone();
        atomicWriteJson(QUEUE_FILE(), getQueue());
      } catch (e) {
        logger.warn('[DownloadQueue] 退出落盘失败:', e.message);
      }
    }
  }

  return {
    persistQueue,
    loadPersistedQueue,
    flush,
  };
}

module.exports = {
  createPersistence,
  sanitizeRestoredTask,
  MAX_RESTORED_TASKS,
  QUEUE_STATUSES,
  MAX_DONE_RETAINED,
};