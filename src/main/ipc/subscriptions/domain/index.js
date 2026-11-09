/**
 * 订阅域 —— 纯业务逻辑层（domain）
 *
 * 设计约束：零外部依赖。不 require electron、不 require context、
 * 不 require safeSend、不 require api/prefs/history/logger。
 * 所有函数均为纯函数，或仅依赖显式传入的参数/回调。
 *
 * 由 service 层（src/main/subscriptions.js）组装使用，由 infra 层
 * 提供 getPlugin / getIntervalHours 等外部能力的回调。
 */

// ── 常量 ─────────────────────────────────────────────────────

const MAX_NEW_SONGS = 100;          // 单订阅保留的新歌列表上限（防 prefs.json 膨胀）
const PLAYLIST_LIMIT = 200;
const SINGER_LIMIT = 50;
const DEFAULT_CHECK_INTERVAL_HOURS = 6;
const MIN_CHECK_INTERVAL_HOURS = 1;
const MAX_CHECK_INTERVAL_HOURS = 168;
const INITIAL_CHECK_DELAY_MS = 30 * 1000;
const CHECK_TICK_MS = 60 * 1000;    // 调度器醒来的粒度
/** 一次"什么都没取到"的检查对用户说的那句话（渲染层直接显示） */
const EMPTY_CHECK_ERROR = '未取到任何曲目（可能需要登录，或该歌单/歌手页受限）';

const TYPES = new Set(['playlist', 'singer']);

// ── 纯函数 ───────────────────────────────────────────────────

function buildKey(type, platform, targetId) {
  return `${type}:${platform}:${targetId}`;
}

/**
 * 校验订阅参数并给出用户可见的错误文案。
 * @param {string} type
 * @param {string} platform
 * @param {string} targetId
 * @param {Function} [getPlugin] 平台插件查找回调，缺省时不做平台能力校验
 * @returns {string|null} null = 合法
 */
function validateAdd(type, platform, targetId, getPlugin) {
  if (!TYPES.has(type)) return '不支持的订阅类型';
  if (!platform || !targetId) return '参数不完整';
  if (typeof getPlugin === 'function') {
    const plugin = getPlugin(platform);
    if (!plugin) return `未知平台: ${platform}`;
    if (type === 'playlist' && typeof plugin.getPlaylistSongs !== 'function') {
      return `${platform} 暂不支持歌单订阅`;
    }
    if (type === 'singer' && typeof plugin.getSingerSongs !== 'function') {
      return `${platform} 暂不支持歌手订阅`;
    }
  }
  return null;
}

/**
 * 与上次快照求差集。
 * @param {Array<object>} songs 本次拉取结果
 * @param {string[]|null} lastSeenIds null = 从未检查过（静默播种）
 * @param {number} [cap] 新增列表截断上限
 * @returns {{fresh: Array<object>, seenIds: string[], seeded: boolean}}
 */
function diffSongs(songs, lastSeenIds, cap = MAX_NEW_SONGS) {
  const list = Array.isArray(songs) ? songs.filter(s => s && s.id != null && s.id !== '') : [];
  const currentIds = list.map(s => String(s.id));
  if (lastSeenIds === null || lastSeenIds === undefined) {
    return { fresh: [], seenIds: Array.from(new Set(currentIds)), seeded: true };
  }
  const seen = new Set(lastSeenIds.map(String));
  const fresh = [];
  for (const s of list) {
    if (!seen.has(String(s.id))) {
      seen.add(String(s.id));       // 同批内重复 id 只算一次新增
      fresh.push(s);
    }
  }
  // 并集语义：只进不出，平台抽风返回空列表不会让老歌复活成「新增」
  const merged = [];
  for (const id of lastSeenIds.map(String)) if (!merged.includes(id)) merged.push(id);
  for (const id of currentIds) if (!merged.includes(id)) merged.push(id);
  return { fresh: fresh.slice(0, cap), seenIds: merged, seeded: false };
}

/**
 * 一次检查的写回（纯函数，无 I/O）。
 * 空数组 / 非数组 = 这次没取到数据 —— 只写 lastCheckError 并推进 lastCheckedAt，
 * 快照与未读红点一字不动。
 * @param {object} entry
 * @param {Array<object>} songs
 * @param {number} now
 * @returns {{entry: object, freshCount: number, toEnqueue: Array<object>, empty: boolean}}
 */
function applyCheckToEntry(entry, songs, now) {
  const next = { ...entry };
  if (!Array.isArray(songs) || songs.length === 0) {
    next.lastCheckError = EMPTY_CHECK_ERROR;
    next.lastCheckedAt = now;
    return { entry: next, freshCount: 0, toEnqueue: [], empty: true };
  }
  const { fresh, seenIds, seeded } = diffSongs(songs, entry.lastSeenIds);
  next.lastSeenIds = seenIds;
  next.lastCheckedAt = now;
  next.lastCheckError = '';
  if (seeded) return { entry: next, freshCount: 0, toEnqueue: [], empty: false };
  next.newSongs = fresh.slice(-MAX_NEW_SONGS).reverse();   // 新的在前
  const toEnqueue = entry.autoDownload ? fresh : [];
  return { entry: next, freshCount: fresh.length, toEnqueue, empty: false };
}

