/**
 * 发现页：歌单 / 歌手摘要 → 可播放的歌曲列表。
 *
 * 只做截断、去重和来源标注。拉曲目的请求由调用方注入，
 * 这里不碰 IPC，单测才能离线跑。
 *
 * 上限故意小：发现页大约二十首就够点开就播，
 * 不能先把「30 个歌单 × 300 首」拉回来再丢掉。
 * 歌单来源会在每首歌上留下 id + 平台，打开完整歌单时用；
 * 只有名称对不上那一个歌单。
 */
import { normalizeSong, songKey } from './song';
import type { Song } from './song';

export const DISCOVER_FEED_CAPS = Object.freeze({
  /** 一个分区最多展开多少个歌单或歌手 */
  sources: 6,
  /** 每个来源最多收几首（去重之后） */
  perSource: 6,
  /** 去重后的展示上限 */
  total: 20,
});

export interface DiscoverFeedCaps {
  sources?: number;
  perSource?: number;
  total?: number;
}

/** 歌单或歌手摘要里，展开时真正用得上的字段 */
export interface DiscoverSourceRef {
  id: string;
  name: string;
  source: string;
  /**
   * playlist 才会在歌曲上留下可打开的歌单身份。
   * singer 只用来源名做标签：没有可复用的歌手曲目面板。
   */
  kind?: 'playlist' | 'singer';
}

/** 一首展开歌指向的那一个歌单。缺 id 或平台就不能打开。 */
export interface DiscoverPlaylistRef {
  id: string;
  source: string;
  name: string;
}

export interface DiscoverSourceBundle {
  summary?: Partial<DiscoverSourceRef> | null;
  songs?: unknown;
}

function capAt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * 从首页分区的原始行里取出前若干个歌单或歌手。
 * 没有 id 的行跳过，不占名额。缺平台时用分区所属平台补上。
 */
export function readDiscoverSources(
  items: unknown,
  limit: number = DISCOVER_FEED_CAPS.sources,
  fallbackSource = '',
): DiscoverSourceRef[] {
  const max = capAt(limit, DISCOVER_FEED_CAPS.sources);
  if (max === 0) return [];
  const list = Array.isArray(items) ? items : [];
  const out: DiscoverSourceRef[] = [];
  const fallback = text(fallbackSource);
  for (const item of list) {
    if (out.length >= max) break;
    if (!item || typeof item !== 'object') continue;
    const row = item as {
      id?: unknown;
      mid?: unknown;
      name?: unknown;
      title?: unknown;
      source?: unknown;
      platform?: unknown;
    };
    const id = text(row.id ?? row.mid);
    if (!id) continue;
    out.push({
      id,
      name: text(row.name ?? row.title),
      source: text(row.source ?? row.platform) || fallback,
    });
  }
  return out;
}

function summaryName(summary: DiscoverSourceBundle['summary']): string {
  if (!summary || typeof summary !== 'object') return '';
  return text(summary.name);
}

function summarySource(summary: DiscoverSourceBundle['summary']): string {
  if (!summary || typeof summary !== 'object') return '';
  return text(summary.source);
}

/**
 * 只有明确标成歌单、并且 id 和平台都在的摘要才写得进歌曲。
 * 歌手、榜单，或只剩一个名字的行，打开时会对不上那一个歌单。
 */
function playlistIdentity(summary: DiscoverSourceBundle['summary']): DiscoverPlaylistRef | null {
  if (!summary || typeof summary !== 'object' || summary.kind !== 'playlist') return null;
  const id = text(summary.id);
  const source = text(summary.source);
  if (!id || !source) return null;
  return { id, source, name: text(summary.name) };
}

/**
 * 从展开后的歌曲上读歌单身份。
 * 名称可以空，id 和平台不能空；形状不对就当没有，避免把别的字段当成歌单。
 */
export function discoverPlaylistOf(song: unknown): DiscoverPlaylistRef | null {
  if (!song || typeof song !== 'object') return null;
  const raw = (song as { fromPlaylist?: unknown }).fromPlaylist;
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as { id?: unknown; source?: unknown; name?: unknown };
  const id = text(row.id);
  const source = text(row.source);
  if (!id || !source) return null;
  return { id, source, name: text(row.name) };
}

/**
 * 把若干来源的曲目收成一条榜。
 * 同一 id + source 只保留先出现的那首，来源名写在 `from` 上。
 * 歌曲对象上原来的 from / fromPlaylist 丢掉，避免平台字段冒充歌单。
 * 歌单来源另外写 `fromPlaylist`（id + source + name），打开完整列表时用。
 */
export function expandDiscoverFeed(
  bundles: readonly DiscoverSourceBundle[] | null | undefined,
  caps?: DiscoverFeedCaps,
): Song[] {
  const sources = capAt(caps?.sources, DISCOVER_FEED_CAPS.sources);
  const perSource = capAt(caps?.perSource, DISCOVER_FEED_CAPS.perSource);
  const total = capAt(caps?.total, DISCOVER_FEED_CAPS.total);
  if (sources === 0 || perSource === 0 || total === 0) return [];

  const groups = Array.isArray(bundles) ? bundles.slice(0, sources) : [];
  const seen = new Set<string>();
  const out: Song[] = [];
  for (const bundle of groups) {
    if (out.length >= total) break;
    const label = summaryName(bundle?.summary);
    const fallbackSource = summarySource(bundle?.summary);
    const songs = Array.isArray(bundle?.songs) ? bundle.songs : [];
    let taken = 0;
    for (const raw of songs) {
      if (out.length >= total || taken >= perSource) break;
      const song = normalizeSong(raw);
      if (!song || !song.id) continue;
      if (!song.source && fallbackSource) song.source = fallbackSource;
      const key = songKey(song);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      taken += 1;
      delete song.from;
      delete song.fromPlaylist;
      if (label) song.from = label;
      const playlist = playlistIdentity(bundle?.summary);
      if (playlist) song.fromPlaylist = playlist;
      out.push(song);
    }
  }
  return out;
}

/**
 * 按来源去拉曲目。某一组失败只让这组变空，不拖垮整份榜单。
 * 结果顺序跟 refs 一致，不跟谁先返回。
 */
export async function collectDiscoverBundles(
  refs: readonly DiscoverSourceRef[] | null | undefined,
  fetchSongs: (ref: DiscoverSourceRef) => Promise<unknown>,
): Promise<DiscoverSourceBundle[]> {
  const list = Array.isArray(refs) ? refs : [];
  return Promise.all(list.map(async (summary) => {
    try {
      const songs = await fetchSongs(summary);
      return { summary, songs };
    } catch {
      return { summary, songs: [] as unknown[] };
    }
  }));
}
