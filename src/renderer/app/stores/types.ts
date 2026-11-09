/**
 * stores/types.ts —— 渲染层领域类型集中定义
 *
 * 纯类型模块：只允许 `import type`，不得引入任何运行时依赖，
 * 否则 store 会因「类型文件被当成运行时模块」而产生额外打包负担。
 *
 * 这里只放**跨 store / 视图共享**的领域结构；单个 store 私有的
 * 状态形状直接写在对应 .ts 文件里（避免把所有东西堆成一坨）。
 */
import type { Song, SongLike } from '../core/song';

/** 平台清单项（get-platforms 返回；id/name 是展示与筛选的唯一键） */
export interface PlatformInfo {
  id: string;
  name: string;
  nameEn?: string;
  [key: string]: unknown;
}

/** 源健康度：主进程按探针源派生，形状由健康度模块决定，前端只透传 */
export type SourceHealthMap = Readonly<Record<string, unknown>>;

/* ── 发现页 ───────────────────────────────────────────────── */

export type DiscoverSectionKind = 'list' | 'grid';

/** 分区展示配置（界面结构，不是业务数据） */
export interface DiscoverSectionMeta {
  sec: string;
  title: string;
  kind: DiscoverSectionKind;
  showSource?: boolean;
}

/** 平台 → 分区注册表 */
export interface DiscoverPlatformGroup {
  plat: string;
  sections: DiscoverSectionMeta[];
}

/** 歌单卡片（发现页 grid 区 / 平台歌单摘要） */
export interface PlaylistSummary {
  id: string;
  source: string;
  name: string;
  cover?: string;
  playCount?: number;
  [key: string]: unknown;
}

/** 分区数据：list 区是歌曲，grid 区是歌单摘要 */
export type DiscoverSectionItem = Song | PlaylistSummary;

/** 单个分区的懒加载状态 */
export interface DiscoverSectionState {
  data: DiscoverSectionItem[];
  loading: boolean;
  error: string;
  loaded: boolean;
}

/** get-home-section 回包（主进程失败时也返回同形结构） */
export interface HomeSectionResult {
  ok?: boolean;
  section?: string;
  data?: unknown;
  error?: string;
  [key: string]: unknown;
}

/* ── 用户歌单 ─────────────────────────────────────────────── */

/** 用户歌单（主进程 userPlaylists 的一条；favorites 是 id 固定的系统歌单） */
export interface UserPlaylist {
  id: string;
  name: string;
  songs?: SongLike[];
  cover?: string;
  desc?: string;
  system?: boolean;
  createdAt?: number;
  updatedAt?: number;
  /** 回收站视图附加字段（剩余保留天数） */
  daysLeft?: number | null;
  [key: string]: unknown;
}

/** save-user-playlist 回包 */
export interface SavePlaylistResult {
  success?: boolean;
  error?: string;
  playlist?: UserPlaylist;
  [key: string]: unknown;
}

/* ── 下载队列 / 历史 ─────────────────────────────────────── */

export type DownloadStatus = 'pending' | 'downloading' | 'done' | 'error';

/** 队列任务（主进程队列活引用的快照条目） */
export interface DownloadTask {
  taskId: string;
  id?: string;
  source?: string;
  title?: string;
  artist?: string;
  album?: string;
  cover?: string;
  fileName?: string;
  filePath?: string;
  savePath?: string | null;
  status: DownloadStatus;
  progress?: number;
  error?: string | null;
  errorCode?: string | null;
  duration?: number;
  quality?: string;
  [key: string]: unknown;
}

/** 单任务增量进度（on-download-progress） */
export interface DownloadProgress {
  progress: number;
  speedBps: number;
  etaSec: number | null;
  receivedBytes: number;
  totalBytes: number;
}

/** on-download-progress 事件载荷 */
export interface DownloadProgressEvent {
  id?: string | number;
  progress?: number;
  speedBps?: number;
  etaSec?: number;
  receivedBytes?: number;
  totalBytes?: number;
  [key: string]: unknown;
}

