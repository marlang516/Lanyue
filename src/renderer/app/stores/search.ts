/**
 * stores/search.ts —— 搜索域状态（单曲 / 专辑 / 歌手）
 *
 * 请求序号守卫：切换关键词、类型、翻页、连点专辑时，迟到的旧响应
 * 一律丢弃。这是旧层 renderer-audit 钉过的真实缺陷（点 A 显示 B）。
 */
import { reactive, computed } from 'vue';
import type { ComputedRef } from 'vue';
import { call, callSafe } from '../core/bridge';
import { normalizeSongs, songKey, sortSongs } from '../core/song';
import type { Song, SongLike } from '../core/song';
import { toast, errText } from '../core/toast';
import { getPref } from '../core/prefs';
import { appendToQueue } from './player';
import type {
  AddQueueResult,
  DownloadOutcome,
  PlatformInfo,
  SearchAlbum,
  SearchAlbumResult,
  SearchDetail,
  SearchSinger,
  SearchSingerResult,
  SearchSongResult,
  SearchSortKey,
  SearchType,
  SingerAlbumsResult,
} from './types';

const PAGE_SIZE = 20;

/** 搜索域状态 */
interface SearchState {
  keyword: string;
  source: string;
  /** song | album | singer */
  type: SearchType;
  page: number;
  songs: Song[];
  albums: SearchAlbum[];
  singers: SearchSinger[];
  total: number;
  hasNext: boolean;
  loading: boolean;
  error: string;
  platforms: PlatformInfo[];
  history: string[];
  showHistory: boolean;
  /** default | duration | source */
  sort: SearchSortKey;
  batchMode: boolean;
  selected: Set<string>;
  /** 专辑/歌手详情：null 时展示搜索结果 */
  detail: SearchDetail | null;
  singerTab: string;
}

export const search = reactive<SearchState>({
  keyword: '',
  source: 'all',
  type: 'song',            // song | album | singer
  page: 1,
  songs: [],
  albums: [],
  singers: [],
  total: 0,
  hasNext: false,
  loading: false,
  error: '',
  platforms: [],
  history: [],
  showHistory: false,
  sort: 'default',         // default | duration | source
  batchMode: false,
  selected: new Set<string>(),
  // 专辑/歌手详情：null 时展示搜索结果
  detail: null,            // { kind, id, name, source, songs?, loading, error }
  singerTab: 'songs',
});

let _reqSeq = 0;

export const selectedCount: ComputedRef<number> = computed(() => search.selected.size);

export const visibleSongs: ComputedRef<SongLike[]> = computed(() => {
  const out = sortSongs(search.songs, search.sort === 'default' ? 'default' : search.sort, 'asc');
  return out;
});

export const platformsWithAll: ComputedRef<PlatformInfo[]> = computed(() => [
  { id: 'all', name: '全部平台', nameEn: 'All' },
  ...search.platforms,
]);

export function isSelected(song: unknown): boolean {
  return search.selected.has(songKey(song));
}

export function isActiveSong(song: unknown): boolean {
  return search.detail === null && search.songs.length > 0 && songKey(song) === songKey(search.songs[0]) ? false : false;
}

export async function initSearch(): Promise<void> {
  const [platforms, history] = await Promise.all([
    callSafe<PlatformInfo[], PlatformInfo[]>('getPlatforms', [], []),
    callSafe<string[], string[]>('getSearchHistory', [], []),
  ]);
  search.platforms = Array.isArray(platforms) ? platforms : [];
  search.history = Array.isArray(history) ? history : [];
}

export function setKeyword(kw: unknown): void {
  search.keyword = String(kw || '');
}

export function setType(type: string): void {
  if (!['song', 'album', 'singer'].includes(type)) return;
  search.type = type as SearchType;
  search.detail = null;
  search.page = 1;
  search.selected.clear();
}

export function setSource(source: string | null | undefined): void {
  search.source = source || 'all';
  search.page = 1;
}

export function cycleSort(): void {
  const order: SearchSortKey[] = ['default', 'duration', 'source'];
  const i = order.indexOf(search.sort);
  search.sort = order[(i + 1) % order.length];
}

