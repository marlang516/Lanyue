/**
 * Audiomack 音源（2026-11-20 对公开网页客户端实测，不是旧插件假设）
 *
 * 用来补国内源里没有的独立音乐和说唱。只接搜索、取流和单曲链接，
 * 不做榜单、歌单或发现页分区。
 *
 * ── 公开接口（匿名，不登录）────────────────────────────────
 * 网站自己的桌面端把 OAuth 1.0 消费者密钥写在公开 JS 里，
 * 密钥名是 audiomack-web。这是应用级签名，不是用户令牌，也不是付费解锁。
 * 旧的 audiomack-js 密钥现在签出来是 401，已丢弃。
 *
 * 搜索  GET https://api.audiomack.com/v1/livesearch
 *         ?q=&show=songs&sort=popular&limit=20&page=
 *       show=music 会把专辑混进同一页，所以单曲搜索固定 show=songs。
 *       duration 是秒（字符串或数字），这里乘 1000。
 *
 * 取流  GET https://api.audiomack.com/v1/music/play/{id}
 *         ?environment=desktop-web&hq=true
 *       → { signedUrl, playUuid }。signedUrl 在 music.audiomack.com，
 *         实测公开曲是完整文件（约 190–260kbps 的 audio/mp4），不是试听片段。
 *       会员专享返回 403 { message:"Not authorized" }，没有直链。
 *       没有 signedUrl，或直链预检不是音频，都明确失败，不把断链交出去。
 *       匿名只有网站这一档，quality 参数不产生第二档。
 *
 * 详情  GET /v1/music/{id}
 *       GET /v1/music/song/{artistSlug}/{songSlug}
 *       歌曲页公开地址是 https://audiomack.com/{artist}/song/{slug}
 *       （/en/ 前缀会被网站 307 去掉）。详情里没有公开歌词字段。
 *
 * artist 用接口里的署名；空了才回退上传者显示名。featuring 不并进歌手，
 * 否则跨源匹配的歌手集合会被客串名带偏。署名是稳定的表演者名字，
 * 所以 fallbackSource 打开。
 */

const crypto = require('crypto');
const request = require('../request');
const { asSong } = require('../songShape');
const { testAudioLink } = require('../request');
const logger = require('../../utils/logger');

const API_ORIGIN = 'https://api.audiomack.com';
const API_BASE = `${API_ORIGIN}/v1`;
const SITE_ORIGIN = 'https://audiomack.com';

/** 单曲搜索每页条数。aggregateLimit 必须与它相同。 */
const SEARCH_PAGE_SIZE = 20;

/**
 * 公开网页客户端的 OAuth 消费者凭据（audiomack.com 的 JS 包内明文）。
 * 网站发新包后若签名开始 401，按新包里的 API_CONSUMER_KEY / SECRET 更新。
 */
const CONSUMER_KEY = 'audiomack-web';
const CONSUMER_SECRET = 'bd8a07e9f23fbe9d808646b730f89b8e';

const API_HEADERS = {
  Accept: 'application/json',
  Origin: SITE_ORIGIN,
  Referer: `${SITE_ORIGIN}/`,
};

/** RFC 3986 百分号编码（OAuth 1.0 参数归一化用，比 encodeURIComponent 多编 !'()*） */
function pctEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');
}

