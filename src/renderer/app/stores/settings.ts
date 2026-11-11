/**
 * stores/settings.ts —— 设置页状态（偏好 / 账号 / 模板 / 更新 / 数据）
 */
import { reactive, computed } from 'vue';
import type { ComputedRef } from 'vue';
import { call, callSafe } from '../core/bridge';
import { getPref, setPref } from '../core/prefs';
import { toast, errText } from '../core/toast';
import { confirmDialog } from '../core/dialog';
import { ui, applyTheme, setLanguage as setUiLanguage } from './ui';
import { setQuality, setVolume } from './player';
import { lyrics, setOffset } from './lyrics';
import type {
  DownloadTemplate,
  LoginWindowResult,
  MutationResult,
  PlatformInfo,
  SaveCookieResult,
  TemplatesResult,
  VerifyCookieResult,
} from './types';

/** 设置页状态 */
interface SettingsState {
  tab: string;
  loading: boolean;
  version: string;
  platforms: PlatformInfo[];
  cookies: Record<string, string>;
  cookieDraft: Record<string, string>;
  cookieOpen: Record<string, boolean>;
  templates: DownloadTemplate[];
  activeTemplate: string | null;
  defaultDir: string;
  saveDir: string;
  playQuality: string;
  checking: boolean;
  updateMsg: string;
  busy: string;
  /** 仅在 chooseTheme 后写入（旧层无初始键，保持可选） */
  theme?: string;
}

export const settings = reactive<SettingsState>({
  tab: 'appearance',
  loading: true,
  version: '',
  platforms: [],
  cookies: {},
  cookieDraft: {},
  cookieOpen: {},
  templates: [],
  activeTemplate: null,
  defaultDir: '',
  saveDir: '',
  playQuality: 'standard',
  checking: false,
  updateMsg: '',
  busy: '',
});

export const TABS: readonly { id: string; label: string; icon: string }[] = Object.freeze([
  { id: 'appearance', label: '外观', icon: 'palette' },
  { id: 'playback', label: '播放', icon: 'equalizer' },
  { id: 'download', label: '下载', icon: 'download' },
  { id: 'accounts', label: '账号', icon: 'cloud' },
  { id: 'advanced', label: '高级', icon: 'shield' },
  { id: 'about', label: '关于', icon: 'info' },
]);

export const activePlatforms: ComputedRef<PlatformInfo[]> = computed(() => settings.platforms);

export async function loadSettings(): Promise<void> {
  settings.loading = true;
  try {
    const [version, platforms, cookies, tpl, defDir, quality, saveDir, off] = await Promise.all([
      callSafe<string, string>('getVersion', [], ''),
      callSafe<PlatformInfo[], PlatformInfo[]>('getPlatforms', [], []),
      callSafe<Record<string, string>, Record<string, string>>('getCookies', [], {}),
      callSafe<TemplatesResult, TemplatesResult>('getDownloadTemplates', [], { templates: [], active: null }),
      callSafe<string, string>('getDefaultDir', [], ''),
      getPref('playQuality', 'standard'),
      getPref('saveDir', ''),
      getPref('lyricOffsetMs', 0),
    ]);
    settings.version = version || '';
    settings.platforms = Array.isArray(platforms) ? platforms : [];
    settings.cookies = cookies && typeof cookies === 'object' ? cookies : {};
    settings.templates = Array.isArray(tpl && tpl.templates) ? (tpl.templates as DownloadTemplate[]) : [];
    settings.activeTemplate = (tpl && tpl.active) || null;
    settings.defaultDir = defDir || '';
    settings.saveDir = saveDir || '';
    settings.playQuality = quality || 'standard';
    lyrics.offsetMs = Number(off) || 0;
  } catch (_e) { /* 各字段独立兜底 */ } finally {
    settings.loading = false;
  }
}

export function setTab(id: string): void {
  settings.tab = id;
}

/* ── 外观 ─────────────────────────────────────────────────── */

export async function chooseTheme(mode: string): Promise<void> {
  applyTheme(mode);
  settings.theme = ui.theme;
  toast.success(mode === 'dark' ? '已切换到深色' : '已切换到浅色');
}

export async function chooseLanguage(code: string): Promise<void> {
  await setUiLanguage(code);
  toast.success(code === 'en' ? 'Language: English' : '语言：简体中文');
}

/* ── 播放 ─────────────────────────────────────────────────── */

export async function chooseQuality(q: string): Promise<void> {
  setQuality(q);
  settings.playQuality = q;
  await setPref('playQuality', q);
}

export async function changeVolume(v: number | string): Promise<void> {
  setVolume(Number(v) / 100);
  await setPref('volume', Number(v) / 100);
}

export async function changeRate(v: number | string): Promise<void> {
  const { setRate } = await import('./player');
  setRate(v);
  await setPref('playRate', Number(v) || 1);
}

export async function changeLyricOffset(ms: number): Promise<void> {
  await setOffset(lyrics.offsetMs + ms);
}

/* ── 下载 ─────────────────────────────────────────────────── */

export async function chooseSaveDir(): Promise<void> {
  const dir = await callSafe<string | null>('selectDir', [], null);
  if (!dir) return;
  settings.saveDir = dir;
  await setPref('saveDir', dir);
  toast.success('下载目录已更新');
}

/* ── 账号 ─────────────────────────────────────────────────── */

export function toggleCookieEditor(platform: string): void {
  settings.cookieOpen[platform] = !settings.cookieOpen[platform];
}