function commitHistory(kw: unknown): void {
  const k = String(kw || '').trim();
  if (!k) return;
  search.history = [k, ...search.history.filter((x) => x !== k)].slice(0, 20);
  void callSafe('setSearchHistory', [search.history], null);
}

export async function clearHistory(): Promise<void> {
  search.history = [];
  await callSafe('setSearchHistory', [[]], null);
}

export async function removeHistoryItem(kw: string): Promise<void> {
  search.history = search.history.filter((x) => x !== kw);
  await callSafe('setSearchHistory', [search.history], null);
}

/**
 * 发起搜索。detail 存在时先退出详情（除非调用方要求保留）。
 */
export async function doSearch(page = 1): Promise<void> {
  const kw = String(search.keyword || '').trim();
  if (!kw) return;
  const reqId = ++_reqSeq;
  search.page = Math.max(1, Number(page) || 1);
  search.loading = true;
  search.error = '';
  search.detail = null;
  search.selected.clear();

  try {
    if (search.type === 'song') {
      const r = await call<SearchSongResult>('searchMusic', kw, search.source, search.page);
      if (reqId !== _reqSeq) return;
      search.songs = normalizeSongs(r && r.songs);
      search.albums = [];
      search.singers = [];
      search.total = search.songs.length;
      // hasMore 由聚合层按「该源本页是否取满」给出。旧启发式 length>=20
      // 会把 5sing 这种每页 10 条的源当成没有下一页，也会在全部平台
      // 被截成十几条时让翻页请求打回同一页。
      const more = r && r.hasMore;
      search.hasNext = typeof more === 'boolean' ? more : search.songs.length >= PAGE_SIZE;
      if (!search.songs.length) search.error = (r && r.error) || '没有匹配结果';
    } else if (search.type === 'album') {
      const r = await call<SearchAlbumResult>(
        'searchAlbum', kw, search.source === 'all' ? 'qq' : search.source, search.page,
      );
      if (reqId !== _reqSeq) return;
      search.albums = Array.isArray(r && r.albums) ? (r.albums as SearchAlbum[]) : [];
      search.songs = [];
      search.singers = [];
      search.total = Number(r && r.total) || search.albums.length;
      search.hasNext = search.albums.length >= PAGE_SIZE;
      if (!search.albums.length) search.error = (r && r.error) || '没有匹配专辑';
    } else {
      const r = await call<SearchSingerResult>('searchSinger', kw, search.source, search.page);
      if (reqId !== _reqSeq) return;
      search.singers = Array.isArray(r && r.singers) ? (r.singers as SearchSinger[]) : [];
      search.songs = [];
      search.albums = [];
      search.total = Number(r && r.total) || search.singers.length;
      search.hasNext = search.singers.length >= PAGE_SIZE;
      if (!search.singers.length) search.error = '没有匹配歌手';
    }
    commitHistory(kw);
  } catch (e) {
    if (reqId === _reqSeq) search.error = errText(e, '搜索失败');
  } finally {
    if (reqId === _reqSeq) search.loading = false;
  }
}

export function goPage(delta: number): void {
  const p = search.page + delta;
  if (p < 1) return;
  if (delta > 0 && !search.hasNext) return;
  void doSearch(p);
}

/* ── 批量选择 ─────────────────────────────────────────────── */

export function toggleSelect(song: unknown): void {
  const k = songKey(song);
  if (!k) return;
  if (search.selected.has(k)) search.selected.delete(k);
  else search.selected.add(k);
}

export function toggleSelectAll(): void {
  if (search.selected.size >= search.songs.length) {
    search.selected.clear();
    return;
  }
  for (const s of search.songs) search.selected.add(songKey(s));
}

export function selectedSongs(): Song[] {
  return search.songs.filter((s) => search.selected.has(songKey(s)));
}

export async function addSelectedToQueue(): Promise<void> {
  const list = selectedSongs();
  if (!list.length) { toast.warn('先勾选歌曲'); return; }
  appendToQueue(list);
  toast.success(`已加入播放队列 ${list.length} 首`);
}

