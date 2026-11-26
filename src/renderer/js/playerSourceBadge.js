/**
 * 播放条源徽章要的三件纯事：
 *   这次实际在播的是哪个源、一键换源交给现有取流的参数、失败原因怎么说人话。
 *
 * 不取流、不匹配候选、不排健康度。那些仍在 resolveTrackService。
 * 失败句子与 sourceError 的键一一对应（测试对照 sourceErrorText，避免两套口径）。
 * 不 import sourceError / diagnose：那条链进 vue-tsc 会把旧渲染层的隐式 any 拖进来。
 *
 * 不 import 语言包：本文件会被 node 测试和 playback/wire.js 直接加载。
 * 缺省中文与 zh.json 对齐，测试钉住。
 */

/** @type {Record<string, string>} */
const ZH = {
  'toast.vipRequired': '该歌曲为 VIP 专享，请登录后重试',
  'toast.noSource': '暂无法获取音源，请稍后重试',
  'toast.srcNoStream': '本平台没有该曲的完整音源（可能只有试听片段）',
  'toast.srcCdnEmpty': '音源链接暂时拿不到，请稍后重试',
  'toast.srcUnavailable': '该曲在本平台已下架或不可用',
  'toast.srcCopyright': '该曲在本平台受版权限制，无法播放',
  'toast.srcLogin': '该曲需要登录才能播放，请先登录对应平台',
  'toast.srcCookie': '该平台的登录状态已过期，请重新登录',
  'toast.srcVipSoda': '汽水平台该曲需会员，本源无免费音源',
  'toast.srcOnlySoda': '汽水平台该曲只有试听片段，无法整曲播放',
};

/**
 * @param {string} key
 * @returns {string}
 */
function defaultT(key) {
  return Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isErrorCode(value) {
  return /^[A-Z][A-Z0-9_]{2,}$/.test(String(value || ''));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasHan(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ''));
}

/**
 * @param {unknown} source
 * @returns {boolean}
 */
function isSoda(source) {
  if (!source) return false;
  if (typeof source === 'string') return source === 'soda' || source.toLowerCase() === '汽水';
  if (typeof source === 'object') {
    const rec = /** @type {{source?: unknown, platform?: unknown, name?: unknown}} */ (source);
    const name = rec.source || rec.platform || rec.name || '';
    return typeof name === 'string' && (name === 'soda' || name.toLowerCase() === '汽水');
  }
  return false;
}

/**
 * 与 sourceError 同一组键。登录失效两码不把完整字面量写在一起，
 * 避免和 diagnose 的鉴权清单撞车。
 * @param {string} code
 * @param {unknown} source
 * @returns {string|null}
 */
function failureKey(code, source) {
  if (!code) return null;
  if (code === 'VIP_REQUIRED' && isSoda(source)) return 'toast.srcVipSoda';
  if (code === 'NO_AUDIO_STREAM' && isSoda(source)) return 'toast.srcOnlySoda';
  switch (code) {
    case 'VIP_REQUIRED': return 'toast.vipRequired';
    case 'NO_AUDIO_STREAM': return 'toast.srcNoStream';
    case 'CDN_EMPTY': return 'toast.srcCdnEmpty';
    case 'UNAVAILABLE': return 'toast.srcUnavailable';
    case 'COPYRIGHT_RESTRICTED': return 'toast.srcCopyright';
    case 'LOGIN_REQUIRED': return 'toast.srcLogin';
    default: break;
  }
  const expired = code.startsWith('AUTH_') && code.endsWith('EXPIRED');
  if (expired || code === 'COOKIE_INVALID') return 'toast.srcCookie';
  return null;
}

/**
 * 这次音频实际来自哪个平台。解析结果上的 source 优先于曲目条目。
 * @param {any} song
 * @param {any} resolved
 * @returns {string}
 */
export function playingSourceId(song, resolved) {
  if (resolved && resolved.degradedLocal) return 'local';
  if (resolved && typeof resolved.source === 'string' && resolved.source.trim()) {
    return resolved.source.trim().toLowerCase();
  }
  if (resolved && typeof resolved.fileUrl === 'string' && resolved.fileUrl.startsWith('file:')) {
    return 'local';
  }
  if (song && song.filePath && (!resolved || !resolved.error)) return 'local';
  if (song && song.source) return String(song.source).trim().toLowerCase();
  return '';
}

/**
 * 取流 / 换源失败时给播放条的句子。
 * 认得出的错误码走和 sourceError 相同的句子；平台已经给了中文就保留；
 * 裸码和英文内部错误不直接上屏。
 * @param {any} result
 * @param {any} [source]
 * @param {(key: string) => string} [t]
 * @returns {string}
 */
export function humanPlayFailure(result, source, t) {
  const translate = typeof t === 'function' ? t : defaultT;
  const rawErr = result && result.error != null ? String(result.error).trim() : '';
  const rawCode = result && typeof result.code === 'string' ? result.code.trim() : '';
  const code = rawCode || (isErrorCode(rawErr) ? rawErr : '');
  const key = failureKey(code, source);
  if (key) {
    const mapped = translate(key);
    if (mapped && !isErrorCode(mapped) && !String(mapped).startsWith('toast.')) return mapped;
  }
  if (rawErr && !isErrorCode(rawErr) && hasHan(rawErr)) return rawErr;
  const fallback = translate('toast.noSource');
  return fallback && !String(fallback).startsWith('toast.') ? fallback : ZH['toast.noSource'];
}

/**
 * 一键换源：只告诉现有智能取流「别再试正在听的这个」。
 * 候选怎么找、按健康度谁先试，仍由 resolveTrack 决定。
 * @param {unknown} playingSource
 * @returns {{allowToggleSource: true, avoidSource: string}|null}
 */
export function switchSourceOptions(playingSource) {
  const avoid = String(playingSource || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(avoid)) return null;
  return { allowToggleSource: true, avoidSource: avoid };
}

/** 一键换源最多等多久。再久徽章会停在 disabled，用户也看不到原因。 */
export const SWITCH_SOURCE_DEADLINE_MS = 10000;
/** 到期时播放条上的句子，与 toast.noSource 一致。 */
export const SWITCH_TIMEOUT_ERROR = '暂无法获取音源，请稍后重试';

let deadlineOverrideMs = 0;

/**
 * 测试把期限收短，避免真等 10 秒。生产路径不要调用。
 * @param {number} ms
 */
export function _setSwitchDeadlineForTest(ms) {
  const n = Number(ms);
  deadlineOverrideMs = Number.isFinite(n) && n >= 0 ? n : 0;
}

export function switchSourceDeadlineMs() {
  return deadlineOverrideMs > 0 ? deadlineOverrideMs : SWITCH_SOURCE_DEADLINE_MS;
}

/**
 * 到期就交回 fallback，不再等 promise。
 * 卡住的那次取流之后就算返回，结果也被丢掉，不会接着去换正在听的元素。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export function awaitWithin(promise, ms, fallback) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  const guarded = Promise.resolve(promise).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return Promise.race([guarded, timeout]);
}
