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
 * 邻居已经在备用元素上、并且交叉档位开着时，切歌改成重叠：
 * 出去的歌变轻、进来的歌同时变响，中间不留一段静音。编排在
 * playback/crossfade.js，本模块仍是唯一的 audio 所有者和音量写手。
 * 旧引擎的 crossfadeTo 继续是占位 —— 生产路径不迁回去。
 *
 * 竞态：切歌后旧请求的结果必须丢弃（_reqSeq），否则慢源会盖掉快源。
 * 唯一 audio 所有者：本模块，视图只读 state。
 */
import { reactive, computed, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { fileUrlFromPath } from '../../../shared/fileUrl.mjs';
import { createSkipPrep, neighborIndex, prepKey } from '../../js/skipPrep.js';
import {
  CROSSFADE_PREF_KEY,
  audibleVolume,
  createCrossfadeController,
  decideCrossfade,
  normalizeCrossfadeMs,
} from '../../js/playback/crossfade.js';
import { call, callSafe, on } from '../core/bridge';
import { getPref, setPref } from '../core/prefs';
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
  /** 无缝交叉时长（ms）。0 关，其余只取 FADE_STEPS 那几档。 */
  crossfadeMs: number;
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
  crossfadeMs: 0,
  // 播放器扩展面板（不进入导航）
  fullscreen: false,
  queueOpen: false,
});

export async function restorePlaybackPrefs(): Promise<void> {
  const [quality, volume, rate, crossfade] = await Promise.all([
    getPref('quality', 'standard'),
    getPref('playerVolume', 0.8),
    getPref('playbackRate', 1),
    getPref(CROSSFADE_PREF_KEY, 0),
  ]);
  setQuality(String(quality || 'standard'), false);
  setVolume(Number(volume), false);
  setRate(Number(rate), false);
  setCrossfadeMs(Number(crossfade), false);
}

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

/** 每个元素的交叉增益。实际音量 = 用户音量 × 增益，只在 applyAudibleVolume 落地。 */
const gains = new WeakMap<HTMLAudioElement, number>();
const elByGainId = new Map<string, HTMLAudioElement>();
const idOfEl = new WeakMap<HTMLAudioElement, string>();
let gainSeq = 0;

interface CrossfadeSession {
  fromEl: HTMLAudioElement;
  toEl: HTMLAudioElement;
  toSong: Song;
  toIndex: number;
  fromSong: Song | null;
  fromIndex: number;
  metaSwapped: boolean;
}

let xfade: CrossfadeSession | null = null;

interface CrossfadeClock {
  now: number;
  manual?: boolean;
}

function readCrossfadeClock(): CrossfadeClock | null {
  const clock = (globalThis as { __LY_CROSSFADE_CLOCK__?: CrossfadeClock }).__LY_CROSSFADE_CLOCK__;
  if (!clock || typeof clock !== 'object') return null;
  return clock;
}

function elementId(el: HTMLAudioElement): string {
  let id = idOfEl.get(el);
  if (!id) {
    gainSeq += 1;
    id = 'a' + gainSeq;
    idOfEl.set(el, id);
  }
  elByGainId.set(id, el);
  return id;
}

function gainOf(el: HTMLAudioElement): number {
  const g = gains.get(el);
  if (g === undefined) return el === activeEl ? 1 : 0;
  return g;
}

/** 全文件唯一的 audio.volume 写点。交叉层只改增益。 */
function applyAudibleVolume(el: HTMLAudioElement | null): void {
  if (!el) return;
  el.volume = audibleVolume(player.volume, gainOf(el));
}

function parkElement(el: HTMLAudioElement | null): void {
  if (!el) return;
  try { el.pause(); } catch { /* 已经停了 */ }
  el.muted = true;
  gains.set(el, 0);
  applyAudibleVolume(el);
}

function remainingMsOf(el: HTMLAudioElement): number | null {
  const dur = el.duration;
  const cur = el.currentTime;
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(cur)) return null;
  return Math.max(0, (dur - cur) * 1000);
}

