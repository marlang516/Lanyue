/**
 * stores/player.ts —— 播放状态与取流链路（P1 基础闭环，P4 增强）
 *
 * 链路与旧层一致：
 *   getDownloadUrlSmart(song, quality) → {url, source, id, degradedLocal?}
 *   → proxyPlay(url, referer, {id, source, quality}) → {fileUrl}
 *   → audio.src = lanyue-stream://...
 *
 * 竞态：切歌后旧请求的结果必须丢弃（_reqSeq），否则慢源会盖掉快源。
 * 唯一 audio 所有者：本模块，视图只读 state。
 */
import { reactive, computed, watch } from 'vue';
import type { ComputedRef } from 'vue';
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

let audio: HTMLAudioElement | null = null;
let _reqSeq = 0;

function ensureAudio(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  audio = a;
  a.preload = 'auto';
  a.addEventListener('timeupdate', () => {
    player.progress = a.currentTime || 0;
    if (Number.isFinite(a.duration) && a.duration > 0) player.duration = a.duration;
    syncOutputs();
  });
  a.addEventListener('play', () => { player.playing = true; syncOutputs(true); });
  a.addEventListener('pause', () => { player.playing = false; syncOutputs(true); });
  a.addEventListener('ended', () => next(true));
  a.addEventListener('error', () => {
    player.error = '播放失败：音源不可达或已过期';
    player.playing = false;
  });
  a.playbackRate = player.rate;
  bindMediaHandlers();
  return a;
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

/** 仅设置队列与当前项，不触发取流 */
export function setQueue(list: unknown, index = 0): void {
  player.queue = (Array.isArray(list) ? list : []).map(normalizeSong).filter((s): s is Song => s !== null);
  player.queueIdx = Math.max(0, Math.min(index, player.queue.length - 1));
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
  player.duration = s.duration || 0;
  player.loading = true;
  // 歌词异步加载：不阻塞出声，到达后歌词面板/桌面歌词自动刷新
  void loadLyricsFor(s);

  const a = ensureAudio();

  // 本地文件直出：与旧层一致（file:// + 绝对路径），不走取流/代理
  if (s.filePath) {
    try {
      a.src = 'file://' + s.filePath;
      await a.play();
      player.loading = false;
      addRecent(s);
    } catch (e) {
      player.loading = false;
      player.error = errorMessage(e) || '本地文件播放失败';
    }
    return;
  }

  try {
    const result = await call<PlayUrlInfo>('getDownloadUrlSmart', s, player.quality);
    if (reqId !== _reqSeq) return;
    if (!result || !result.url) {
      player.error = (result && (result.error || result.code)) || '无可用音源';
      return;
    }

    let fileUrl = result.url;
    if (!result.degradedLocal) {
      const playSource = result.source || s.source;
      const proxied = await call<ProxyPlayResult>('proxyPlay', result.url, REFERERS[playSource] || '', {
        id: String(result.id ?? s.id),
        source: playSource,
        quality: player.quality,
      });
      if (reqId !== _reqSeq) return;
      if (!proxied || !proxied.fileUrl) {
        player.error = (proxied && proxied.error) || '流代理失败';
        return;
      }
      fileUrl = proxied.fileUrl;
    }

    a.src = fileUrl;
    await a.play();
    addRecent(s);
  } catch (e) {
    if (reqId === _reqSeq) player.error = errorMessage(e) || '播放异常';
  } finally {
    if (reqId === _reqSeq) player.loading = false;
  }
}

/** 从 unknown 异常里取可读文案（等价于 `(e && e.message) || 兜底`） */
function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

export function togglePlay(): void {
  const a = ensureAudio();
  if (!a.src) {
    if (player.current) void playSong(player.current);
    return;
  }
  if (a.paused) a.play().catch(() => { player.error = '恢复播放失败'; });
  else a.pause();
}

export function seekTo(seconds: number): void {
  const a = ensureAudio();
  const s = Math.max(0, Number(seconds) || 0);
  if (a.src) a.currentTime = s;
  player.progress = s;
}

export function setVolume(v: number): void {
  const n = Math.min(1, Math.max(0, Number(v) || 0));
  ensureAudio().volume = n;
  player.volume = n;
}

export function setRate(r: number | string): number {
  const n = Math.min(2, Math.max(0.5, Number(r) || 1));
  player.rate = n;
  ensureAudio().playbackRate = n;
  return n;
}

export function setQuality(q: string | null | undefined): void {
  player.quality = q || 'standard';
}

export function cycleMode(): PlayMode {
  const order: PlayMode[] = ['order', 'list-loop', 'single', 'shuffle'];
  const i = order.indexOf(player.mode);
  player.mode = order[(i + 1) % order.length];
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
  if (player.mode === 'single' && auto) {
    void playSong(player.current);
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
    return;
  }
  if (index < player.queueIdx) player.queueIdx -= 1;
  else if (wasCurrent) player.queueIdx = Math.min(index, player.queue.length - 1);
}

export function clearQueue(): void {
  player.queue.splice(0);
  player.queueIdx = -1;
}

/** 把歌曲追加到队列（不打断当前播放） */
export function appendToQueue(songs: unknown): number {
  const list = (Array.isArray(songs) ? songs : [songs])
    .map(normalizeSong)
    .filter((s): s is Song => s !== null);
  if (!list.length) return 0;
  player.queue.push(...list);
  if (player.queueIdx < 0) player.queueIdx = 0;
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
    player.duration = cur.duration || 0;
    player.progress = 0;
    void loadLyricsFor(cur);
  }
}

// 队列结构变化时落盘（主进程内部 500ms 防抖）
watch(() => [player.queue.length, player.queueIdx], () => { void persistQueue(); });