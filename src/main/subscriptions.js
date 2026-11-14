/**
 * 订阅更新引擎（分层重构版）
 *
 * 用户在歌单弹窗 / 歌手主页点「订阅」后，本模块周期性拉取目标曲目，
 * 与上次快照做差集得到「新增歌曲」，可选自动加入下载队列。
 *
 * 存储：prefs.json 的 'subscriptions' 键（随云同步备份，无需独立文件）。
 * 条目形状见 makeEntry。
 *
 * 分层：
 *   - domain/ 纯业务逻辑（零 I/O，零 electron/context/safeSend）
 *   - infra/  基础设施适配器（prefs / api / history / logger / 队列）
 *   - 本层（service）：组装 domain + infra，持有调度器与 safeSend 出口
 *
 * 构造注入：createSubscriptions(deps = {})，缺失依赖时回退到模块默认值，
 * 保持 `require('../subscriptions')` 的向后兼容单例导出。
 *
 * 设计约束（踩过的坑）：
 *   - gateway 失败时静默返回 []，不能把「本次拉取为空」当作「曲目被删光」，
 *     否则网络抖动会让老歌全部重新变「新增」。故 lastSeenIds 用**并集**语义，
 *     只进不出。
 *   - 首次检查静默播种（seed）：只记快照不产新增，避免订阅瞬间刷屏 +
 *     autoDownload 把整个歌单灌进队列。
 * - 「空清单」不等于「检查成功」：gateway 对缺能力/需登录/VIP
 *     歌单一律静默返回 []，若照单全收就会把首次播种播成空快照（下一次真数据
 *     到达时整单变「新增」，正是本文件头一条要防的刷屏）。判定收成
 *     applyCheckToEntry 一家：空/非数组只记账，不碰快照与未读。
 *   - 调度器与 playCache GC 同风格：unref 定时器，不阻止进程退出。
 *   - 检查间隔是用户可设的档位（设置页写 subscriptionCheckIntervalHours），本模块
 *     只信"有限、正数、夹在可用区间内"三个条件；不信任输入，因为写入口是 IPC 边界。
 */

const api = require('../api');
const prefs = require('../utils/prefs');
const logger = require('../utils/logger');
const { safeSend: contextSafeSend } = require('./context');

const { createDomain } = require('./ipc/subscriptions/domain');
const { createInfra } = require('./ipc/subscriptions/infra');

const MAX_NEW_SONGS = 100;          // 单订阅保留的新歌列表上限（防 prefs.json 膨胀）
const PLAYLIST_LIMIT = 200;
const SINGER_LIMIT = 50;
const DEFAULT_CHECK_INTERVAL_HOURS = 6;
// 间隔可由用户在设置页改（subscriptionCheckIntervalHours），夹在这里而不是信任输入：
// 下限取调度器醒来粒度的整数倍（比这更快也更快不了，等于给用户一个假档位），
// 上限一星期（再大就事实上关掉了自动检查，却没有任何地方写着"已关闭"）。
const MIN_CHECK_INTERVAL_HOURS = 1;
const MAX_CHECK_INTERVAL_HOURS = 168;
const INITIAL_CHECK_DELAY_MS = 30 * 1000;
const CHECK_TICK_MS = 60 * 1000;    // 调度器醒来的粒度
/** 一次"什么都没取到"的检查对用户说的那句话（渲染层直接显示，与 main 侧其它中文文案同源） */
const EMPTY_CHECK_ERROR = '未取到任何曲目（可能需要登录，或该歌单/歌手页受限）';

/**
 * 创建订阅服务实例。
 *
 * @param {object} [deps]
 * @param {object} [deps.domain]   domain 实例（缺省 createDomain({ getPlugin })）
 * @param {object} [deps.infra]    infra 实例（缺省 createInfra({...}））
 * @param {Function} [deps.safeSend] 渲染层推送（缺省 context.safeSend）
 * @param {Function} [deps.getPlugin] 平台插件查找回调（缺省 api.registry.get）
 * @param {Function} [deps.getIntervalHours] 检查间隔小时数回调（缺省 prefs 读）
 * @param {Function} [deps.getQueue] 取下载队列数组（用于 queue-updated 推送快照）
 * @returns {{list, add, remove, update, markSeen, checkNow, unreadCount, startScheduler, stopScheduler, runCheck, _internal}}
 */
