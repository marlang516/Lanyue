/**
 * stores/library.ts —— 本地曲库
 *
 * 数据源：load-library-index（秒开缓存）→ scan-local-library（增量扫描）。
 * 本地歌曲字段与主进程一致：filePath / durationMs / ext / bitrate / fileSize / mtime。
 */
import { reactive, computed } from 'vue';
import type { ComputedRef } from 'vue';
import { call, callSafe } from '../core/bridge';
import { getPref, setPref } from '../core/prefs';
import { toast, errText } from '../core/toast';
import { confirmDialog } from '../core/dialog';
import { appendToQueue } from './player';
import type {
  DeleteFileResult,
  LibraryIndexResult,
  LocalSong,
  ScanLibraryResult,
} from './types';

/** 曲库状态 */
interface LibraryState {
  dirPath: string;
  songs: LocalSong[];
  lastScan: number;
  loading: boolean;
  scanning: boolean;
  error: string;
  keyword: string;
  format: string;
  quality: string;
  sort: string;
  batchMode: boolean;
  selected: Set<string>;
}

export const library = reactive<LibraryState>({
  dirPath: '',
  songs: [],
  lastScan: 0,
  loading: false,
  scanning: false,
  error: '',
  keyword: '',
  format: 'all',
  quality: 'all',
  sort: 'mtime-desc',
  batchMode: false,
  selected: new Set<string>(),
});

export const selectedCount: ComputedRef<number> = computed(() => library.selected.size);

export const formats: ComputedRef<string[]> = computed(() => {
  const set = new Set<string>();
  for (const s of library.songs) {
    const ext = String(s.ext || '').replace('.', '').toLowerCase();
    if (ext) set.add(ext);
  }
  return [...set].sort();
});

export const libraryStats: ComputedRef<{ count: number; size: number; formats: number }> = computed(() => {
  let size = 0;
  for (const s of library.songs) size += Number(s.fileSize) || 0;
  return { count: library.songs.length, size, formats: formats.value.length };
});

export const filteredSongs: ComputedRef<LocalSong[]> = computed(() => {
  let arr = library.songs;
  const kw = library.keyword.trim().toLowerCase();
  if (kw) {
    arr = arr.filter((s) => `${s.title || ''} ${s.artist || ''} ${s.album || ''}`.toLowerCase().includes(kw));
  }
  if (library.format !== 'all') {
    arr = arr.filter((s) => String(s.ext || '').replace('.', '').toLowerCase() === library.format);
  }
  if (library.quality !== 'all') {
    arr = arr.filter((s) => {
      const lossless = String(s.ext || '').toLowerCase() === '.flac' || Number(s.bitrate) >= 900;
      return library.quality === 'lossless' ? lossless : Number(s.bitrate) >= 320;
    });
  }
  return sortLocal(arr, library.sort);
});

function sortLocal(arr: LocalSong[], mode: string): LocalSong[] {
  const out = arr.slice();
  const text = (v: unknown): string => String(v || '');
  switch (mode) {
    case 'title':
      return out.sort((a, b) => text(a.title).localeCompare(text(b.title), 'zh-Hans-CN'));
    case 'artist':
      return out.sort((a, b) => text(a.artist).localeCompare(text(b.artist), 'zh-Hans-CN'));
    case 'album':
      return out.sort((a, b) => text(a.album).localeCompare(text(b.album), 'zh-Hans-CN'));
    case 'duration':
      return out.sort((a, b) => (Number(b.durationMs) || 0) - (Number(a.durationMs) || 0));
    case 'bitrate':
      return out.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    case 'mtime-asc':
      return out.sort((a, b) => (Number(a.mtime) || 0) - (Number(b.mtime) || 0));
    case 'mtime-desc':
    default:
      return out.sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0));
  }
}

