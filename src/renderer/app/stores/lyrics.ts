/**
 * stores/lyrics.ts —— 歌词获取与解析
 *
 * 不依赖 player（避免 store 循环）：组件用 progress 自行求当前行。
 * LRC 支持一行多个时间标签、[offset:] 元信息与毫秒/厘秒两种小数位。
 */
import { reactive, computed } from 'vue';
import type { ComputedRef } from 'vue';
import { callSafe } from '../core/bridge';
import { getPref, setPref } from '../core/prefs';
import type { SongLike } from '../core/song';
import type {
  DesktopLyricLine,
  LocalLrcResult,
  LyricLine,
  OnlineLrcResult,
} from './types';

/** 歌词状态 */
interface LyricsState {
  /** 解析后的歌词行（t 为秒） */
  items: LyricLine[];
  loading: boolean;
  error: string;
  /** 正数 = 歌词提前 */
  offsetMs: number;
  loadedKey: string;
}

export const lyrics = reactive<LyricsState>({
  items: [],        // [{ t: 秒, text }]
  loading: false,
  error: '',
  offsetMs: 0,      // 正数=歌词提前
  loadedKey: '',
});

export const hasLyrics: ComputedRef<boolean> = computed(() => lyrics.items.length > 0);

const TAG_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_RE = /^\[(ar|ti|al|by|offset|length):(.*)\]$/i;

/**
 * 解析 LRC。返回按时间升序的 [{t, text}]。
 * @param text 原始 LRC 文本；非字符串返回空数组
 */
export function parseLrc(text: unknown): LyricLine[] {
  if (!text || typeof text !== 'string') return [];
  let offsetMs = 0;
  const out: LyricLine[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const meta = line.match(META_RE);
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') {
        const n = Number(meta[2]);
        if (Number.isFinite(n)) offsetMs = n;
      }
      continue;
    }
    const times: number[] = [];
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(line))) {
      const min = Number(m[1]) || 0;
      const sec = Number(m[2]) || 0;
      let frac = 0;
      if (m[3] != null) {
        const d = String(m[3]);
        frac = d.length === 3 ? Number(d) / 1000 : d.length === 2 ? Number(d) / 100 : Number(d) / 10;
      }
      times.push(min * 60 + sec + frac);
    }
    if (!times.length) continue;
    const content = line.replace(TAG_RE, '').trim();
    if (!content) continue;
    for (const t of times) out.push({ t, text: content });
  }
  // offset 为正表示歌词整体提前（LRC 规范：常量为毫秒）
  const shift = offsetMs / 1000;
  return out
    .map((l) => ({ t: Math.max(0, l.t - shift), text: l.text }))
    .sort((a, b) => a.t - b.t);
}

/** 当前播放位置对应的歌词行（-1 表示还没到第一句） */
export function activeLineIndex(items: readonly LyricLine[] | null | undefined, seconds: number): number {
  if (!Array.isArray(items) || !items.length) return -1;
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].t <= seconds) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

export async function loadOffset(): Promise<void> {
  const v = await getPref('lyricOffsetMs', 0);
  const n = Number(v);
  lyrics.offsetMs = Number.isFinite(n) ? n : 0;
}

export async function setOffset(ms: number): Promise<void> {
  const n = Number(ms) || 0;
  lyrics.offsetMs = n;
  await setPref('lyricOffsetMs', n);
}

/**
 * 为歌曲加载歌词：本地读 .lrc，在线走 get-lyrics。
 * @param song 归一化后的歌曲对象
 */
export async function loadFor(song: SongLike | null | undefined): Promise<void> {
  if (!song) {
    lyrics.items = [];
    lyrics.error = '';
    lyrics.loadedKey = '';
    return;
  }
  const key = `${song.id}:${song.source}`;
  lyrics.loading = true;
  lyrics.error = '';
  lyrics.loadedKey = key;
  lyrics.items = [];
  try {
    let lrc = '';
    if (song.filePath) {
      const r = await callSafe<LocalLrcResult | null>('readLocalLrc', [song.filePath], null);
      lrc = (r && (r.lrc || r.content)) || '';
      if (!lrc && song.embeddedLyrics) lrc = song.embeddedLyrics as string;
    } else {
      const r = await callSafe<OnlineLrcResult | null>(
        'getLyrics', [song.id, song.source, song.title, song.artist], null,
      );
      lrc = (r && r.lrc) || '';
      if (!lrc && r && r.error) lyrics.error = r.error;
    }
    if (lyrics.loadedKey !== key) return;   // 期间已切歌
    const items = parseLrc(lrc);
    if (!items.length) {
      lyrics.error = lyrics.error || '暂无歌词';
    } else {
      lyrics.items = items;
    }
  } catch (e) {
    if (lyrics.loadedKey === key) lyrics.error = errorMessage(e) || '歌词加载失败';
  } finally {
    if (lyrics.loadedKey === key) lyrics.loading = false;
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

export function clearLyrics(): void {
  lyrics.items = [];
  lyrics.error = '';
  lyrics.loading = false;
  lyrics.loadedKey = '';
}

/** 桌面歌词窗口需要的瘦身字段 */
export function forDesktop(): DesktopLyricLine[] {
  return lyrics.items.map((l) => ({ t: l.t, text: l.text, subText: '', words: [], wordTimes: [] }));
}