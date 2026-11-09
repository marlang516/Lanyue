/**
 * stores/ui.ts —— 外壳与全局 UI 状态
 *
 * 只放「跨视图共享且不属于某个业务域」的状态：
 *   视图、主题、语言、命令面板、启动态。
 * 业务数据一律进各自 store（search/library/download/player...）。
 */
import { reactive } from 'vue';
import { callSafe } from '../core/bridge';
import { getPref, setPref } from '../core/prefs';
import { restoreLanguage, loadLanguage, i18n } from '../core/i18n';
import type { CommandItem, NavItem, ThemeMode } from './types';

/** 导航契约：id 与视图注册表一一对应，顺序即图标轨顺序 */
export const NAV_ITEMS: readonly NavItem[] = Object.freeze([
  { id: 'home', label: '发现', icon: 'home' },
  { id: 'search', label: '搜索', icon: 'search' },
  { id: 'library', label: '曲库', icon: 'library' },
  { id: 'recent', label: '最近', icon: 'clock' },
  { id: 'download', label: '下载', icon: 'download' },
  { id: 'playlist', label: '歌单', icon: 'playlist' },
]);

/** 外壳状态 */
interface UiState {
  booted: boolean;
  view: string;
  theme: ThemeMode;
  lang: string;
  paletteOpen: boolean;
  railPinned: boolean;
  appVersion: string;
  /** 由外壳投递：SearchView 挂载/监听后消费并清空 */
  pendingSearch: string;
}

export const ui = reactive<UiState>({
  booted: false,
  view: 'home',
  theme: 'light',
  lang: 'zh',
  paletteOpen: false,
  railPinned: true,
  appVersion: '',
  pendingSearch: '',   // 由外壳投递：SearchView 挂载/监听后消费并清空
});

const THEME_DARK_ALIASES = new Set<string>(['dark', 'cyber', 'aurora', 'sunset', 'forest', 'void']);

export function normalizeTheme(v: unknown): ThemeMode {
  return THEME_DARK_ALIASES.has(String(v || '')) ? 'dark' : 'light';
}

export function applyTheme(mode: unknown, persist = true): void {
  ui.theme = normalizeTheme(mode);
  document.documentElement.setAttribute('data-theme', ui.theme);
  if (persist) void setPref('theme', ui.theme);
}

export function toggleTheme(): void {
  applyTheme(ui.theme === 'dark' ? 'light' : 'dark');
}

export function setView(id: string | null | undefined): void {
  if (!id) return;
  ui.view = String(id);
  ui.paletteOpen = false;
}

/** 带关键词进入搜索页；SearchView 消费 pendingSearch */
export function openSearch(keyword = ''): void {
  ui.pendingSearch = String(keyword || '');
  setView('search');
}

export function togglePalette(force?: unknown): void {
  ui.paletteOpen = typeof force === 'boolean' ? force : !ui.paletteOpen;
}

/** 启动：版本、主题、语言；任何一项失败都不阻断界面 */
export async function bootUi(): Promise<void> {
  ui.appVersion = (await callSafe<string, string>('getVersion', [], '')) || '';
  applyTheme(normalizeTheme(await getPref('theme', 'light')), false);
  await restoreLanguage();
  ui.lang = i18n.lang;
  ui.booted = true;
}

export async function setLanguage(code: string): Promise<void> {
  loadLanguage(code);
  ui.lang = i18n.lang;
  await setPref('language', ui.lang);
}

/**
 * 命令面板数据源。
 * run 里只做「当前外壳就能完成」的动作；业务命令由各视图后续注册。
 */
export const COMMANDS: readonly CommandItem[] = Object.freeze([
  { id: 'go-home', title: '前往：发现', sub: 'Discover', keys: 'home discover 首页 发现', run: () => setView('home') },
  { id: 'go-search', title: '前往：搜索', sub: 'Search', keys: 'search 搜索', run: () => setView('search') },
  { id: 'go-library', title: '前往：曲库', sub: 'Library', keys: 'library 曲库 本地', run: () => setView('library') },
  { id: 'go-recent', title: '前往：最近播放', sub: 'Recent', keys: 'recent 最近 历史', run: () => setView('recent') },
  { id: 'go-download', title: '前往：下载管理', sub: 'Downloads', keys: 'download 下载 队列', run: () => setView('download') },
  { id: 'go-playlist', title: '前往：歌单', sub: 'Playlists', keys: 'playlist 歌单 收藏', run: () => setView('playlist') },
  { id: 'go-settings', title: '前往：设置', sub: 'Settings', keys: 'settings 设置 偏好', run: () => setView('settings') },
  { id: 'toggle-theme', title: '切换主题：浅色 / 深色', sub: 'Theme', keys: 'theme 主题 深色 浅色 dark light', run: () => toggleTheme() },
  { id: 'open-download-dir', title: '打开下载目录', sub: 'Folder', keys: 'folder 打开 目录 下载', run: () => callSafe('openFolder', [''], null) },
]);

export function matchCommands(keyword: unknown): CommandItem[] {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return COMMANDS.slice();
  return COMMANDS.filter((c) => {
    const hay = `${c.title} ${c.sub} ${c.keys}`.toLowerCase();
    return hay.includes(kw);
  });
}