function makeEntry(type, platform, targetId, name) {
  return {
    key: buildKey(type, platform, targetId),
    type,
    platform,
    targetId: String(targetId),
    name: String(name || ''),
    lastSeenIds: null,              // null = 尚未播种
    lastCheckedAt: null,
    lastCheckError: '',
    newSongs: [],
    autoDownload: false,
    addedAt: Date.now(),
  };
}

/**
 * 判断订阅是否到期检查。
 * @param {object} entry
 * @param {number} now
 * @param {number} intervalMs
 * @returns {boolean}
 */
function _isDue(entry, now, intervalMs) {
  return !entry.lastCheckedAt || (now - entry.lastCheckedAt) >= intervalMs;
}

/**
 * 将用户设置的检查间隔（小时）换算为毫秒，并夹入合法区间。
 * @param {Function} [getIntervalHours] 返回间隔小时数的回调，缺省使用默认值
 * @returns {number}
 */
function _intervalMs(getIntervalHours) {
  const raw = Number(getIntervalHours ? getIntervalHours() : DEFAULT_CHECK_INTERVAL_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHECK_INTERVAL_HOURS;
  return Math.min(MAX_CHECK_INTERVAL_HOURS, Math.max(MIN_CHECK_INTERVAL_HOURS, hours)) * 3600 * 1000;
}

/** 发给渲染层的瘦身视图：新歌只留 DTO 必要字段 */
function toListView(entries) {
  return (Array.isArray(entries) ? entries : []).map(e => ({
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
 * 创建 domain 工厂（纯逻辑集合操作，接收 entries 数组，不做 I/O）。
 * @param {object} [deps]
 * @param {Function} [deps.getPlugin] 平台插件查找回调
 */
function createDomain(deps = {}) {
  const getPlugin = typeof deps.getPlugin === 'function' ? deps.getPlugin : null;

  function list(entries) {
    return toListView(entries);
  }

  function add(entries, type, platform, targetId, name) {
    const t = String(type || '');
    const p = String(platform || '');
    const id = String(targetId || '');
    const err = validateAdd(t, p, id, getPlugin);
    if (err) return { success: false, error: err, entries };
    const key = buildKey(t, p, id);
    const existing = entries.find(e => e.key === key);
    if (existing) return { success: true, entry: existing, duplicated: true, entries };
    const entry = makeEntry(t, p, id, name);
    return { success: true, entry, entries: entries.concat(entry) };
  }

  function remove(entries, key) {
    const next = entries.filter(e => e.key !== key);
    if (next.length === entries.length) return { success: false, error: '订阅不存在', entries };
    return { success: true, entries: next };
  }

  /** patch 白名单：目前只允许切换 autoDownload */
  function update(entries, key, patch) {
    const idx = entries.findIndex(e => e.key === key);
    if (idx < 0) return { success: false, error: '订阅不存在', entries };
    const entry = { ...entries[idx] };
    if (patch && typeof patch === 'object' && typeof patch.autoDownload === 'boolean') {
      entry.autoDownload = patch.autoDownload;
    }
    const next = entries.slice();
    next[idx] = entry;
    return { success: true, entry, entries: next };
  }

  /** 用户看完新歌后清空红点 */
  function markSeen(entries, key) {
    const idx = entries.findIndex(e => e.key === key);
    if (idx < 0) return { success: false, error: '订阅不存在', entries };
    const entry = { ...entries[idx], newSongs: [] };
    const next = entries.slice();
    next[idx] = entry;
    return { success: true, entry, entries: next };
  }

  /** 导航红点总数：所有订阅未读新歌之和 */
  function unreadCount(entries) {
    return (Array.isArray(entries) ? entries : []).reduce((n, e) => n + (e.newSongs || []).length, 0);
  }

  return {
    list, add, remove, update, markSeen, unreadCount,
    buildKey, validateAdd, diffSongs, applyCheckToEntry, makeEntry, _isDue, _intervalMs, toListView,
  };
}

module.exports = {
  createDomain,
  buildKey,
  validateAdd,
  diffSongs,
  applyCheckToEntry,
  makeEntry,
  _isDue,
  _intervalMs,
  toListView,
  MAX_NEW_SONGS,
  PLAYLIST_LIMIT,
  SINGER_LIMIT,
  EMPTY_CHECK_ERROR,
  CHECK_TICK_MS,
  INITIAL_CHECK_DELAY_MS,
  DEFAULT_CHECK_INTERVAL_HOURS,
  MIN_CHECK_INTERVAL_HOURS,
  MAX_CHECK_INTERVAL_HOURS,
  TYPES,
};
