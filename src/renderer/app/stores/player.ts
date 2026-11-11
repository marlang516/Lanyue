/**
 * stores/player.ts —— 播放状态与取流链路（P1 基础闭环，P4 增强）
 *
 * 链路与旧层一致：
 *   getDownloadUrlSmart(song, quality) → {url, source, id, degradedLocal?}
 *   → proxyPlay(url, referer, {id, source, quality}) → {fileUrl}
 *   → audio.src = lanyue-stream://...
 *
 * 切歌延迟：若等用户点了下一首才串行做上面两步，出声前会空一段。
 * 可预测的邻居在当前这首一开始就解析，并静音预热到备用元素上；
 * 点击时直接播那个元素，不再等新的取流。随机模式猜不到下一首，仍走冷路径。
 *
 * 竞态：切歌后旧请求的结果必须丢弃（_reqSeq），否则慢源会盖掉快源。
 * 唯一 audio 所有者：本模块，视图只读 state。
 */
import { reactive, computed, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { fileUrlFromPath } from '../../../shared/fileUrl.mjs';
import { createSkipPrep, prepKey } from '../../js/skipPrep.js';
import { call, callSafe } from '../core/bridge';
import { normalizeSong, songKey } from '../core/song';
import type { Song } from '../core/song';
import { addRecent } from '../core/recent';
import { lyrics as lyricsState, loadFor as loadLyricsFor, forDesktop, activeLineIndex } from './lyrics';
import type {
  DesktopLyricLine,
  PlayMode,
  PlayQueueSnapshot,
  PlayUrlInfo,
  ProxyPlayResult,
} from './types';

const REFERERS: Readonly<Record<string, string>> = {
  bilibili: 'https://www.bilibili.com/',
  qq: 'https://y.qq.com/',
  netease: 'https://music.163.com/',
  kugou: 'https://www.kugou.com/',
  kuwo: 'https://www.kuwo.cn/',
  migu: 'https://music.migu.cn/',
  soda: 'https://music.douyin.com/',
  fivesing: 'https://5sing.kugou.com/',
};

/** 播放器状态 */
interface PlayerState {
  current: Song | null;
  queue: Song[];
  queueIdx: number;
  playing: boolean;
  loading: boolean;
  progress: number;
  duration: number;
  volume: number;
  rate: number;
  /** order | list-loop | single | shuffle */
  mode: PlayMode;
  error: string | number;
  quality: string;
  // 播放器扩展面板（不进入导航）
  fullscreen: boolean;
  queueOpen: boolean;
}

export const player = reactive<PlayerState>({
  current: null,
  queue: [],
  queueIdx: -1,
  playing: false,
  loading: false,
  progress: 0,
  duration: 0,
  volume: 0.8,
  rate: 1,
  mode: 'order',     // order | list-loop | single | shuffle
  error: '',
  quality: 'standard',
  // 播放器扩展面板（不进入导航）
  fullscreen: false,
  queueOpen: false,
});

export const hasCurrent: ComputedRef<boolean> = computed(() => !!player.current);
export const currentKey: ComputedRef<string> = computed(() => (player.current ? songKey(player.current) : ''));

/** 正在出声的元素。备用元素只负责把下一首/上一首的字节提前拉进来。 */
let activeEl: HTMLAudioElement | null = null;
let _reqSeq = 0;
/** 同时只保留「正在听 + 下一首 + 上一首」，多出来的元素回收再复用。 */
const POOL = 3;
let created = 0;
const owners = new Map<string, HTMLAudioElement>();
const keyOfEl = new WeakMap<HTMLAudioElement, string>();
const urlOf = new WeakMap<HTMLAudioElement, string>();
const spares: HTMLAudioElement[] = [];

function createBoundAudio(): HTMLAudioElement {
  created += 1;
  const a = new Audio();
  a.preload = 'auto';
  a.muted = true;
  a.volume = 0;
  a.playbackRate = player.rate;
  // 备用元素也会 play/pause（用来逼 Chromium 真的去缓冲）。
  // 不是当前元素的事件一律丢掉，否则预热会把界面打成「已暂停」。
  a.addEventListener('timeupdate', () => {
    if (a !== activeEl) return;
    player.progress = a.currentTime || 0;
    if (Number.isFinite(a.duration) && a.duration > 0) player.duration = a.duration;
    syncOutputs();
  });
  a.addEventListener('play', () => {
    if (a !== activeEl) return;
    player.playing = true;
    syncOutputs(true);
  });
  a.addEventListener('pause', () => {
    if (a !== activeEl) return;
    player.playing = false;
    syncOutputs(true);
  });
  a.addEventListener('ended', () => {
    if (a !== activeEl) return;
    next(true);
  });
  a.addEventListener('error', () => {
    if (a !== activeEl) return;
    player.error = '播放失败：音源不可达或已过期';
    player.playing = false;
  });
  bindMediaHandlers();
  return a;
}

function ensureActive(): HTMLAudioElement {
  if (!activeEl) activeEl = createBoundAudio();
  return activeEl;
}

function bindOwner(el: HTMLAudioElement, key: string): void {
  const prev = keyOfEl.get(el);
  if (prev && prev !== key) owners.delete(prev);
  owners.set(key, el);
  keyOfEl.set(el, key);
}

function releaseElement(key: string): void {
  const el = owners.get(key);
  // 正在听的那首只从预取表摘掉，元素和已缓冲的字节留着，切回来不用再取流。
  if (!el || el === activeEl) return;
  owners.delete(key);
  keyOfEl.delete(el);
  urlOf.delete(el);
  el.pause();
  el.muted = true;
  el.volume = 0;
  el.removeAttribute('src');
  el.src = '';
  try { el.load(); } catch { /* 释放备用元素失败不影响当前这首 */ }
  if (!spares.includes(el)) spares.push(el);
}

function elementFor(key: string): HTMLAudioElement {
  const existing = owners.get(key);
  if (existing) return existing;
  let el = spares.pop();
  if (!el && created >= POOL) {
    for (const [k, candidate] of owners) {
      if (candidate === activeEl) continue;
      owners.delete(k);
      keyOfEl.delete(candidate);
      urlOf.delete(candidate);
      candidate.pause();
      el = candidate;
      break;
    }
  }
  if (!el) el = createBoundAudio();
  bindOwner(el, key);
  return el;
}

/**
 * Chromium 把 preload=auto 当提示，经常要点了 play 才真正拉字节。
 * 备用元素静音 play 再立刻 pause：缓冲留下来，当前这首不会被盖掉。
 */
function prime(el: HTMLAudioElement): void {
  if (el === activeEl) return;
  el.muted = true;
  el.volume = 0;
  const pending = el.play();
  if (pending && typeof pending.then === 'function') {
    pending.then(() => {
      if (el === activeEl) return;
      el.pause();
    }).catch(() => { /* 预热被切歌打断不是失败 */ });
  }
}

function attachUrl(el: HTMLAudioElement, key: string | null, fileUrl: string, primeIt: boolean): void {
  if (key) bindOwner(el, key);
  if (urlOf.get(el) === fileUrl && el.src) return;
  urlOf.set(el, fileUrl);
  const warming = primeIt && el !== activeEl;
  el.muted = warming ? true : el === activeEl ? false : el.muted;
  el.volume = warming ? 0 : (el === activeEl ? player.volume : el.volume);
  el.preload = 'auto';
  el.src = fileUrl;
  try { el.load(); } catch { /* 个别环境对尚未就绪的元素 load 会抛 */ }
  if (warming) prime(el);
}

function bufferedElement(song: Song, quality: string): HTMLAudioElement | null {
  const key = prepKey(song, quality);
  if (!key) return null;
  const el = owners.get(key);
  if (!el || !el.src || el.error) return null;
  if (!urlOf.get(el)) return null;
  return el;
}

async function activate(el: HTMLAudioElement, restart: boolean): Promise<void> {
  const prev = activeEl;
  activeEl = el;
  if (prev && prev !== el) prev.pause();
  if (restart) {
    try {
      if (el.currentTime !== 0) el.currentTime = 0;
    } catch { /* 还没有 metadata，play() 会从头开始 */ }
  }
  el.muted = false;
  el.volume = player.volume;
  el.playbackRate = player.rate;
  if (Number.isFinite(el.duration) && el.duration > 0) player.duration = el.duration;
  player.playing = true;
  await el.play();
}

type ResolvedPlayable = { fileUrl: string } | { error: string };

async function resolvePlayable(song: Song, quality: string): Promise<ResolvedPlayable> {
  try {
    if (song.filePath) return { fileUrl: fileUrlFromPath(song.filePath) };
    const result = await call<PlayUrlInfo>('getDownloadUrlSmart', song, quality);
    if (!result || !result.url) {
      const err = result && (result.error || result.code);
      return { error: err ? String(err) : '无可用音源' };
    }
    if (result.degradedLocal) return { fileUrl: result.url };
    const playSource = result.source || song.source;
    const proxied = await call<ProxyPlayResult>('proxyPlay', result.url, REFERERS[playSource] || '', {
      id: String(result.id ?? song.id),
      source: playSource,
      quality,
    });
    if (!proxied || !proxied.fileUrl) return { error: (proxied && proxied.error) || '流代理失败' };
    return { fileUrl: proxied.fileUrl };
  } catch (e) {
    return { error: errorMessage(e) || '播放异常' };
  }
}

const prep = createSkipPrep({
  resolve: async (song, quality) => {
    const resolved = await resolvePlayable(song as Song, quality);
    if ('fileUrl' in resolved && resolved.fileUrl) return { fileUrl: resolved.fileUrl };
    return null;
  },
  onReady: ({ key, fileUrl }) => {
    attachUrl(elementFor(key), key, fileUrl, true);
  },
  onDrop: (key) => releaseElement(key),
});

function armNeighbors(hold: Song | null): void {
  prep.arm({
    queue: player.queue,
    index: player.queueIdx,
    mode: player.mode,
    quality: player.quality,
    holdKey: hold ? prepKey(hold, player.quality) : null,
    skipResolve: (song, quality) => !!bufferedElement(song as Song, quality),
  });
}

function fmtClock(s: number): string {
  const v = Math.max(0, Math.floor(Number(s) || 0));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

/* ── 外部窗口 / 系统集成同步 ─────────────────────────────── */

let _lastSyncAt = 0;
let _lastSyncedKey = '';

function currentLineText(): string {
  const idx = activeLineIndex(lyricsState.items, player.progress + lyricsState.offsetMs / 1000);
  return idx >= 0 ? (lyricsState.items[idx]?.text || '') : '';
}

function updateMediaSession(song: Song | null, changed: boolean): void {
  if (!('mediaSession' in navigator)) return;
  if (changed) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song?.title || '未在播放',
        artist: song?.artist || '',
        album: song?.album || '',
        artwork: song?.cover ? [{ src: song.cover }] : [],
      });
    } catch (_e) { /* 部分环境不支持 artwork */ }
  }
}