function indexOfElement(el: HTMLAudioElement): number {
  const key = keyOfEl.get(el);
  if (!key) return -1;
  return player.queue.findIndex((s) => prepKey(s, player.quality) === key);
}

/**
 * 中点才换「正在听的那首」。此前系统媒体键和界面标题都还是出去的歌。
 */
function commitCrossfadeSong(song: Song, index: number, el: HTMLAudioElement | null): void {
  if (index >= 0 && index < player.queue.length) player.queueIdx = index;
  player.current = song;
  player.progress = el ? (el.currentTime || 0) : 0;
  if (el && Number.isFinite(el.duration) && el.duration > 0) player.duration = el.duration;
  else player.duration = (Number(song.duration) || 0) / 1000;
  player.playing = true;
  player.error = '';
  void loadLyricsFor(song);
  addRecent(song);
  _lastSyncedKey = '';
  syncOutputs(true);
  // 按住即将成为当前的这首，避免预取表把它当成「不再是邻居」拆掉。
  armNeighbors(song);
}

function handoffPrimary(id: string): void {
  if (!xfade) return;
  const el = elByGainId.get(id) || xfade.toEl;
  activeEl = el;
  el.muted = false;
  gains.set(el, 1);
  applyAudibleVolume(el);
  el.playbackRate = player.rate;
  if (!xfade.metaSwapped) {
    xfade.metaSwapped = true;
    commitCrossfadeSong(xfade.toSong, xfade.toIndex, el);
  }
  player.playing = !el.paused;
  player.progress = el.currentTime || 0;
  if (Number.isFinite(el.duration) && el.duration > 0) player.duration = el.duration;
}

function releaseFaded(id: string): void {
  const session = xfade;
  const el = elByGainId.get(id);
  xfade = null;
  if (el && el !== activeEl) parkElement(el);
  armNeighbors(null);
  // 进来的歌比交叉更短，淡完时已经 ended，不会再发一次。
  if (session && session.toEl.ended) next(true);
}

/**
 * 立刻收掉重叠。keep 是还要继续出声的那一路；none 是两路都停。
 * 中点之前留下出去的歌，中点之后留下已经报给系统的那首。
 */
function collapseCrossfade(keep: 'from' | 'to' | 'none', opts: { pause?: boolean } = {}): void {
  const session = xfade;
  if (!session) return;
  xfade = null;
  try { xfCtrl.abort('collapse'); } catch { /* 编排器不在交叉中 */ }
  const keepEl = keep === 'to' ? session.toEl : keep === 'from' ? session.fromEl : null;
  for (const el of [session.fromEl, session.toEl]) {
    if (el && el !== keepEl) parkElement(el);
  }
  if (!keepEl) {
    player.playing = false;
    return;
  }
  keepEl.muted = false;
  gains.set(keepEl, 1);
  applyAudibleVolume(keepEl);
  keepEl.playbackRate = player.rate;
  activeEl = keepEl;
  if (keep === 'to' && !session.metaSwapped) {
    commitCrossfadeSong(session.toSong, session.toIndex, keepEl);
  } else if (keep === 'from') {
    const idx = session.fromIndex >= 0 ? session.fromIndex : indexOfElement(session.fromEl);
    if (session.metaSwapped && session.fromSong) {
      player.current = session.fromSong;
      if (idx >= 0) player.queueIdx = idx;
      player.progress = keepEl.currentTime || 0;
      _lastSyncedKey = '';
      syncOutputs(true);
    } else if (idx >= 0) {
      player.queueIdx = idx;
    }
  }
  if (opts.pause) {
    try { keepEl.pause(); } catch { /* 已经停了 */ }
    player.playing = false;
    return;
  }
  if (keepEl.paused) {
    const pending = keepEl.play();
    if (pending && typeof pending.catch === 'function') {
      pending.catch((e) => { if (!isBenignPlayError(e)) player.error = '恢复播放失败'; });
    }
  }
  player.playing = true;
}

