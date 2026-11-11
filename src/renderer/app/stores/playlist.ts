/**
 * stores/playlist.ts —— 用户歌单与收藏
 *
 * 收藏是 id='favorites' 的系统歌单（与主进程同一事实来源），
 * 红心状态一律从它派生，前端不维护第二份集合。
 */
import { reactive, computed } from 'vue';
import type { ComputedRef } from 'vue';
import { call, callSafe } from '../core/bridge';
import { normalizeSong, songKey } from '../core/song';
import type { Song, SongLike } from '../core/song';
import { toast, errText } from '../core/toast';
import { promptDialog, confirmDialog } from '../core/dialog';
import { downloadSongs } from './search';
import type { MutationResult, SavePlaylistResult, UserPlaylist } from './types';

export const FAVORITES_ID = 'favorites';

/** 歌单域状态 */
interface PlaylistsState {
  lists: UserPlaylist[];
  activeId: string;
  loading: boolean;
  error: string;
  keyword: string;
  sort: string;
  batchMode: boolean;
  selected: Set<string>;
  trashMode: boolean;
  trash: UserPlaylist[];
}

export const playlists = reactive<PlaylistsState>({
  lists: [],
  activeId: FAVORITES_ID,
  loading: false,
  error: '',
  keyword: '',
  sort: 'default',
  batchMode: false,
  selected: new Set<string>(),
  trashMode: false,
  trash: [],
});

export const activePlaylist: ComputedRef<UserPlaylist | null> = computed(
  () => playlists.lists.find((p) => p.id === playlists.activeId) || playlists.lists[0] || null,
);

export const favoriteKeys: ComputedRef<Set<string>> = computed(() => {
  const fav = playlists.lists.find((p) => p.id === FAVORITES_ID);
  const set = new Set<string>();
  for (const s of (fav && fav.songs) || []) set.add(songKey(s));
  return set;
});

export function isFavorite(song: unknown): boolean {
  return favoriteKeys.value.has(songKey(song));
}