let _mediaHandlersBound = false;
function bindMediaHandlers(): void {
  if (_mediaHandlersBound || !('mediaSession' in navigator)) return;
  _mediaHandlersBound = true;
  const set = (action: MediaSessionAction, fn: MediaSessionActionHandler): void => {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch (_e) { /* 动作不支持 */ }
  };
  set('play', () => togglePlay());
  set('pause', () => togglePlay());
  set('nexttrack', () => next());
  set('previoustrack', () => prev());
  set('seekto', (d) => {
    if (d && d.seekTime != null && Number.isFinite(d.seekTime)) seekTo(d.seekTime);
  });
}

/** 迷你播放器载荷（changed 时才附加元信息） */
interface MiniPlayerPayload {
  playing: boolean;
  progress: number;
  lyric: string;
  time: string;
  title?: string;
  artist?: string;
  cover?: string;
  quality?: string;
}

/** 桌面歌词载荷（changed 时才附加整份歌词） */
interface DesktopLyricPayload {
  currentTime: number;
  lyrics?: DesktopLyricLine[];
  title?: string;
}

/**
 * 托盘 / 迷你播放器 / 桌面歌词三处同步。
 * 每帧只推播放态与进度；元信息与整份歌词只在换歌或歌词就绪时推。
 */
function syncOutputs(force = false): void {
  const now = Date.now();
  if (!force && now - _lastSyncAt < 300) return;
  _lastSyncAt = now;

  const song = player.current;
  const key = song ? songKey(song) : '';
  const changed = key !== _lastSyncedKey;

  void callSafe('trayUpdatePlayState', [{
    isPlaying: player.playing,
    title: song?.title || '',
    artist: song?.artist || '',
  }], null);

  const payload: MiniPlayerPayload = {
    playing: player.playing,
    progress: player.duration ? (player.progress / player.duration) * 100 : 0,
    lyric: currentLineText(),
    time: `${fmtClock(player.progress)} / ${fmtClock(player.duration)}`,
  };
  if (changed) {
    payload.title = song ? song.title : '未在播放';
    payload.artist = song ? (song.artist || '未知艺术家') : '—';
    payload.cover = song?.cover || '';
    payload.quality = player.quality;
  }
  void callSafe('syncMiniPlayer', [payload], null);

  const dl: DesktopLyricPayload = { currentTime: player.progress };
  if (changed) {
    dl.lyrics = forDesktop();
    dl.title = song?.title || '';
  }
  void callSafe('syncDesktopLyric', [dl], null);

  if (changed) _lastSyncedKey = key;
  updateMediaSession(song, changed);
}