/** 批量下载：复用 addToQueue 契约；saveDir/quality 读偏好，缺省交给主进程兜底 */
export async function downloadSelected(): Promise<void> {
  const list = selectedSongs();
  if (!list.length) { toast.warn('先勾选歌曲'); return; }
  await downloadSongs(list);
}

export async function downloadSongs(list: unknown): Promise<DownloadOutcome> {
  const songs = normalizeSongs(list);
  if (!songs.length) return { queued: 0, skipped: 0 };
  const [saveDir, quality] = await Promise.all([
    getPref('saveDir', null),
    getPref('quality', 'standard'),
  ]);
  let queued = 0;
  let skipped = 0;
  let failed = 0;
  for (const s of songs) {
    try {
      const r = await call<AddQueueResult>(
        'addToQueue', { ...s, ...(saveDir ? { saveDir } : {}), quality: quality || 'standard' },
      );
      if (r && r.queued) queued += 1;
      else if (r && r.alreadyDownloaded) skipped += 1;
      else failed += 1;
    } catch (_e) {
      failed += 1;
    }
  }
  let msg = `已加入下载队列 ${queued} 首`;
  if (skipped) msg += `，跳过已下载 ${skipped} 首`;
  if (failed) msg += `，失败 ${failed} 首`;
  (queued ? toast.success : toast.warn)(msg);
  return { queued, skipped, failed };
}

/* ── 专辑 / 歌手详情 ──────────────────────────────────────── */

export async function openAlbum(mid: string, source?: string): Promise<void> {
  const reqId = ++_reqSeq;
  search.detail = { kind: 'album', id: mid, name: '专辑', source, loading: true, songs: [], error: '' };
  const d = search.detail;
  search.selected.clear();
  try {
    const songs = await call<unknown>('getAlbumSongs', source || 'qq', mid, 999);
    if (reqId !== _reqSeq) return;
    d.songs = normalizeSongs(songs);
    d.loading = false;
    if (!d.songs.length) d.error = '专辑暂无歌曲';
  } catch (e) {
    if (reqId !== _reqSeq) return;
    d.loading = false;
    d.error = errText(e, '加载专辑失败');
  }
}

export async function openSinger(mid: string, name?: string, source?: string): Promise<void> {
  const reqId = ++_reqSeq;
  search.detail = {
    kind: 'singer', id: mid, name: name || '歌手', source: source || 'qq',
    loading: true, songs: [], albums: [], error: '',
  };
  search.singerTab = 'songs';
  search.selected.clear();
  await loadSingerDetail(reqId);
}

export async function switchSingerTab(tab: string): Promise<void> {
  if (!['songs', 'albums'].includes(tab)) return;
  search.singerTab = tab;
  const reqId = ++_reqSeq;
  await loadSingerDetail(reqId);
}

async function loadSingerDetail(reqId: number): Promise<void> {
  const d = search.detail;
  if (!d || d.kind !== 'singer') return;
  d.loading = true;
  d.error = '';
  try {
    if (search.singerTab === 'songs') {
      const songs = await call<unknown>('getSingerSongs', d.id, 50);
      if (reqId !== _reqSeq) return;
      d.songs = normalizeSongs(songs);
      if (!d.songs.length) d.error = '暂无歌曲';
    } else {
      const r = await call<SingerAlbumsResult>('getSingerAlbums', d.id, d.source, 1, 99);
      if (reqId !== _reqSeq) return;
      const albums = Array.isArray(r && r.albums) ? (r.albums as SearchAlbum[]) : [];
      d.albums = albums;
      if (!albums.length) d.error = '暂无专辑';
    }
    d.loading = false;
  } catch (e) {
    if (reqId !== _reqSeq) return;
    d.loading = false;
    d.error = errText(e, '加载失败');
  }
}

export function backToResults(): void {
  search.detail = null;
}

/** 当前详情列表里的歌曲（专辑详情 / 歌手歌曲页用） */
export const detailSongs: ComputedRef<Song[]> = computed(() => {
  const d = search.detail;
  if (!d) return [];
  return d.songs || [];
});