export const activeSongs: ComputedRef<Song[]> = computed(() => {
  const pl = activePlaylist.value;
  let arr = (pl && Array.isArray(pl.songs) ? pl.songs : [])
    .map(normalizeSong)
    .filter((s): s is Song => s !== null);
  const kw = playlists.keyword.trim().toLowerCase();
  if (kw) {
    arr = arr.filter((s) => `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(kw));
  }
  if (playlists.sort === 'title') {
    arr = arr.slice().sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  } else if (playlists.sort === 'artist') {
    arr = arr.slice().sort((a, b) => a.artist.localeCompare(b.artist, 'zh-Hans-CN'));
  } else if (playlists.sort === 'duration') {
    arr = arr.slice().sort((a, b) => (b.duration || 0) - (a.duration || 0));
  }
  return arr;
});

export const selectedCount: ComputedRef<number> = computed(() => playlists.selected.size);

export async function loadPlaylists(): Promise<void> {
  playlists.loading = true;
  playlists.error = '';
  try {
    const list = await call<UserPlaylist[]>('getUserPlaylists');
    playlists.lists = Array.isArray(list) ? list : [];
    if (!playlists.lists.some((p) => p.id === playlists.activeId)) {
      playlists.activeId = playlists.lists[0]?.id || FAVORITES_ID;
    }
  } catch (e) {
    playlists.error = errText(e, '读取歌单失败');
  } finally {
    playlists.loading = false;
  }
}

export async function loadTrash(): Promise<void> {
  try {
    const list = await call<UserPlaylist[]>('getUserPlaylists', { trash: true });
    playlists.trash = Array.isArray(list) ? list : [];
  } catch (_e) {
    playlists.trash = [];
  }
}

export function selectPlaylist(id: string): void {
  playlists.activeId = id;
  playlists.selected.clear();
  playlists.batchMode = false;
  playlists.trashMode = false;
}

export async function createPlaylist(): Promise<void> {
  const name = await promptDialog({
    title: '新建歌单', inputLabel: '歌单名称', placeholder: '例如：深夜爵士', okText: '创建',
  });
  if (!name || !name.trim()) return;
  const r = await callSafe<SavePlaylistResult | null>('saveUserPlaylist', [{ name: name.trim() }], null);
  if (r && r.success) {
    toast.success('歌单已创建');
    await loadPlaylists();
    if (r.playlist) selectPlaylist(r.playlist.id);
  } else {
    toast.error((r && r.error) || '创建失败');
  }
}

export async function renamePlaylist(pl: UserPlaylist | null | undefined): Promise<void> {
  if (!pl || pl.system) return;
  const name = await promptDialog({
    title: '重命名歌单', inputLabel: '歌单名称', value: pl.name, okText: '保存',
  });
  if (!name || !name.trim() || name === pl.name) return;
  const r = await callSafe<SavePlaylistResult | null>('saveUserPlaylist', [{ ...pl, name: name.trim() }], null);
  if (r && r.success) {
    toast.success('已重命名');
    await loadPlaylists();
  } else {
    toast.error((r && r.error) || '重命名失败');
  }
}

export async function removePlaylist(pl: UserPlaylist | null | undefined): Promise<void> {
  if (!pl || pl.system) return;
  const ok = await confirmDialog({
    title: '删除歌单', body: `「${pl.name}」会移入回收站，30 天内可恢复。`, danger: true, okText: '删除',
  });
  if (!ok) return;
  const r = await callSafe<MutationResult | null>('deleteUserPlaylist', [pl.id], null);
  if (r && r.success) {
    toast.success('已移入回收站');
    await loadPlaylists();
  } else {
    toast.error((r && r.error) || '删除失败');
  }
}

export async function restorePlaylist(item: UserPlaylist): Promise<void> {
  const r = await callSafe<SavePlaylistResult | null>('saveUserPlaylist', [item], null);
  if (r && r.success) {
    toast.success('歌单已恢复');
    await Promise.all([loadPlaylists(), loadTrash()]);
  } else {
    toast.error((r && r.error) || '恢复失败');
  }
}

export async function purgePlaylist(item: UserPlaylist): Promise<void> {
  const ok = await confirmDialog({
    title: '彻底删除', body: `「${item.name}」将从回收站永久删除，无法恢复。`, danger: true, okText: '彻底删除',
  });
  if (!ok) return;
  const r = await callSafe<MutationResult | null>('deleteUserPlaylist', [item.id], null);
  if (r && r.success) {
    toast.success('已彻底删除');
    await loadTrash();
  } else {
    toast.error((r && r.error) || '删除失败');
  }
}

export async function addSongTo(playlistId: string, song: unknown): Promise<boolean> {
  const s = normalizeSong(song);
  if (!s) return false;
  const r = await callSafe<SavePlaylistResult | null>('addToUserPlaylist', [playlistId, s], null);
  if (r && r.success) {
    if (r.skipped) toast.info('已在歌单中');
    else toast.success('已加入歌单');
    await loadPlaylists();
    return true;
  }
  toast.error((r && r.error) || '加入失败');
  return false;
}

export async function addSongToPlaylist(song: unknown): Promise<boolean> {
  const targets = playlists.lists.filter((p) => !p.system);
  if (!targets.length) {
    toast.warn('还没有自建歌单，先新建一个');
    return false;
  }
  if (targets.length === 1) return addSongTo(targets[0].id, song);
  // 多个歌单：用选择式提示（prompt 输入名称最直接，避免再造一个弹层）
  const name = await promptDialog({
    title: '加入歌单', inputLabel: `选择歌单（${targets.map((p) => p.name).join(' / ')}）`,
    placeholder: targets[0].name, okText: '加入',
  });
  if (!name) return false;
  const target = targets.find((p) => p.name === name.trim()) || targets[0];
  return addSongTo(target.id, song);
}

export async function removeSongFrom(playlistId: string, song: unknown): Promise<void> {
  const s = normalizeSong(song);
  if (!s) return;
  const r = await callSafe<MutationResult | null>('removeFromUserPlaylist', [playlistId, s.id, s.source], null);
  if (r && r.success) {
    await loadPlaylists();
  } else {
    toast.error((r && r.error) || '移除失败');
  }
}

export async function removeSelected(): Promise<void> {
  const pl = activePlaylist.value;
  if (!pl) return;
  const songs = activeSongs.value.filter((s) => playlists.selected.has(songKey(s)));
  if (!songs.length) return;
  for (const s of songs) {
    await callSafe('removeFromUserPlaylist', [pl.id, s.id, s.source], null);
  }
  playlists.selected.clear();
  playlists.batchMode = false;
  await loadPlaylists();
  toast.success(`已从歌单移除 ${songs.length} 首`);
}

export async function toggleFavorite(song: unknown): Promise<void> {
  const s = normalizeSong(song);
  if (!s) return;
  const r = await callSafe<MutationResult | null>('toggleFavorite', [s.source, s.id, s], null);
  if (r && r.success) {
    await loadPlaylists();
    toast.success(r.favorited ? '已收藏' : '已取消收藏');
  } else {
    toast.error((r && r.error) || '操作失败');
  }
}

export function toggleSelect(song: unknown): void {
  const k = songKey(song);
  if (playlists.selected.has(k)) playlists.selected.delete(k);
  else playlists.selected.add(k);
}

export function isSelected(song: unknown): boolean {
  return playlists.selected.has(songKey(song));
}

export function toggleSelectAll(): void {
  const list = activeSongs.value;
  if (playlists.selected.size >= list.length) {
    playlists.selected.clear();
    return;
  }
  for (const s of list) playlists.selected.add(songKey(s));
}

export async function downloadActive(): Promise<void> {
  const list = activeSongs.value;
  if (!list.length) { toast.warn('歌单为空'); return; }
  await downloadSongs(list);
}

/** 去重：同 source+id 只保留第一条，其余逐条移除 */
export async function dedupeActive(): Promise<void> {
  const pl = activePlaylist.value;
  if (!pl) return;
  const seen = new Set<string>();
  const dups: SongLike[] = [];
  for (const s of (pl.songs || [])) {
    const k = songKey(normalizeSong(s));
    if (!k) continue;
    if (seen.has(k)) dups.push(s);
    else seen.add(k);
  }
  if (!dups.length) { toast.info('没有发现重复歌曲'); return; }
  const ok = await confirmDialog({
    title: '去除重复歌曲', body: `发现 ${dups.length} 首重复，是否保留每首歌的第一条？`, okText: '去除',
  });
  if (!ok) return;
  for (const s of dups) {
    await callSafe('removeFromUserPlaylist', [pl.id, s.id, s.source], null);
  }
  await loadPlaylists();
  toast.success(`已去除 ${dups.length} 首重复`);
}

/** 导出当前歌单为 M3U 文本并复制到剪贴板 */
export async function exportActiveM3U(): Promise<void> {
  const pl = activePlaylist.value;
  if (!pl) return;
  const lines = ['#EXTM3U'];
  for (const s of activeSongs.value) {
    lines.push(`#EXTINF:${Math.round((Number(s.duration) || 0) / 1000)},${s.artist || ''} - ${s.title}`);
    lines.push(s.filePath || `# source:${s.source} id:${s.id}`);
  }
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`已复制 ${activeSongs.value.length} 首的 M3U 清单`);
  } catch (_e) {
    toast.error('复制失败');
  }
}