// 歌词异步到达：强制重推整份歌词给桌面歌词窗口
watch(() => lyricsState.items, () => {
  _lastSyncedKey = '';
  syncOutputs(true);
});

// 播放态变化立即同步（不等 timeupdate）
watch(() => player.playing, () => syncOutputs(true));

/** 设置队列与当前项，不开始播放。已经在播时顺手预取新的邻居。 */
export function setQueue(list: unknown, index = 0): void {
  player.queue = (Array.isArray(list) ? list : []).map(normalizeSong).filter((s): s is Song => s !== null);
  player.queueIdx = Math.max(0, Math.min(index, player.queue.length - 1));
  if (activeEl && activeEl.src) armNeighbors(player.queue[player.queueIdx] || null);
}

/**
 * 播放列表中的某一首。list 省略时用当前队列。
 */
export async function playFromList(list: unknown, index = 0): Promise<void> {
  if (Array.isArray(list)) setQueue(list, index);
  const song = player.queue[player.queueIdx];
  if (!song) return;
  await playSong(song);
}

/**
 * 播放单曲（不改变队列；调用方通常先 setQueue）。
 */
export async function playSong(song: unknown): Promise<void> {
  const s = normalizeSong(song);
  if (!s) return;
  const reqId = ++_reqSeq;
  player.current = s;
  player.error = '';
  player.progress = 0;
  player.duration = (Number(s.duration) || 0) / 1000;
  player.loading = true;
  // 歌词异步加载：不阻塞出声，到达后歌词面板/桌面歌词自动刷新
  void loadLyricsFor(s);

  try {
    // hold 住即将播放的这首，避免「索引已经挪过去」把正在飞的预取拆掉。
    armNeighbors(s);
    const played = await playPreparedOrCold(s, reqId);
    if (reqId !== _reqSeq) return;
    if (played) {
      addRecent(s);
      armNeighbors(null);
    }
  } catch (e) {
    if (reqId === _reqSeq && !isBenignPlayError(e)) {
      player.playing = false;
      player.error = errorMessage(e) || (s.filePath ? '本地文件播放失败' : '播放异常');
    }
  } finally {
    if (reqId === _reqSeq) player.loading = false;
  }
}