export const SORT_OPTIONS: readonly { id: string; label: string }[] = Object.freeze([
  { id: 'mtime-desc', label: '最近添加' },
  { id: 'mtime-asc', label: '最久添加' },
  { id: 'title', label: '歌名' },
  { id: 'artist', label: '歌手' },
  { id: 'album', label: '专辑' },
  { id: 'duration', label: '时长' },
  { id: 'bitrate', label: '码率' },
]);

export async function initLibrary(): Promise<void> {
  library.loading = true;
  library.error = '';
  try {
    const [index, dir] = await Promise.all([
      callSafe<LibraryIndexResult, LibraryIndexResult>('loadLibraryIndex', [], { songs: [] }),
      getPref('localDirPath', ''),
    ]);
    library.songs = Array.isArray(index && index.songs) ? (index.songs as LocalSong[]) : [];
    library.dirPath = (index && index.dirPath) || dir || '';
    library.lastScan = Number(index && index.lastScan) || 0;
  } catch (e) {
    library.error = errText(e, '读取曲库索引失败');
  } finally {
    library.loading = false;
  }
  // 有目录则静默增量扫描一次（索引已先显示，用户不用等）
  if (library.dirPath) void scanLibrary(library.dirPath, true);
}

export async function scanLibrary(dir: string = library.dirPath, silent = false): Promise<void> {
  if (!dir || library.scanning) return;
  library.scanning = true;
  if (!silent) library.error = '';
  try {
    const r = await call<ScanLibraryResult>('scanLocalLibrary', dir);
    if (r && r.error) {
      library.error = r.error;
    } else {
      library.songs = Array.isArray(r && r.songs) ? (r.songs as LocalSong[]) : [];
      library.lastScan = Date.now();
      library.dirPath = dir;
      const relinked = r && r.relinked;
      if (!silent) {
        let msg = `扫描完成：${library.songs.length} 首`;
        if (relinked && relinked.fixed) msg += `，修复 ${relinked.fixed} 条失联引用`;
        toast.success(msg);
      }
    }
  } catch (e) {
    library.error = errText(e, '扫描失败');
  } finally {
    library.scanning = false;
  }
}

export async function chooseDirectory(): Promise<void> {
  const dir = await callSafe<string | null>('selectDir', [], null);
  if (!dir) return;
  library.dirPath = dir;
  await setPref('localDirPath', dir);
  await scanLibrary(dir);
}

export function toggleSelect(song: LocalSong): void {
  const key = song.filePath;
  if (!key) return;
  if (library.selected.has(key)) library.selected.delete(key);
  else library.selected.add(key);
}

export function isSelected(song: LocalSong | null | undefined): boolean {
  return !!song && library.selected.has(song.filePath as string);
}

export function toggleSelectAll(): void {
  const list = filteredSongs.value;
  if (library.selected.size >= list.length) {
    library.selected.clear();
    return;
  }
  for (const s of list) if (s.filePath) library.selected.add(s.filePath);
}

export function selectedSongs(): LocalSong[] {
  return filteredSongs.value.filter((s) => library.selected.has(s.filePath as string));
}

export function addSelectedToQueue(): void {
  const list = selectedSongs();
  if (!list.length) { toast.warn('先勾选歌曲'); return; }
  const n = appendToQueue(list);
  toast.success(`已加入播放队列 ${n} 首`);
}

export async function deleteSong(song: LocalSong): Promise<void> {
  const ok = await confirmDialog({
    title: '移到回收站',
    body: `确定把「${song.title}」移到回收站吗？`,
    danger: true,
    okText: '移到回收站',
  });
  if (!ok) return;
  const fail: DeleteFileResult = { success: false };
  const r = await callSafe<DeleteFileResult, DeleteFileResult>('deleteFile', [song.filePath], fail);
  if (r && r.success) {
    library.songs = library.songs.filter((s) => s.filePath !== song.filePath);
    library.selected.delete(song.filePath as string);
    toast.success('已移到回收站');
  } else {
    toast.error((r && r.error) || '删除失败');
  }
}

export function openInFolder(song: LocalSong | null | undefined): void {
  if (song && song.filePath) void callSafe('openFolder', [song.filePath], null);
}