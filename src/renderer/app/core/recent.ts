/**
 * core/recent.ts —— 最近播放（复用旧层 prefs 键 recentlyPlayed）
 *
 * 存储形如 JSON 字符串数组，字段与旧层 stats.js 完全一致：
 * { id,title,artist,album,source,filePath,cover,duration,playedAt }
 * 不新增键 = 新老界面切换时最近播放不丢。
 */
import { reactive } from 'vue';
import { getPref, setPref } from './prefs';

const MAX_RECENT = 50;
const PREF_KEY = 'recentlyPlayed';

/** 最近播放条目（持久化形状，与旧层 stats.js 对齐） */
export interface RecentEntry {
  id?: string | number | null;
  title: string;
  artist: string;
  album: string;
  source: string;
  filePath: string;
  cover: string;
  duration: number;
  playedAt: number;
}

/** addRecent / removeRecent 只关心这几个字段，按结构兼容各类歌曲对象 */
export interface RecentSongInput {
  id?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  source?: unknown;
  filePath?: unknown;
  cover?: unknown;
  duration?: unknown;
}

export const recent = reactive({
  items: [] as RecentEntry[],
  loaded: false,
});

export async function loadRecent(): Promise<void> {
  const raw = await getPref(PREF_KEY, null);
  let arr: RecentEntry[] = [];
  if (raw) {
    try {
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) arr = parsed as RecentEntry[];
    } catch (_e) { arr = []; }
  }
  recent.items = arr.slice(0, MAX_RECENT);
  recent.loaded = true;
}

function persist(): void {
  void setPref(PREF_KEY, JSON.stringify(recent.items));
}

/** 记录一次播放：同歌同源去重置顶，最多 50 条 */
export function addRecent(song: RecentSongInput | null | undefined): void {
  if (!song || !song.title) return;
  const idx = recent.items.findIndex(
    (s) => s.title === song.title && s.artist === song.artist && s.source === song.source,
  );
  if (idx >= 0) recent.items.splice(idx, 1);
  recent.items.unshift({
    id: song.id as RecentEntry['id'],
    // 与原实现一致：字段有值就原样落库（调用方通常已过 normalizeSong）
    title: song.title as string,
    artist: (song.artist as string) || '未知艺术家',
    album: (song.album as string) || '',
    source: (song.source as string) || '',
    filePath: (song.filePath as string) || '',
    cover: (song.cover as string) || '',
    duration: Number(song.duration) || 0,
    playedAt: Date.now(),
  });
  if (recent.items.length > MAX_RECENT) recent.items.length = MAX_RECENT;
  persist();
}

export function clearRecent(): void {
  recent.items.splice(0);
  persist();
}

export function removeRecent(entry: RecentSongInput): void {
  const i = recent.items.findIndex(
    (s) => s.title === entry.title && s.artist === entry.artist && s.source === entry.source,
  );
  if (i >= 0) recent.items.splice(i, 1);
  persist();
}