async function playPreparedOrCold(s: Song, reqId: number): Promise<boolean> {
  const qualityAtStart = player.quality;
  const key = prepKey(s, qualityAtStart);
  let el: HTMLAudioElement | null = key ? bufferedElement(s, qualityAtStart) : null;

  if (!el && key && (prep.peek(s, qualityAtStart) || prep.isInflight(s, qualityAtStart))) {
    const hit = await prep.join(s, qualityAtStart);
    if (reqId !== _reqSeq) return false;
    el = bufferedElement(s, player.quality);
    if (!el && hit && hit.fileUrl && player.quality === qualityAtStart) {
      el = ensureActive();
      attachUrl(el, key, hit.fileUrl, false);
    }
  }

  if (!el) {
    const quality = player.quality;
    const resolved = await resolvePlayable(s, quality);
    if (reqId !== _reqSeq) return false;
    if (!('fileUrl' in resolved) || !resolved.fileUrl) {
      player.error = 'error' in resolved && resolved.error ? resolved.error : '无可用音源';
      return false;
    }
    const freshKey = prepKey(s, quality);
    el = (freshKey && bufferedElement(s, quality)) || ensureActive();
    if (urlOf.get(el) !== resolved.fileUrl || !el.src) attachUrl(el, freshKey, resolved.fileUrl, false);
  }

  if (reqId !== _reqSeq) return false;
  await activate(el, true);
  return reqId === _reqSeq;
}