/** on-download-error 事件载荷 */
export interface DownloadErrorEvent {
  taskId?: string;
  id?: string;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

/** 队列统计（computed 输出） */
export interface QueueStats {
  total: number;
  pending: number;
  downloading: number;
  done: number;
  error: number;
}

/** 下载历史条目（history.db 的 data 列原样 JSON） */
export interface DownloadHistoryItem {
  id: string;
  source: string;
  title?: string;
  artist?: string;
  album?: string;
  savePath?: string;
  ext?: string;
  quality?: string;
  size?: number;
  duration?: number;
  status?: string;
  finishedAt?: number;
  matchedFrom?: string;
  cover?: string;
  missing?: boolean;
  [key: string]: unknown;
}

/** 历史筛选状态 */
export interface DownloadHistoryState {
  items: DownloadHistoryItem[];
  total: number;
  page: number;
  limit: number;
  keyword: string;
  status: string;
  sort: string;
  loading: boolean;
  error: string;
  /** loadHistory 后由主进程附带的失联清单；未查询时缺省 */
  deadEntries?: DownloadHistoryItem[];
}

/** query-history 回包 */
export interface HistoryQueryResult {
  items?: unknown;
  total?: unknown;
  deadEntries?: unknown;
  [key: string]: unknown;
}

/** history-stats 回包 */
export interface HistoryStats {
  total: number;
  done: number;
  error: number;
  totalSize: number;
  bySource: Record<string, Record<string, number>>;
}

/** 队列类写操作的最小回包 */
export interface QueueMutationResult {
  ok?: boolean;
  error?: string;
  canceled?: boolean;
  removed?: number;
  paused?: boolean;
  [key: string]: unknown;
}

/** add-to-queue 回包（重试/去重分支字段） */
export interface AddQueueResult extends QueueMutationResult {
  queued?: boolean;
  duplicated?: boolean;
  alreadyDownloaded?: boolean;
  taskId?: string;
}

/* ── 搜索 ─────────────────────────────────────────────────── */

export type SearchType = 'song' | 'album' | 'singer';
export type SearchSortKey = 'default' | 'duration' | 'source';

/** 专辑摘要（search-album / get-singer-albums 返回） */
export interface SearchAlbum {
  mid: string;
  source: string;
  title?: string;
  artist?: string;
  cover?: string;
  songCount?: number;
  publishTime?: string;
  [key: string]: unknown;
}

/** 歌手摘要（search-singer 返回） */
export interface SearchSinger {
  mid: string;
  source: string;
  name?: string;
  avatar?: string;
  songCount?: number;
  albumCount?: number;
  mvCount?: number;
  [key: string]: unknown;
}

/** 专辑 / 歌手详情（null 时展示搜索结果） */
export interface SearchDetail {
  kind: 'album' | 'singer';
  id: string;
  name: string;
  source?: string;
  loading: boolean;
  songs: Song[];
  albums?: SearchAlbum[];
  error: string;
}

/** search-music 回包 */
export interface SearchSongResult {
  songs?: unknown;
  total?: unknown;
  error?: string;
  [key: string]: unknown;
}

/** search-album 回包 */
export interface SearchAlbumResult {
  albums?: unknown;
  total?: unknown;
  error?: string;
  [key: string]: unknown;
}

/** search-singer 回包 */
export interface SearchSingerResult {
  singers?: unknown;
  total?: unknown;
  error?: string;
  [key: string]: unknown;
}

/** 歌手专辑分页回包 */
export interface SingerAlbumsResult {
  albums?: unknown;
  error?: string;
  [key: string]: unknown;
}

/** 批量入队结果（downloadSongs 返回） */
export interface DownloadOutcome {
  queued: number;
  skipped: number;
  failed?: number;
}

/* ── 本地曲库 ─────────────────────────────────────────────── */

/** 本地歌曲（主进程索引条目：filePath/durationMs/ext/bitrate/fileSize/mtime） */
export interface LocalSong {
  filePath?: string;
  id?: string;
  source?: string;
  title?: string;
  artist?: string;
  album?: string;
  cover?: string;
  ext?: string;
  bitrate?: number;
  fileSize?: number;
  mtime?: number;
  durationMs?: number;
  duration?: number;
  [key: string]: unknown;
}

/** load-library-index 回包 */
export interface LibraryIndexResult {
  songs?: unknown;
  dirPath?: string;
  lastScan?: number;
  [key: string]: unknown;
}

/** scan-local-library 回包 */
export interface ScanLibraryResult {
  songs?: unknown;
  error?: string;
  count?: number;
  incremental?: boolean;
  relinked?: { fixed?: number; ambiguous?: number };
  [key: string]: unknown;
}

/** delete-file 回包 */
export interface DeleteFileResult {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

/* ── 歌词 ─────────────────────────────────────────────────── */

/** 解析后的歌词行（t 为秒） */
export interface LyricLine {
  t: number;
  text: string;
}

/** 桌面歌词窗口使用的瘦身行 */
export interface DesktopLyricLine extends LyricLine {
  subText: string;
  words: string[];
  wordTimes: number[];
}

/** read-local-lrc 回包 */
export interface LocalLrcResult {
  lrc?: string;
  content?: string;
  [key: string]: unknown;
}

/** get-lyrics 回包 */
export interface OnlineLrcResult {
  lrc?: string;
  error?: string;
  [key: string]: unknown;
}

/* ── 播放器 ───────────────────────────────────────────────── */

export type PlayMode = 'order' | 'list-loop' | 'single' | 'shuffle';

/** get-download-url-smart 回包 */
export interface PlayUrlInfo {
  url?: string;
  source?: string;
  id?: string | number;
  degradedLocal?: boolean;
  error?: string;
  code?: string | number;
  [key: string]: unknown;
}

/** proxy-play 回包 */
export interface ProxyPlayResult {
  fileUrl?: string;
  error?: string;
  [key: string]: unknown;
}

/** load-play-queue 回包 */
export interface PlayQueueSnapshot {
  queue?: unknown;
  playIdx?: unknown;
  [key: string]: unknown;
}

/* ── 设置 ─────────────────────────────────────────────────── */

/** 下载命名模板 */
export interface DownloadTemplate {
  id: string;
  name: string;
  path: string;
  subpath?: string;
  [key: string]: unknown;
}

/** get-download-templates 回包 */
export interface TemplatesResult {
  templates?: unknown;
  active?: string | null;
  [key: string]: unknown;
}

/** save-cookie 回包 */
export interface SaveCookieResult {
  saved?: boolean;
  error?: string;
  verify?: { valid?: boolean; [key: string]: unknown };
  cookieRefreshed?: boolean;
  [key: string]: unknown;
}

/** verify-cookie 回包 */
export interface VerifyCookieResult {
  valid?: boolean;
  error?: string;
  [key: string]: unknown;
}

/** open-login-window 回包 */
export interface LoginWindowResult {
  saved?: boolean;
  success?: boolean;
  canceled?: boolean;
  error?: string;
  [key: string]: unknown;
}

/** 通用写操作回包（导出/导入/更新/模板增删/歌单增删） */
export interface MutationResult {
  success?: boolean;
  error?: string;
  path?: string;
  canceled?: boolean;
  /** 歌单加歌时命中重复 */
  skipped?: boolean;
  /** toggle-favorite 结果 */
  favorited?: boolean;
  [key: string]: unknown;
}

/* ── UI 外壳 ──────────────────────────────────────────────── */

export type ThemeMode = 'light' | 'dark';

/** 导航项：id 与 App.vue 的视图映射一一对应 */
export interface NavItem {
  id: string;
  label: string;
  icon: string;
}

/** 命令面板条目 */
export interface CommandItem {
  id: string;
  title: string;
  sub: string;
  keys: string;
  run: () => void;
}