const xfCtrl = createCrossfadeController({
  now: () => {
    const clock = readCrossfadeClock();
    if (clock && Number.isFinite(clock.now)) return clock.now;
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  },
  setGain: (id: string, g: number) => {
    const el = elByGainId.get(id);
    if (!el) return;
    gains.set(el, g);
    applyAudibleVolume(el);
  },
  onMetadataSwap: () => {
    if (!xfade || xfade.metaSwapped) return;
    xfade.metaSwapped = true;
    commitCrossfadeSong(xfade.toSong, xfade.toIndex, xfade.toEl);
  },
  onPrimaryChange: (id: string) => { handoffPrimary(id); },
  onRelease: (id: string) => { releaseFaded(id); },
});

function installCrossfadeClock(): void {
  const clock = readCrossfadeClock();
  if (clock && clock.manual) {
    xfCtrl.setTick(() => 0);
    return;
  }
  const raf = globalThis.requestAnimationFrame;
  const caf = globalThis.cancelAnimationFrame;
  if (typeof raf === 'function' && typeof caf === 'function') {
    xfCtrl.setTick((step: () => void) => {
      const handle = raf(() => { step(); });
      return { cancel: () => caf(handle) };
    });
  }
}
installCrossfadeClock();

/** 测试用手动时钟推进一帧。生产走 requestAnimationFrame，不会来调它。 */
export function pumpCrossfade(nowMs?: number): void {
  const clock = readCrossfadeClock();
  if (clock && Number.isFinite(nowMs)) clock.now = Number(nowMs);
  xfCtrl.step(Number.isFinite(nowMs) ? Number(nowMs) : undefined);
}