function randomNonce(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * 给 GET 请求签上 Audiomack 公开客户端的 OAuth 1.0 HMAC-SHA1。
 * @param {string} method
 * @param {string} rawUrl 不含查询串的绝对 URL
 * @param {Object} params
 * @param {{nonce?:string, timestamp?:string|number}} [clock] 单测固定向量用
 * @returns {string}
 */
function oauthSign(method, rawUrl, params, clock) {
  const methodUp = String(method || 'GET').toUpperCase();
  const base = String(rawUrl || '').split('?')[0];
  const oauth = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_nonce: (clock && clock.nonce) || randomNonce(32),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: clock && clock.timestamp != null
      ? String(clock.timestamp)
      : String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
  };
  const all = {};
  for (const [key, value] of Object.entries({ ...(params || {}), ...oauth })) {
    if (value == null) continue;
    all[key] = String(value);
  }
  const pairs = Object.entries(all).map(([key, value]) => [pctEncode(key), pctEncode(value)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
  const paramStr = pairs.map(([key, value]) => `${key}=${value}`).join('&');
  const baseString = `${pctEncode(methodUp)}&${pctEncode(base)}&${pctEncode(paramStr)}`;
  const signingKey = `${pctEncode(CONSUMER_SECRET)}&`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(all)) query.append(key, value);
  query.append('oauth_signature', signature);
  return `${base}?${query.toString()}`;
}

function plainText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * 搜索或详情里的一条原始记录 → 统一歌曲。非歌曲、空 id、空标题返回 null。
 * @param {object} raw
 * @returns {object|null}
 */
function mapItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type == null || raw.type === '' ? 'song' : String(raw.type);
  if (type !== 'song') return null;
  const id = String(raw.id ?? '').trim();
  const title = plainText(raw.title);
  if (!id || !title) return null;
  let artist = plainText(raw.artist);
  if (!artist && raw.uploader && typeof raw.uploader === 'object') {
    artist = plainText(raw.uploader.name);
  }
  let album = '';
  if (typeof raw.album === 'string') album = plainText(raw.album);
  else if (raw.album && typeof raw.album === 'object') {
    album = plainText(raw.album.name || raw.album.title);
  }
  const cover = [raw.image, raw.image_base]
    .map((url) => String(url || '').trim())
    .find((url) => /^https?:\/\//.test(url)) || '';
  const seconds = Number(raw.duration);
  const duration = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
  return asSong({
    id,
    title,
    artist,
    album,
    cover,
    duration,
    source: 'audiomack',
  });
}

function mapSearchPayload(body) {
  const list = body && typeof body === 'object' && Array.isArray(body.results) ? body.results : [];
  return list.map(mapItem).filter(Boolean);
}

function unavailable(body) {
  const msg = body && typeof body.message === 'string' ? body.message.trim() : '';
  const safe = msg && msg.length <= 80 && !/[<>]/.test(msg) ? msg : '';
  return {
    error: safe
      ? `Audiomack 暂无公开可播音源（${safe}）`
      : 'Audiomack 暂无公开可播音源（可能需要会员、已下架或受地域限制）',
    code: 'UNAVAILABLE',
    fatal: true,
  };
}

/**
 * 播放接口的响应 + 直链预检 → 成功直链或失败对象。失败对象不含 url。
 * @param {object} body
 * @param {{ok?:boolean, ext?:string, sizeBytes?:number}|null} probe
 */
function decidePlay(body, probe) {
  const url = body && typeof body.signedUrl === 'string' ? body.signedUrl : '';
  if (!/^https:\/\//.test(url)) return unavailable(body);
  if (!probe || !probe.ok) {
    return { error: 'Audiomack 音源暂不可用', code: 'CDN_EMPTY', fatal: true };
  }
  return {
    url,
    ext: probe.ext || 'm4a',
    size: probe.sizeBytes,
    referer: `${SITE_ORIGIN}/`,
    via: 'official:music/play',
  };
}

async function apiGet(path, params) {
  const url = oauthSign('GET', `${API_BASE}/${String(path).replace(/^\//, '')}`, params);
  return request(url, { headers: API_HEADERS, timeout: 10000 });
}

function isNumericId(id) {
  return /^\d+$/.test(id);
}

function isSlugId(id) {
  return /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(id);
}

async function lookupSong(id) {
  const raw = String(id || '').trim();
  let path = '';
  if (isNumericId(raw)) path = `music/${raw}`;
  else if (isSlugId(raw)) path = `music/song/${raw}`;
  else return null;
  try {
    const body = await apiGet(path, {});
    const record = body && body.results && !Array.isArray(body.results) ? body.results : null;
    return mapItem(record);
  } catch (e) {
    logger.warn('[audiomack] 歌曲详情失败:', e.message);
    return null;
  }
}

async function audiomackSearch(keyword, page = 1) {
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) return [];
  const pageNo = Math.max(1, parseInt(page, 10) || 1);
  try {
    const body = await apiGet('livesearch', {
      q: keyword.trim(),
      show: 'songs',
      sort: 'popular',
      limit: String(SEARCH_PAGE_SIZE),
      page: String(pageNo),
    });
    return mapSearchPayload(body);
  } catch (e) {
    logger.warn('[audiomack] 搜索失败:', e.message);
    return [];
  }
}

/**
 * @param {string} id 数字 id，或链接识别得到的 artistSlug/songSlug
 * @param {string} [_quality] 匿名公开流只有一档，忽略
 * @returns {Promise<{url?:string, ext?:string, size?:number, referer?:string, via?:string}|{error:string, code:string, fatal:boolean}>}
 */
async function audiomackGetUrl(id, _quality) {
  const raw = String(id || '').trim();
  if (!raw) return { error: '缺少歌曲 ID', code: 'BAD_PARAMS', fatal: true };
  try {
    let musicId = raw;
    if (!isNumericId(raw)) {
      const song = await lookupSong(raw);
      musicId = song && song.id;
      if (!musicId) return unavailable(null);
    }
    const body = await apiGet(`music/play/${encodeURIComponent(musicId)}`, {
      environment: 'desktop-web',
      hq: 'true',
    });
    const signed = body && typeof body.signedUrl === 'string' ? body.signedUrl : '';
    if (!/^https:\/\//.test(signed)) return unavailable(body);
    const probe = await testAudioLink(signed, { headers: { Referer: `${SITE_ORIGIN}/` } });
    return decidePlay(body, probe);
  } catch (e) {
    logger.warn('[audiomack] getUrl 失败:', e.message);
    return { error: e.message, code: 'FETCH_FAILED', fatal: false };
  }
}

async function audiomackGetSongDetail(id) {
  return lookupSong(id);
}

/** 公开歌曲页。/en/ 之类的两位语言前缀可选；专辑路径不含 /song/，不会命中。 */
const SONG_LINK_RE = /(?:^|[\s"'<(])(?:https?:\/\/)?(?:www\.)?audiomack\.com\/(?:[a-z]{2}\/)?([A-Za-z0-9_-]+)\/song\/([A-Za-z0-9_-]+)/i;

module.exports = {
  id: 'audiomack',
  name: 'Audiomack',
  nameEn: 'Audiomack',
  icon: '🔊',
  // 与现有八色错开：青绿色，不靠近网易红、QQ 黄、B 站青、酷狗绿、酷我蓝、咪咕紫、5sing 琥珀、汽水粉
  badge: { bg: 'rgba(20,184,166,.14)', fg: '#14b8a6', border: 'rgba(20,184,166,.24)' },
  hosts: {
    origins: [
      'https://api.audiomack.com',
      'https://music.audiomack.com',
    ],
  },
  linkPatterns: [
    { type: 'song', re: SONG_LINK_RE, extract: (m) => `${m[1]}/${m[2]}` },
  ],
  policies: {
    order: 90,
    fallbackSource: true,
    probeable: true,
    aggregateLimit: SEARCH_PAGE_SIZE,
  },

  search: audiomackSearch,
  getUrl: audiomackGetUrl,
  getSongDetail: audiomackGetSongDetail,

  audiomackSearch,
  audiomackGetUrl,
  audiomackGetSongDetail,
  _internal: {
    mapItem,
    mapSearchPayload,
    oauthSign,
    decidePlay,
    SEARCH_PAGE_SIZE,
  },
};