/** 从 unknown 异常里取可读文案（等价于 `(e && e.message) || 兜底`） */
function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

/**
 * play() 被 pause()/换源打断时 Chromium 抛 AbortError，message 形如
 * "The play() request was interrupted by a call to pause()"。这是取流/缓冲
 * 期间的正常竞态（如加载时按暂停、快速切歌），不是真正的播放失败，
 * 不应写进 player.error 显示给用户。
 */
function isBenignPlayError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  const msg = errorMessage(e);
  return !!msg && /play\(\) request was interrupted|interrupted by a call to pause|AbortError/i.test(msg);
}

export function togglePlay(): void {
  const a = ensureActive();
  if (!a.src) {
    if (player.current) void playSong(player.current);
    return;
  }
  if (a.paused) a.play().catch((e) => { if (!isBenignPlayError(e)) player.error = '恢复播放失败'; });
  else a.pause();
}

export function seekTo(seconds: number): void {
  const a = activeEl;
  const s = Math.max(0, Number(seconds) || 0);
  if (a && a.src) a.currentTime = s;
  player.progress = s;
}

export function setVolume(v: number): void {
  const n = Math.min(1, Math.max(0, Number(v) || 0));
  player.volume = n;
  if (activeEl && !activeEl.muted) activeEl.volume = n;
}

export function setRate(r: number | string): number {
  const n = Math.min(2, Math.max(0.5, Number(r) || 1));
  player.rate = n;
  if (activeEl) activeEl.playbackRate = n;
  return n;
}

export function setQuality(q: string | null | undefined): void {
  const nextQ = q || 'standard';
  if (nextQ === player.quality) return;
  player.quality = nextQ;
  // 旧音质的缓冲不能拿来播。正在听的这首不打断，邻居按新音质重取。
  prep.invalidate();
  if (activeEl && activeEl.src) armNeighbors(player.queue[player.queueIdx] || null);
}

export function cycleMode(): PlayMode {
  const order: PlayMode[] = ['order', 'list-loop', 'single', 'shuffle'];
  const i = order.indexOf(player.mode);
  player.mode = order[(i + 1) % order.length];
  if (activeEl && activeEl.src) armNeighbors(player.queue[player.queueIdx] || null);
  return player.mode;
}