function createSubscriptions(deps = {}) {
  const {
    domain: depsDomain,
    infra: depsInfra,
    safeSend: depsSafeSend,
    getPlugin: depsGetPlugin,
    getIntervalHours: depsGetIntervalHours,
    getQueue: depsGetQueue,
  } = deps;

  const getPlugin = typeof depsGetPlugin === 'function'
    ? depsGetPlugin
    : (platform => api.registry.get(platform));
  const getIntervalHours = typeof depsGetIntervalHours === 'function'
    ? depsGetIntervalHours
    : () => prefs.get('subscriptionCheckIntervalHours', DEFAULT_CHECK_INTERVAL_HOURS);
  const safeSend = typeof depsSafeSend === 'function' ? depsSafeSend : contextSafeSend;
  const getQueue = typeof depsGetQueue === 'function' ? depsGetQueue : null;

  const domain = depsDomain || createDomain({ getPlugin });
  const infra = depsInfra || createInfra({
    queue: {
      getQueue: depsGetQueue,
      persistQueue: deps.persistQueue,
      processQueue: deps.processQueue,
      // safeSend('queue-updated') 由本 service 层统一推送，不下放给 infra，避免重复推送
    },
  });

  const {
    loadAll,
    saveAll,
    autoEnqueue: infraAutoEnqueue,
  } = infra;

  const {
    list: domainList,
    add: domainAdd,
    remove: domainRemove,
    update: domainUpdate,
    markSeen: domainMarkSeen,
    unreadCount: domainUnreadCount,
    validateAdd: domainValidateAdd,
    diffSongs: domainDiffSongs,
    applyCheckToEntry: domainApplyCheckToEntry,
    makeEntry: domainMakeEntry,
    buildKey: domainBuildKey,
    _intervalMs: domainIntervalMs,
  } = domain;

  // ── 接线钉：applyCheckToEntry 在本文件中定义一次、在 runCheck 中调用一次（共 2 处出现）
  function applyCheckToEntry(entry, songs, now) {
    return domainApplyCheckToEntry(entry, songs, now);
  }

  /** 发给渲染层的订阅列表更新。 */
  function _emit() {
    safeSend('subscriptions-updated', _listView());
  }

  /** 发给渲染层的瘦身视图：新歌只留 DTO 必要字段。 */
  function _listView() {
    return loadAll().map(e => ({
      key: e.key,
      type: e.type,
      platform: e.platform,
      targetId: e.targetId,
      name: e.name,
      hasSeeded: e.lastSeenIds !== null && e.lastSeenIds !== undefined,
      lastCheckedAt: e.lastCheckedAt || null,
      lastCheckError: e.lastCheckError || '',
      newCount: (e.newSongs || []).length,
      newSongs: (e.newSongs || []).slice(0, MAX_NEW_SONGS),
      autoDownload: !!e.autoDownload,
      addedAt: e.addedAt || null,
    }));
  }

  /**
   * 把新增歌曲排进下载队列，并推送 queue-updated 给渲染层。
   * @returns {Promise<number>} 实际入队数
   */
  async function _autoEnqueue(entry, fresh) {
    const queued = await infraAutoEnqueue(entry, fresh);
    if (queued > 0 && typeof safeSend === 'function' && typeof getQueue === 'function') {
      safeSend('queue-updated', getQueue());
    }
    return queued;
  }

  // ── 调度器 ─────────────────────────────────────────────────

  let _timer = null;
  let _checking = false;

  // ── 拉取 ─────────────────────────────────────────────────

  /**
   * 拉取订阅条目对应的歌曲列表（保留旧实现形状，供源码接线钉）。
   * @param {object} entry
   * @returns {Promise<Array<object>>}
   */
  async function _fetchSongs(entry) {
    if (entry.type === 'playlist') {
      return await api.getPlaylistSongs(entry.platform, entry.targetId, PLAYLIST_LIMIT);
    }
    // platform 必须透传：门面缺省会按 id 形态猜平台，数字 mid 的歌手会被路由错源
    return await api.getSingerSongs(entry.targetId, SINGER_LIMIT, entry.platform);
  }

  /**
   * 检查一批订阅（顺序执行，避免同时打多个平台接口触发风控）。
   * @param {boolean} force true = 全部；false = 只查到期项
   * @returns {Promise<{checked:number, newTotal:number}>}
   */
  async function runCheck(force = false) {
    if (_checking) return { checked: 0, newTotal: 0, skipped: true };
    _checking = true;
    const started = Date.now();
    let checked = 0;
    let newTotal = 0;
    try {
      const entries = loadAll();
      let changed = false;
      for (const entry of entries) {
        if (!force && !_isDue(entry, started)) continue;
        checked++;
        try {
          const songs = await _fetchSongs(entry);
          const r = applyCheckToEntry(entry, songs, Date.now());
          Object.assign(entry, r.entry);
          // await：_autoEnqueue 现在是 async（第二级去重走异步判活）
          if (r.toEnqueue.length) await _autoEnqueue(entry, r.toEnqueue);
          newTotal += r.freshCount;
          changed = true;
        } catch (e) {
          // 抛错当瞬时故障：不动 lastCheckedAt（从未成功过的项下个 tick 即重试，成功过的按原间隔再来）。
          // 空清单则是稳定状态（受限歌单/未登录），重试再快也拿不到东西，故按检查间隔退避。
          // 空清单路径的 lastCheckedAt 推进由 applyCheckToEntry 一家负责，此处不碰。
          entry.lastCheckError = (e && e.message) || '检查失败';
          changed = true;
          logger.warn(`[subscriptions] ${entry.key} 检查失败:`, e.message);
        }
      }
      if (changed) {
        saveAll(entries);
        _emit();
      }
    } finally {
      _checking = false;
    }
    return { checked, newTotal };
  }

  function _intervalMs() {
    return domainIntervalMs(getIntervalHours);
  }

  function _isDue(entry, now) {
    return !entry.lastCheckedAt || (now - entry.lastCheckedAt) >= _intervalMs();
  }

  function startScheduler() {
    if (_timer) return;
    const initial = setTimeout(() => {
      runCheck(false).catch(e => logger.warn('[subscriptions] 周期检查失败:', e.message));
    }, INITIAL_CHECK_DELAY_MS);
    if (initial.unref) initial.unref();
    _timer = setInterval(() => {
      runCheck(false).catch(e => logger.warn('[subscriptions] 周期检查失败:', e.message));
    }, CHECK_TICK_MS);
    if (_timer.unref) _timer.unref();
  }

  function stopScheduler() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  // ── 对外操作（ipc/subscriptions.js 调用）─────────────────

  function list() {
    return domainList(loadAll());
  }

  function add(type, platform, targetId, name) {
    const r = domainAdd(loadAll(), type, platform, targetId, name);
    if (!r.success) return r;
    saveAll(r.entries);
    _emit();
    return { success: true, entry: r.entry, duplicated: r.duplicated };
  }

  function remove(key) {
    const r = domainRemove(loadAll(), key);
    if (!r.success) return r;
    saveAll(r.entries);
    _emit();
    return { success: true };
  }

  /** patch 白名单：目前只允许切换 autoDownload */
  function update(key, patch) {
    const r = domainUpdate(loadAll(), key, patch);
    if (!r.success) return r;
    saveAll(r.entries);
    _emit();
    return { success: true, entry: r.entry };
  }

  /** 用户看完新歌后清空红点 */
  function markSeen(key) {
    const r = domainMarkSeen(loadAll(), key);
    if (!r.success) return r;
    saveAll(r.entries);
    _emit();
    return { success: true };
  }

  function checkNow() {
    return runCheck(true);
  }

  /** 导航红点总数：所有订阅未读新歌之和 */
  function unreadCount() {
    return domainUnreadCount(loadAll());
  }

  return {
    list, add, remove, update, markSeen, checkNow, unreadCount,
    startScheduler, stopScheduler, runCheck,
    _internal: {
      buildKey: domainBuildKey,
      validateAdd: (type, platform, targetId) => domainValidateAdd(type, platform, targetId, getPlugin),
      diffSongs: domainDiffSongs,
      applyCheckToEntry,
      makeEntry: domainMakeEntry,
      _isDue,
      _intervalMs,
      MAX_NEW_SONGS,
      EMPTY_CHECK_ERROR,
      CHECK_TICK_MS,
      DEFAULT_CHECK_INTERVAL_HOURS,
      MIN_CHECK_INTERVAL_HOURS,
      MAX_CHECK_INTERVAL_HOURS,
    },
  };
}

// 默认单例：保持 `require('../subscriptions')` 的向后兼容
const defaultSubs = createSubscriptions();

module.exports = {
  createSubscriptions,
  ...defaultSubs,
  _internal: defaultSubs._internal,
};
