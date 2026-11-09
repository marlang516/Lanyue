/**
 * core/song.ts —— 歌曲对象的规范化、去重与排序（纯函数）
 *
 * 主进程返回的歌曲对象字段在各平台略有差异（id 可能是数字/字符串、
 * 封面字段可能是 cover/pic/albumCover），所有视图必须先过 normalizeSong，
 * 否则「同一首歌两个 key」会让收藏/去重/播放高亮全部漂移。
 */

/**
 * 平台原始歌曲：字段名各平台不一致，值一律 unknown，
 * 由 normalizeSong 负责探测与归一。
 */
export interface SongLike {
  id?: unknown;
  songId?: unknown;
  songmid?: unknown;
  source?: unknown;
  platform?: unknown;
  title?: unknown;
  name?: unknown;
  songName?: unknown;
  artist?: unknown;
  singer?: unknown;
  artists?: unknown;
  album?: unknown;
  albumName?: unknown;
  cover?: unknown;
  pic?: unknown;
  albumCover?: unknown;
  coverUrl?: unknown;
  duration?: unknown;
  dt?: unknown;
  interval?: unknown;
  durationMs?: unknown;
  lossless?: unknown;
  quality?: unknown;
  bitrate?: unknown;
  filePath?: unknown;
  [key: string]: unknown;
}

/** normalizeSong 的输出：关键字段已完成类型归一，额外字段原样保留 */
export interface Song {
  id: string;
  source: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
  duration: number;
  lossless: boolean;
  quality?: string;
  bitrate?: number;
  filePath?: string;
  [key: string]: unknown;
}

/** 与主进程 songKey 约定一致：id + source */
export function songKey(song: unknown): string {
  if (!song) return '';
  const s = song as SongLike;
  return `${String(s.id ?? '')}:${String(s.source ?? '')}`;
}

export function normalizeSong(raw: unknown): Song | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as SongLike;
  const id = r.id ?? r.songId ?? r.songmid ?? '';
  const source = r.source ?? r.platform ?? '';
  const title = r.title ?? r.name ?? r.songName ?? '未命名';
  const artist = r.artist ?? r.singer ?? r.artists ?? '';
  const album = r.album ?? r.albumName ?? '';
  const cover = r.cover ?? r.pic ?? r.albumCover ?? r.coverUrl ?? '';
  const duration = Number(
    r.duration ?? r.dt ?? r.interval
    ?? (r.durationMs ? Number(r.durationMs) / 1000 : 0),
  ) || 0;
  // 先用索引签名把额外字段原样带出，再用归一字段覆盖（避免 SongLike 的
  // 可选 unknown 字段与 Song 的具体字段类型冲突）
  const out: Song = {
    ...(r as Record<string, unknown>),
    id: String(id),
    source: String(source),
    title: String(title || '未命名'),
    artist: Array.isArray(artist) ? artist.join(' / ') : String(artist || ''),
    album: String(album || ''),
    cover: cover ? String(cover) : '',
    duration,
    lossless: !!(r.lossless || r.quality === 'lossless'),
  };
  return out;
}

export function normalizeSongs(list: unknown): Song[] {
  const arr = Array.isArray(list) ? list : [];
  return arr.map((item) => normalizeSong(item)).filter((s): s is Song => s !== null);
}

/** 按 songKey 去重，保留首次出现项 */
export function dedupeSongs<T extends SongLike>(list: readonly T[] | null | undefined): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of Array.isArray(list) ? list : []) {
    const k = songKey(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** 是否同一首歌（视图高亮统一走这里，别各自拼 key） */
export function isSameSong(a: unknown, b: unknown): boolean {
  if (!a || !b) return false;
  return songKey(a) === songKey(b) && !!songKey(a);
}

export type SongSortKey = 'default' | 'title' | 'artist' | 'album' | 'duration' | 'source';
export type SongSortDirection = 'asc' | 'desc';

/** 排序取值：number 保留数值比较，其余转字符串（与原实现一致） */
function sortValue(v: unknown): string | number {
  if (typeof v === 'number') return v;
  return v ? String(v) : '';
}

/**
 * 通用排序器。
 * @param by 排序字段；允许任意字符串（未知值按 default 处理）
 * @param dir asc / desc
 */
export function sortSongs(
  list: readonly SongLike[] | null | undefined,
  by: SongSortKey | (string & {}) = 'default',
  dir: SongSortDirection | (string & {}) = 'asc',
): SongLike[] {
  const arr: SongLike[] = Array.isArray(list) ? list.slice() : [];
  if (by === 'default') return arr;
  const pick = (s: SongLike): string | number => {
    switch (by) {
      case 'title': return sortValue(s.title);
      case 'artist': return sortValue(s.artist);
      case 'album': return sortValue(s.album);
      case 'duration': return Number(s.duration) || 0;
      case 'source': return sortValue(s.source);
      default: return '';
    }
  };
  const sign = dir === 'desc' ? -1 : 1;
  return arr.sort((a, b) => {
    const x = pick(a);
    const y = pick(b);
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y), 'zh-Hans-CN') * sign;
  });
}

/** 本地搜索式过滤：标题/歌手/专辑 任一命中 */
export function filterSongs(list: readonly SongLike[] | null | undefined, keyword: unknown): SongLike[] {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return Array.isArray(list) ? list.slice() : [];
  return (Array.isArray(list) ? list : []).filter((s) => {
    const hay = `${String(s.title || '')} ${String(s.artist || '')} ${String(s.album || '')}`.toLowerCase();
    return hay.includes(kw);
  });
}