export async function saveCookie(platform: string): Promise<void> {
  const cookie = String(settings.cookieDraft[platform] || '').trim();
  if (!cookie) { toast.warn('请先粘贴 Cookie'); return; }
  settings.busy = platform;
  try {
    const r = await call<SaveCookieResult>('saveCookie', platform, cookie);
    if (r && r.saved) {
      settings.cookies = await callSafe<Record<string, string>, Record<string, string>>('getCookies', [], {});
      settings.cookieDraft[platform] = '';
      settings.cookieOpen[platform] = false;
      toast.success(r.verify && r.verify.valid ? '已保存并验证通过' : '已保存');
    } else {
      toast.error((r && r.error) || '保存失败');
    }
  } catch (e) {
    toast.error(errText(e, '保存失败'));
  } finally {
    settings.busy = '';
  }
}

export async function verifyCookie(platform: string): Promise<void> {
  const cookie = String(settings.cookieDraft[platform] || '').trim();
  if (!cookie) { toast.warn('请先粘贴 Cookie'); return; }
  settings.busy = platform;
  try {
    const r = await callSafe<VerifyCookieResult | null>('verifyCookie', [platform, cookie], null);
    if (r && r.valid) toast.success('Cookie 有效');
    else toast.error((r && (r.error || 'Cookie 无效')) || 'Cookie 无效');
  } finally {
    settings.busy = '';
  }
}

export async function clearCookie(platform: string): Promise<void> {
  const ok = await confirmDialog({ title: '清除 Cookie', body: '清除后该平台需要重新登录。', danger: true, okText: '清除' });
  if (!ok) return;
  await callSafe('clearCookie', [platform], null);
  settings.cookies = await callSafe<Record<string, string>, Record<string, string>>('getCookies', [], {});
  toast.success('已清除');
}

export async function openLogin(platform: string): Promise<void> {
  settings.busy = platform;
  try {
    const r = await callSafe<LoginWindowResult | null>('openLoginWindow', [platform], null);
    if (r && (r.saved || r.success)) {
      settings.cookies = await callSafe<Record<string, string>, Record<string, string>>('getCookies', [], {});
      toast.success('登录成功，Cookie 已保存');
    } else if (r && r.canceled) {
      toast.info('已取消登录');
    } else {
      toast.warn((r && r.error) || '未获取到登录态');
    }
  } finally {
    settings.busy = '';
  }
}

/* ── 模板 ─────────────────────────────────────────────────── */

export async function saveTemplate({ name, path }: { name: string; path: string }): Promise<void> {
  const r = await callSafe<MutationResult | null>('saveDownloadTemplate', [{ name, path }], null);
  if (r && r.success) {
    await reloadTemplates();
    toast.success('模板已保存');
  } else {
    toast.error((r && r.error) || '保存失败');
  }
}

export async function deleteTemplate(id: string): Promise<void> {
  const ok = await confirmDialog({ title: '删除模板', body: '确定删除这个命名模板？', danger: true, okText: '删除' });
  if (!ok) return;
  const r = await callSafe<MutationResult | null>('deleteDownloadTemplate', [id], null);
  if (r && r.success !== false) {
    await reloadTemplates();
    toast.success('模板已删除');
  }
}

export async function activateTemplate(id: string): Promise<void> {
  const r = await callSafe<MutationResult | null>('setActiveDownloadTemplate', [id], null);
  if (r && r.success !== false) {
    settings.activeTemplate = id;
    toast.success('已设为默认模板');
  }
}

async function reloadTemplates(): Promise<void> {
  const tpl = await callSafe<TemplatesResult, TemplatesResult>('getDownloadTemplates', [], { templates: [], active: null });
  settings.templates = Array.isArray(tpl && tpl.templates) ? (tpl.templates as DownloadTemplate[]) : [];
  settings.activeTemplate = (tpl && tpl.active) || null;
}

/* ── 高级 ─────────────────────────────────────────────────── */

export async function exportData(): Promise<void> {
  settings.busy = 'export';
  try {
    const r = await callSafe<MutationResult | null>('exportAllData', [], null);
    if (r && r.success) toast.success(`已导出到：${r.path || '所选位置'}`);
    else toast.error((r && r.error) || '导出失败');
  } finally {
    settings.busy = '';
  }
}

export async function importData(): Promise<void> {
  const ok = await confirmDialog({ title: '导入数据', body: '导入会合并现有歌单/历史/偏好，是否继续？', okText: '选择文件并导入' });
  if (!ok) return;
  settings.busy = 'import';
  try {
    const r = await callSafe<MutationResult | null>('importAllData', [], null);
    if (r && r.success) { toast.success('导入完成'); await loadSettings(); }
    else if (r && r.canceled) { /* 用户取消 */ }
    else toast.error((r && r.error) || '导入失败');
  } finally {
    settings.busy = '';
  }
}

export async function checkUpdate(): Promise<void> {
  if (settings.checking) return;
  settings.checking = true;
  settings.updateMsg = '';
  try {
    const r = await callSafe<MutationResult | null>('checkForUpdate', [], null);
    if (r && r.success) {
      settings.updateMsg = '检查完成：有新版本时会提示下载';
      toast.success('检查完成');
    } else {
      settings.updateMsg = (r && r.error) || '检查失败';
      toast.error(settings.updateMsg);
    }
  } finally {
    settings.checking = false;
  }
}

export async function downloadUpdate(): Promise<void> {
  settings.busy = 'update';
  try {
    const r = await callSafe<MutationResult | null>('downloadUpdate', [], null);
    if (r && r.success) toast.success('更新已下载，可重启安装');
    else toast.error((r && r.error) || '下载失败');
  } finally {
    settings.busy = '';
  }
}

export async function restartInstall(): Promise<void> {
  const ok = await confirmDialog({ title: '重启并安装', body: '应用将立即退出并安装更新。', okText: '重启安装' });
  if (!ok) return;
  await callSafe('restartAndInstall', [], null);
}