function createBoundAudio(): HTMLAudioElement {
  created += 1;
  const a = new Audio();
  a.preload = 'auto';
  a.muted = true;
  gains.set(a, 0);
  applyAudibleVolume(a);
  a.playbackRate = player.rate;
  // 备用元素也会 play/pause（用来逼 Chromium 真的去缓冲）。
  // 不是当前元素的事件一律丢掉，否则预热会把界面打成「已暂停」。
  a.addEventListener('timeupdate', () => {
    // 中点之后进度跟进来的那首，哪怕主元素还没交过去。
    if (xfade && xfade.metaSwapped && a === xfade.toEl) {
      player.progress = a.currentTime || 0;
      if (Number.isFinite(a.duration) && a.duration > 0) player.duration = a.duration;
      syncOutputs();
      return;
    }
    if (a !== activeEl) return;
    // 切歌失败时 current 已换成新歌，元素仍是上一首。进度不能再跟那首走。
    const owned = keyOfEl.get(a) ?? null;
    const curKey = player.current ? prepKey(player.current, player.quality) : null;
    if (owned !== curKey) return;
    player.progress = a.currentTime || 0;
    if (Number.isFinite(a.duration) && a.duration > 0) player.duration = a.duration;
    syncOutputs();
    maybeAutoCrossfade(a);
  });
  a.addEventListener('play', () => {
    if (xfade && a === xfade.fromEl) return;
    if (a !== activeEl) return;
    player.playing = true;
    syncOutputs(true);
  });
  a.addEventListener('pause', () => {
    // 出去的歌播到结尾会先 pause 再 ended。交叉还没完时这不是用户暂停。
    if (xfade && (a === xfade.fromEl || a === xfade.toEl)) return;
    if (a !== activeEl) return;
    player.playing = false;
    syncOutputs(true);
  });
  a.addEventListener('ended', () => {
    if (xfade && (a === xfade.fromEl || a === xfade.toEl)) return;
    if (a !== activeEl) return;
    next(true);
  });
  a.addEventListener('error', () => {
    if (xfade && a === xfade.toEl) {
      const song = xfade.toSong;
      const index = xfade.toIndex;
      collapseCrossfade('from');
      void playSong(song, { index, forceHard: true });
      return;
    }
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
  // 交叉的两路还在响，预取表收口不能把它们的 src 拆掉。
  if (xfade && (el === xfade.fromEl || el === xfade.toEl)) return;
  owners.delete(key);
  keyOfEl.delete(el);
  urlOf.delete(el);
  el.pause();
  el.muted = true;
  gains.set(el, 0);
  applyAudibleVolume(el);
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
      if (xfade && (candidate === xfade.fromEl || candidate === xfade.toEl)) continue;
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
  gains.set(el, 0);
  applyAudibleVolume(el);
  const pending = el.play();
  if (pending && typeof pending.then === 'function') {
    pending.then(() => {
      if (el === activeEl) return;
      // 预热的 pause 若落在交叉已经把这路拉起来之后，会把进来的歌按停。
      if (xfade && el === xfade.toEl) return;
      el.pause();
    }).catch(() => { /* 预热被切歌打断不是失败 */ });
  }
}

function attachUrl(el: HTMLAudioElement, key: string | null, fileUrl: string, primeIt: boolean): void {
  if (key) bindOwner(el, key);
  if (urlOf.get(el) === fileUrl && el.src) return;
  urlOf.set(el, fileUrl);
  const warming = primeIt && el !== activeEl;
  if (warming) {
    el.muted = true;
    gains.set(el, 0);
    applyAudibleVolume(el);
  } else if (el === activeEl) {
    el.muted = false;
    if (gains.get(el) === undefined) gains.set(el, 1);
    applyAudibleVolume(el);
  }
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
  if (xfade) collapseCrossfade('none');
  const prev = activeEl;
  activeEl = el;
  if (prev && prev !== el) parkElement(prev);
  if (restart) {
    try {
      if (el.currentTime !== 0) el.currentTime = 0;
    } catch { /* 还没有 metadata，play() 会从头开始 */ }
  }
  el.muted = false;
  gains.set(el, 1);
  applyAudibleVolume(el);
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
/**
 * 与任何 songKey 都不同（无歌时的键是空串）。
 * 窗口刚打开时用它清游标，下一次同步一定会带上标题、封面和整份歌词。
 */
const OUTPUT_UNSYNCED = '\u0000';

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
  try {
    navigator.mediaSession.playbackState = player.playing ? 'playing' : (song ? 'paused' : 'none');
  } catch (_e) { /* 部分环境不允许写 playbackState */ }
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

/**
 * 桌面歌词 / 迷你播放器刚打开时要全量状态。
 * 只推进度时透明窗口看起来像按钮没反应。
 */
export function forceSyncOutputs(): void {
  _lastSyncedKey = OUTPUT_UNSYNCED;
  syncOutputs(true);
}

let _outputSyncReady = false;

/**
 * 订阅一次：窗口打开后的全量回推，以及迷你播放器上的上一首 / 下一首 / 播放。
 * 主进程在页面 load 完成时才来要状态，订晚了首帧就只剩进度。
 */
export function initOutputSync(): void {
  if (_outputSyncReady) return;
  _outputSyncReady = true;
  on('onSyncDesktopLyric', () => forceSyncOutputs());
  on('onSyncMiniPlayer', () => forceSyncOutputs());
  on('onMiniNext', () => next());
  on('onMiniPrev', () => prev());
  on('onMiniTogglePlay', () => togglePlay());
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

function beginCrossfade(
  fromEl: HTMLAudioElement,
  toEl: HTMLAudioElement,
  song: Song,
  index: number,
  fadeOutMs: number,
  fadeInMs: number,
): void {
  // 丢掉还在飞的冷取流，免得它在交叉中途把主元素换掉。
  _reqSeq += 1;
  const fromId = elementId(fromEl);
  const toId = elementId(toEl);
  xfade = {
    fromEl,
    toEl,
    toSong: song,
    toIndex: index,
    fromSong: player.current,
    fromIndex: indexOfElement(fromEl),
    metaSwapped: false,
  };
  toEl.muted = false;
  toEl.playbackRate = player.rate;
  try {
    if (toEl.currentTime !== 0) toEl.currentTime = 0;
  } catch { /* 还没有 metadata，play() 会从头开始 */ }
  gains.set(toEl, 0);
  applyAudibleVolume(toEl);
  const pending = toEl.play();
  if (pending && typeof pending.then === 'function') {
    pending.catch((e) => {
      if (!xfade || xfade.toEl !== toEl) return;
      if (isBenignPlayError(e)) return;
      collapseCrossfade('from');
      void playSong(song, { index, forceHard: true });
    });
  }
  xfCtrl.start({
    fromId,
    toId,
    fadeOutMs,
    fadeInMs,
    preloadOk: true,
  });
}

/** 手动切歌：备用元素已经热好，并且决策允许重叠时才交叉。否则返回 false，调用方硬切。 */
function tryBeginCrossfade(song: Song, index: number): boolean {
  const fromEl = activeEl;
  if (!fromEl || !fromEl.src || fromEl.error || fromEl.paused) return false;
  const incoming = bufferedElement(song, player.quality);
  if (!incoming || incoming === fromEl || incoming.error) return false;
  const decision = decideCrossfade({
    fadeMs: player.crossfadeMs,
    enabled: player.crossfadeMs > 0,
    preloadOk: true,
    remainingMs: remainingMsOf(fromEl),
    sameStream: false,
    predictable: player.mode !== 'shuffle',
    trigger: 'manual',
  });
  if (decision.mode !== 'none') return false;
  beginCrossfade(fromEl, incoming, song, index, decision.fadeOutMs, decision.fadeInMs);
  return true;
}

/**
 * 自动连播：在当前曲结束前启动交叉。没缓好就什么都不做，
 * 等 ended 走原来的硬切 —— 这里不再发一次取流，避免预载失败打成换源风暴。
 */
function maybeAutoCrossfade(el: HTMLAudioElement): void {
  if (xfade || el !== activeEl || el.paused) return;
  if (player.mode === 'shuffle' || player.mode === 'single') return;
  if (!(player.crossfadeMs > 0)) return;
  const idx = neighborIndex(player.queue.length, player.queueIdx, player.mode, 1);
  if (idx == null) return;
  const song = player.queue[idx];
  if (!song) return;
  const incoming = bufferedElement(song, player.quality);
  if (!incoming || incoming === el || incoming.error) return;
  const decision = decideCrossfade({
    fadeMs: player.crossfadeMs,
    enabled: true,
    preloadOk: true,
    remainingMs: remainingMsOf(el),
    sameStream: false,
    predictable: true,
    trigger: 'auto',
  });
  if (decision.mode !== 'none') return;
  beginCrossfade(el, incoming, song, idx, decision.fadeOutMs, decision.fadeInMs);
}

interface PlaySongRequest {
  index?: number;
  forceHard?: boolean;
}

/**
 * 播放单曲（不改变队列；调用方通常先 setQueue）。
 * 邻居已在备用元素上时走交叉，当前曲和媒体键标题留到交叉中点再换。
 */
export async function playSong(song: unknown, request: PlaySongRequest = {}): Promise<void> {
  const s = normalizeSong(song);
  if (!s) return;
  if (xfade) collapseCrossfade('none');
  const index = Number.isInteger(request.index) ? Number(request.index) : player.queueIdx;
  if (!request.forceHard && tryBeginCrossfade(s, index)) return;
  const reqId = ++_reqSeq;
  player.queueIdx = index;
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
    } else {
      // 取流失败时 activate 还没换元素，上一首会在新标题下面继续出声。
      if (activeEl) activeEl.pause();
      player.playing = false;
      player.progress = 0;
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
  if (xfade) {
    const keep = xfade.metaSwapped ? 'to' : 'from';
    collapseCrossfade(keep, { pause: true });
    return;
  }
  const a = ensureActive();
  if (!a.src) {
    if (player.current) void playSong(player.current);
    return;
  }
  if (a.paused) a.play().catch((e) => { if (!isBenignPlayError(e)) player.error = '恢复播放失败'; });
  else a.pause();
}

export function seekTo(seconds: number): void {
  if (xfade) {
    const keep = xfade.metaSwapped ? 'to' : 'from';
    collapseCrossfade(keep);
  }
  const a = activeEl;
  const s = Math.max(0, Number(seconds) || 0);
  if (a && a.src) a.currentTime = s;
  player.progress = s;
}

export function setVolume(v: number, persist = true): void {
  const n = Math.min(1, Math.max(0, Number(v) || 0));
  player.volume = n;
  // 交叉途中两路都按各自增益立刻跟着滑条走，不能只改正在听的那一个。
  if (activeEl) applyAudibleVolume(activeEl);
  if (xfade) {
    applyAudibleVolume(xfade.fromEl);
    applyAudibleVolume(xfade.toEl);
  }
  if (persist) void setPref('playerVolume', n);
}

export function setCrossfadeMs(ms: number, persist = true): number {
  const n = normalizeCrossfadeMs(ms);
  player.crossfadeMs = n;
  if (persist) void setPref(CROSSFADE_PREF_KEY, n);
  if (n <= 0 && xfade) {
    const keep = xfade.metaSwapped ? 'to' : 'from';
    collapseCrossfade(keep);
  }
  return n;
}

export function setRate(r: number | string, persist = true): number {
  const n = Math.min(2, Math.max(0.5, Number(r) || 1));
  player.rate = n;
  if (activeEl) activeEl.playbackRate = n;
  if (xfade) {
    xfade.fromEl.playbackRate = n;
    xfade.toEl.playbackRate = n;
  }
  if (persist) void setPref('playbackRate', n);
  return n;
}

export function setQuality(q: string | null | undefined, persist = true): void {
  const nextQ = q || 'standard';
  if (nextQ === player.quality) return;
  if (xfade) {
    const keep = xfade.metaSwapped ? 'to' : 'from';
    collapseCrossfade(keep);
  }
  player.quality = nextQ;
  if (persist) void setPref('quality', nextQ);
  // 旧音质的缓冲不能拿来播。正在听的这首不打断，邻居按新音质重取。
  prep.invalidate();
  if (activeEl && activeEl.src) armNeighbors(player.queue[player.queueIdx] || null);
}

export function cycleMode(): PlayMode {
  if (xfade) collapseCrossfade(xfade.metaSwapped ? 'to' : 'from');
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
  // 交叉期间出走元素的 ended 会再进这里。那一次必须吞掉，否则会连跳两首。
  if (xfade && auto) return;
  if (xfade && !auto) {
    const stand = xfade.toIndex;
    collapseCrossfade('none');
    player.queueIdx = stand;
  }
  // 单曲循环播完：同一条已经打开的流回到开头，不再取一次 URL。
  if (player.mode === 'single' && auto && activeEl && activeEl.src && !activeEl.error) {
    player.progress = 0;
    try { activeEl.currentTime = 0; } catch { /* metadata 未到时从头 play 即可 */ }
    gains.set(activeEl, 1);
    activeEl.muted = false;
    applyAudibleVolume(activeEl);
    activeEl.play().catch((e) => {
      if (!isBenignPlayError(e)) player.error = '播放失败';
    });
    return;
  }
  const idx = pickIndex(1);
  if (idx < 0) { player.playing = false; return; }
  if (idx === player.queueIdx && player.mode !== 'single') { player.playing = false; return; }
  void playSong(player.queue[idx], { index: idx });
}

export function prev(): void {
  if (xfade) {
    const stand = xfade.toIndex;
    collapseCrossfade('none');
    player.queueIdx = stand;
  }
  const idx = pickIndex(-1);
  if (idx < 0) return;
  void playSong(player.queue[idx], { index: idx });
}

export function removeFromQueue(index: number): void {
  if (xfade) {
    const keep = xfade.metaSwapped ? 'to' : 'from';
    collapseCrossfade(keep);
  }
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
  if (xfade) collapseCrossfade('none');
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