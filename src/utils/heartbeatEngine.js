/**
 * 心动模式（Heartbeat Mode）算法核
 *
 * 一句话：播放队列自然播完时，基于「当前歌曲 + 红心收藏」生成一批相似歌，
 * 追加到队尾继续播 —— 只追加、不替换，用户随时可以停。
 *
 * 为什么放在主进程：种子来自红心歌单（prefs），候选来自 8 源网关，
 * 这两样都只在主进程里；算法本身是纯函数，网关通过参数注入，
 * 于是「拉取 — 打分 — 去重 — 截断」可以在单测里拿假网关跑满所有分支。
 *
 * 失败隔离：任何一个平台/歌手拉取失败都只退化为空列表，不阻塞其余候选；
 * 全失败时返回空数组，渲染层据此保持「队列播完即停」的旧行为。
 *
 * 打分（与设计稿一致，单位是「名次分」）：
 *   - 候选歌手 === 当前歌手        → 5 分
 *   - 候选歌手 ∈ 红心歌手         → 1.5 分
 *   - 候选歌手包含当前歌手（合作曲）→ 2 分
 *   - 来自热歌榜                   → +2
 *   - 与当前歌曲同源               → ×1.2
 * 红心为空且无当前歌曲时，所有候选都只有榜单分 —— 热歌榜自然胜出，
 * 这正是没有种子时期望的回落行为。
 */

const logger = require('./logger');

/** 当前歌曲歌手的权重（最强锚点） */
const CURRENT_ARTIST_WEIGHT = 5;
/** 红心歌单歌手的权重 */
const FAVORITE_ARTIST_WEIGHT = 1.5;
/** 合作曲/包含匹配的权重 */
const PARTIAL_MATCH_SCORE = 2;
/** 热歌榜命中加分 */
const TOPLIST_BONUS = 2;
/** 与当前歌曲同源的乘数 */
const SAME_SOURCE_FACTOR = 1.2;

/** 红心歌手最多取多少个做种子 */
const MAX_SEED_ARTISTS = 20;
/** 每个种子歌手最多解析几个平台（避免一次问候全部 8 源） */
const MAX_SINGER_SOURCES = 3;
/** 真正发起「歌手热门」请求的种子歌手数上限（当前歌手除外） */
const MAX_FAVORITE_SINGER_FETCH = 5;
const CURRENT_SINGER_LIMIT = 30;
const FAVORITE_SINGER_LIMIT = 10;
/** 单次最多返回多少首 */
const FINAL_LIMIT = 30;

/**
 * 首页推荐里哪些区块算「热歌榜」。
 * 路径与 api/recommendations.js#getHomeRecommendations 的返回结构同源，
 * 该结构变化时这里会静默少算榜单分（不会崩），由 test/heartbeatEngine 的
 * 「榜单加权」用例在改动时提醒。
 */
const TOPLIST_PATHS = [
  ['netease', 'hot'],
  ['qq', 'topList'],
  ['kugou', 'hot'],
  ['kugou', 'top500'],
];

function songKey(song) {
  if (!song) return '';
  const id = song.id === null || song.id === undefined ? '' : String(song.id);
  const source = song.source === null || song.source === undefined ? '' : String(song.source);
  if (!id || !source) return '';
  return `${id}:${source}`;
}

function artistOf(song) {
  return song && typeof song.artist === 'string' ? song.artist.trim() : '';
}

async function safeCall(label, fn, fallback) {
  try {
    const r = await fn();
    return r == null ? fallback : r;
  } catch (e) {
    logger.warn(`[heartbeat] ${label} 失败:`, e.message || e);
    return fallback;
  }
}

/**
 * 从当前歌曲与红心歌单提取种子歌手及权重。
 *
 * @param {{artist?: string, source?: string}|null} currentSong
 * @param {Array<{artist?: string}>} favorites
 * @returns {{current: string, favorites: string[], weights: Map<string, number>, currentSource: string}}
 */
function extractSeedArtists(currentSong, favorites) {
  const weights = new Map();
  const current = artistOf(currentSong);
  const currentSource = currentSong && currentSong.source ? String(currentSong.source) : '';

  if (current) weights.set(current, CURRENT_ARTIST_WEIGHT);

  const favArtists = [];
  if (Array.isArray(favorites)) {
    for (const fav of favorites) {
      const artist = artistOf(fav);
      if (!artist || artist === current || weights.has(artist)) continue;
      weights.set(artist, FAVORITE_ARTIST_WEIGHT);
      favArtists.push(artist);
      if (favArtists.length >= MAX_SEED_ARTISTS) break;
    }
  }

  return { current, favorites: favArtists, weights, currentSource };
}

/**
 * 为单首候选打分。
 *
 * @param {{artist?: string, source?: string}} song
 * @param {ReturnType<typeof extractSeedArtists>} seed
 * @param {{onTopList?: boolean}} [flags]
 * @returns {number}
 */
function scoreSong(song, seed, flags = {}) {
  const artist = artistOf(song);
  if (!artist) return 0;

  let artistScore = 0;
  if (seed && seed.weights && seed.weights.has(artist)) {
    artistScore = seed.weights.get(artist);
  } else if (seed && seed.current && artist.includes(seed.current)) {
    // 合作曲：「周杰伦 / 某歌手」也应算当前歌手的强相关，但弱于全等
    artistScore = PARTIAL_MATCH_SCORE;
  }

  let score = artistScore;
  if (flags.onTopList) score += TOPLIST_BONUS;

  // 同源偏好只在「与种子歌手相关」时生效：无关歌曲的榜单分不该被当前源放大
  if (seed && seed.currentSource && String(song.source || '') === seed.currentSource && artistScore > 0) {
    score *= SAME_SOURCE_FACTOR;
  }

  return Math.round(score * 100) / 100;
}