function pickIndex(dir: number): number {
  const n = player.queue.length;
  if (!n) return -1;
  if (player.mode === 'shuffle') {
    if (n === 1) return 0;
    let i = player.queueIdx;
    while (i === player.queueIdx) i = Math.floor(Math.random() * n);
    return i;
  }
  if (player.mode === 'single') return player.queueIdx;
  const nextIdx = player.queueIdx + dir;
  if (nextIdx < 0) return player.mode === 'list-loop' ? n - 1 : 0;
  if (nextIdx >= n) return player.mode === 'list-loop' ? 0 : n - 1;
  return nextIdx;
}

/** @param auto true=播完自动推进（single 模式重播本曲） */
export function next(auto = false): void {
  // 单曲循环播完：同一条已经打开的流回到开头，不再取一次 URL。
  if (player.mode === 'single' && auto && activeEl && activeEl.src && !activeEl.error) {
    player.progress = 0;
    try { activeEl.currentTime = 0; } catch { /* metadata 未到时从头 play 即可 */ }
    activeEl.play().catch((e) => {
      if (!isBenignPlayError(e)) player.error = '播放失败';
    });
    return;
  }
  const idx = pickIndex(1);
  if (idx < 0) { player.playing = false; return; }
  if (idx === player.queueIdx && player.mode !== 'single') { player.playing = false; return; }
  player.queueIdx = idx;
  void playSong(player.queue[idx]);
}

export function prev(): void {
  const idx = pickIndex(-1);
  if (idx < 0) return;
  player.queueIdx = idx;
  void playSong(player.queue[idx]);
}

export function removeFromQueue(index: number): void {
  if (index < 0 || index >= player.queue.length) return;
  const wasCurrent = index === player.queueIdx;
  player.queue.splice(index, 1);
  if (!player.queue.length) {
    player.queueIdx = -1;
    player.current = null;
    prep.invalidate();
    return;
  }
  if (index < player.queueIdx) player.queueIdx -= 1;
  else if (wasCurrent) player.queueIdx = Math.min(index, player.queue.length - 1);
  if (activeEl && activeEl.src) armNeighbors(player.queue[player.queueIdx] || null);
}

export function clearQueue(): void {
  player.queue.splice(0);
  player.queueIdx = -1;
  prep.invalidate();
}

/** 把歌曲追加到队列（不打断当前播放） */
export function appendToQueue(songs: unknown): number {
  const list = (Array.isArray(songs) ? songs : [songs])
    .map(normalizeSong)
    .filter((s): s is Song => s !== null);
  if (!list.length) return 0;
  player.queue.push(...list);
  if (player.queueIdx < 0) player.queueIdx = 0;
  if (activeEl && activeEl.src) armNeighbors(player.queue[player.queueIdx] || null);
  return list.length;
}

/** 队列持久化：主进程 save-play-queue / load-play-queue */
export async function persistQueue(): Promise<void> {
  await callSafe('savePlayQueue', [{
    queue: player.queue.map((s) => ({
      id: s.id, source: s.source, title: s.title, artist: s.artist,
      album: s.album, duration: s.duration, cover: s.cover,
      ...(s.filePath ? { filePath: s.filePath } : {}),
    })),
    playIdx: player.queueIdx,
  }], null);
}

/** 启动恢复播放队列（不自动播放，只还原队列与当前项） */
export async function restoreQueue(): Promise<void> {
  const r = await callSafe<PlayQueueSnapshot | null>('loadPlayQueue', [], null);
  const list: unknown[] = r && Array.isArray(r.queue) ? r.queue : [];
  if (!list.length) return;
  player.queue = list.map(normalizeSong).filter((s): s is Song => s !== null);
  player.queueIdx = Math.min(
    Math.max(0, Number(r && r.playIdx) || 0),
    Math.max(0, player.queue.length - 1),
  );
  const cur = player.queue[player.queueIdx];
  if (cur) {
    player.current = cur;
    player.duration = (Number(cur.duration) || 0) / 1000;
    player.progress = 0;
    void loadLyricsFor(cur);
  }
}

// 队列结构变化时落盘（主进程内部 500ms 防抖）
watch(() => [player.queue.length, player.queueIdx], () => { void persistQueue(); });