/**
 * 解析一个歌手在某平台上的热门单曲。
 *
 * 网关的 getSingerSongs 认的是平台内的 singer mid（不是歌手名），所以先
 * searchSinger 拿到各平台的 mid，再逐平台取歌。平台数限 MAX_SINGER_SOURCES，
 * 一个平台失败不影响其余平台。
 *
 * @param {object} gateway
 * @param {string} artist
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function singerSongsFor(gateway, artist, limit) {
  const r = await safeCall(
    `searchSinger:${artist}`,
    () => (typeof gateway.searchSinger === 'function' ? gateway.searchSinger(artist) : null),
    null,
  );
  const singers = Array.isArray(r) ? r : (r && Array.isArray(r.singers) ? r.singers : []);

  const picked = [];
  for (const s of singers) {
    if (!s || !s.mid || !s.source) continue;
    if (picked.some((x) => String(x.source) === String(s.source))) continue;
    picked.push(s);
    if (picked.length >= MAX_SINGER_SOURCES) break;
  }

  const lists = await Promise.all(picked.map((s) => safeCall(
    `singerSongs:${artist}@${s.source}`,
    () => gateway.getSingerSongs(s.mid, limit, s.source),
    [],
  )));
  return lists.flat().filter(Boolean);
}

/**
 * 从首页推荐结果里收集热歌榜候选。
 * 结构不对（平台失败时是空对象/缺键）就跳过，不抛错。
 */
function collectToplist(rec) {
  const out = [];
  if (!rec || typeof rec !== 'object') return out;
  for (const [platform, section] of TOPLIST_PATHS) {
    const bucket = rec[platform];
    const arr = bucket && Array.isArray(bucket[section]) ? bucket[section] : [];
    for (const s of arr) {
      if (s && typeof s === 'object') out.push({ song: s, onTopList: true });
    }
  }
  return out;
}

/**
 * 心动模式主流程。
 *
 * @param {{
 *   currentSong?: object|null,
 *   favorites?: Array<object>,
 *   exclude?: Array<object>,     // 调用方额外要排除的歌（当前播放队列等）
 *   gateway: { getHomeRecommendations?: Function, searchSinger?: Function, getSingerSongs?: Function },
 *   limit?: number,
 * }} params
 * @returns {Promise<Array<object>>} 规范化后的候选歌（带 score），最多 limit 首
 */
async function generate({ currentSong = null, favorites = [], exclude = [], gateway, limit = FINAL_LIMIT } = {}) {
  if (!gateway || typeof gateway !== 'object') {
    throw new Error('heartbeat.generate: 缺少 gateway');
  }

  const seed = extractSeedArtists(currentSong, favorites);
  const wanted = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), FINAL_LIMIT)) : FINAL_LIMIT;

  // 排除集：当前歌 + 红心 + 调用方给的队列。先把 key 一次性建好，
  // 后面每个候选只做一次 Set 查询。
  const excluded = new Set();
  for (const s of [currentSong, ...(Array.isArray(favorites) ? favorites : []), ...(Array.isArray(exclude) ? exclude : [])]) {
    const k = songKey(s);
    if (k) excluded.add(k);
  }

  // 1) 并行拉候选：首页榜单（兜底）+ 当前歌手 + 红心歌手（限 5 个）
  const currentSingerPromise = seed.current
    ? singerSongsFor(gateway, seed.current, CURRENT_SINGER_LIMIT)
    : Promise.resolve([]);
  const favoriteSingerPromises = seed.favorites
    .slice(0, MAX_FAVORITE_SINGER_FETCH)
    .map((name) => singerSongsFor(gateway, name, FAVORITE_SINGER_LIMIT));

  const [rec, currentSingerSongs, ...favoriteSingerSongs] = await Promise.all([
    safeCall('homeRecommendations', () => (
      typeof gateway.getHomeRecommendations === 'function' ? gateway.getHomeRecommendations() : {}
    ), {}),
    currentSingerPromise,
    ...favoriteSingerPromises,
  ]);

  // 2) 合并候选（榜单与非榜单分开打标，供打分用）
  const candidates = [
    ...collectToplist(rec),
    ...currentSingerSongs.map((song) => ({ song, onTopList: false })),
  ];
  for (const list of favoriteSingerSongs) {
    for (const song of list) candidates.push({ song, onTopList: false });
  }

  // 3) 排除 + 去重 + 打分
  const seen = new Set();
  const scored = [];
  for (const { song, onTopList } of candidates) {
    const key = songKey(song);
    if (!key || excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    scored.push({ song, score: scoreSong(song, seed, { onTopList }) });
  }

  // 4) 稳定排序（同分保持「榜单在前」的收集顺序）
  scored.sort((a, b) => b.score - a.score);

  // 5) 截断并保留平台扩展字段（fee/pay/mid 等下游仍要用），只去掉内部标记
  return scored.slice(0, wanted).map(({ song, score }) => {
    const out = { ...song, score };
    delete out._onTopList;
    return out;
  });
}

module.exports = {
  generate,
  extractSeedArtists,
  scoreSong,
  singerSongsFor,
  songKey,
  FINAL_LIMIT,
  MAX_SEED_ARTISTS,
  MAX_FAVORITE_SINGER_FETCH,
  TOPLIST_PATHS,
};
