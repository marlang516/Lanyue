/**
 * stores/discover.ts —— 发现页数据
 *
 * 分区注册表是「界面结构」，放在渲染层（与旧层一致）：平台/榜单名称是
 * 展示配置，不是业务数据源；平台显示名仍取 getPlatforms 的返回值。
 */
import { reactive, computed } from 'vue';
import type { ComputedRef } from 'vue';
import { call, callSafe } from '../core/bridge';
import {
  DISCOVER_FEED_CAPS,
  collectDiscoverBundles,
  expandDiscoverFeed,
  readDiscoverSources,
} from '../core/discoverFeed';
import { platformName } from '../core/format';
import { normalizeSongs } from '../core/song';
import type { Song } from '../core/song';
import type {
  DiscoverPlatformGroup,
  DiscoverSectionExpand,
  DiscoverSectionMeta,
  DiscoverSectionState,
  HomeSectionResult,
  PlatformInfo,
  SourceHealthMap,
} from './types';

export const DISCOVER_SECTIONS: readonly DiscoverPlatformGroup[] = Object.freeze([
  {
    plat: 'netease',
    sections: [
      { sec: 'netease.tops', title: '飙升榜', kind: 'list' as const },
      { sec: 'netease.hot', title: '热歌榜', kind: 'list' as const },
      { sec: 'netease.new', title: '新歌榜', kind: 'list' as const },
      { sec: 'netease.original', title: '原创榜', kind: 'list' as const },
      { sec: 'netease.playlists', title: '推荐歌单', kind: 'list' as const, expand: 'playlist' as const },
    ],
  },
  {
    plat: 'qq',
    sections: [
      { sec: 'qq.recommend', title: '个性化推荐', kind: 'list' as const, expand: 'playlist' as const },
      { sec: 'qq.official', title: '官方歌单', kind: 'list' as const, expand: 'playlist' as const },
      { sec: 'qq.classic', title: '经典歌单', kind: 'list' as const, expand: 'playlist' as const },
      { sec: 'qq.love', title: '情歌歌单', kind: 'list' as const, expand: 'playlist' as const },
      { sec: 'qq.ktv', title: 'KTV热歌', kind: 'list' as const, expand: 'playlist' as const },
      { sec: 'qq.top', title: '热歌榜', kind: 'list' as const },
      { sec: 'qq.new', title: '内地新歌', kind: 'list' as const },
      // 热门电台只有台站列表，没有把一台电台收成歌曲的现成接口。
      // 留下这个分区会回到卡片网格，所以发现页不放它。
      { sec: 'qq.singers', title: '热门歌手', kind: 'list' as const, expand: 'singer' as const },
    ],
  },
  {
    plat: 'bilibili',
    sections: [
      { sec: 'bilibili.ranking', title: '音乐区热门排行', kind: 'list' as const, showSource: true },
    ],
  },
  {
    plat: 'kugou',
    sections: [
      { sec: 'kugou.tops', title: '飙升榜', kind: 'list' as const },
      { sec: 'kugou.hot', title: '网络热歌榜', kind: 'list' as const },
      { sec: 'kugou.short', title: '短视频热歌榜', kind: 'list' as const },
      { sec: 'kugou.top500', title: 'TOP500', kind: 'list' as const },
      { sec: 'kugou.playlists', title: '推荐歌单', kind: 'list' as const, expand: 'playlist' as const },
    ],
  },
]);

export const HERO_TAGS: readonly string[] = Object.freeze([
  '周杰伦', '林俊杰', '五月天', 'Taylor Swift', '轻音乐', '钢琴曲', 'LoFi Hip Hop',
]);

/** 发现页状态 */
interface DiscoverState {
  platforms: PlatformInfo[];
  activePlat: string;
  /** plat → 当前选中的分区 sec */
  activeSec: Record<string, string>;
  /** sec → { data, loading, error, loaded } */
  sections: Record<string, DiscoverSectionState>;
  loading: boolean;
  error: string;
  sourceHealth: SourceHealthMap | null;
}

export const discover = reactive<DiscoverState>({
  platforms: [],
  activePlat: 'netease',
  activeSec: {},
  sections: {},        // sec → { data, loading, error }
  loading: false,
  error: '',
  sourceHealth: null,
});

/**
 * 发现页平台条：只放有榜单或歌单分区的音源。
 * 酷我 / 咪咕 / 5sing / 汽水只有搜索，不出现在这里；搜索和播放仍走各自页面。
 * 注册表已到时再滤掉未注册的 id，顺序跟 DISCOVER_SECTIONS。
 */
export const discoverPlatformIds: ComputedRef<readonly string[]> = computed(() => {
  const charts = DISCOVER_SECTIONS.map((p) => p.plat);
  const live = discover.platforms
    .map((p) => (p && typeof p.id === 'string' ? p.id.trim() : ''))
    .filter((id) => id.length > 0);
  if (!live.length) return charts;
  const known = new Set(live);
  return charts.filter((id) => known.has(id));
});

export const activePlatformMeta: ComputedRef<DiscoverPlatformGroup> = computed(
  () => DISCOVER_SECTIONS.find((p) => p.plat === discover.activePlat)
    || { plat: discover.activePlat, sections: [] },
);

export function platformSections(plat: string): readonly DiscoverSectionMeta[] {
  return (DISCOVER_SECTIONS.find((p) => p.plat === plat) || { sections: [] }).sections;
}

export function sectionState(sec: string): DiscoverSectionState {
  if (!discover.sections[sec]) {
    discover.sections[sec] = { data: [], loading: false, error: '', loaded: false };
  }
  return discover.sections[sec];
}

export function activeSection(plat: string = discover.activePlat): DiscoverSectionMeta | null {
  const list = platformSections(plat);
  const chosen = discover.activeSec[plat];
  return list.find((s) => s.sec === chosen) || list[0] || null;
}

export async function initDiscover(): Promise<void> {
  const [platforms, health] = await Promise.all([
    callSafe<PlatformInfo[], PlatformInfo[]>('getPlatforms', [], []),
    callSafe<SourceHealthMap | null>('getSourceHealth', [], null),
  ]);
  discover.platforms = Array.isArray(platforms) ? platforms : [];
  discover.sourceHealth = health;
  await ensurePlatform(discover.activePlat, true);
}

export function showPlatform(plat: string): void {
  discover.activePlat = plat;
  void ensurePlatform(plat);
}

export function showSection(plat: string, sec: string): void {
  discover.activeSec[plat] = sec;
  void ensureSection(sec);
}

export async function ensurePlatform(plat: string, force = false): Promise<void> {
  const sec = activeSection(plat);
  if (!sec) return;
  if (force || !sectionState(sec.sec).loaded) await ensureSection(sec.sec, force);
}

export async function ensureSection(sec: string, force = false): Promise<void> {
  const st = sectionState(sec);
  if (st.loading) return;
  if (st.loaded && !force) return;
  st.loading = true;
  st.error = '';
  try {
    const r = await call<HomeSectionResult>('getHomeSection', sec);
    if (r && r.ok) {
      const data: unknown[] = Array.isArray(r.data) ? r.data : [];
      const songs = await songsForSection(sec, data);
      st.data = songs;
      st.error = songs.length ? '' : '该区块暂无内容（平台可能暂时不可用）';
    } else {
      st.data = [];
      st.error = (r && r.error) || '加载失败';
    }
    st.loaded = true;
  } catch (e) {
    st.data = [];
    st.error = errMessage(e) || '加载失败';
    st.loaded = true;
  } finally {
    st.loading = false;
  }
}

/** 从 unknown 异常里取可读文案（与原实现的 `(e && e.message) || 兜底` 等价） */
function errMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

function sectionExpand(sec: string): DiscoverSectionExpand | '' {
  const meta = DISCOVER_SECTIONS
    .flatMap((p) => p.sections)
    .find((s) => s.sec === sec);
  return meta?.expand || '';
}

/**
 * 榜单分区的 data 已经是歌曲。歌单 / 歌手分区先取前几条摘要，
 * 再各拉几首，收成带来源名的一首榜。
 */
async function songsForSection(sec: string, data: unknown[]): Promise<Song[]> {
  const expand = sectionExpand(sec);
  if (!expand) return normalizeSongs(data);
  const platform = sec.split('.')[0] || '';
  const refs = readDiscoverSources(data, DISCOVER_FEED_CAPS.sources, platform);
  const limit = DISCOVER_FEED_CAPS.perSource;
  const bundles = await collectDiscoverBundles(refs, (ref) => (
    expand === 'playlist'
      ? call('getPlaylistSongs', ref.source, ref.id, limit)
      : call('getSingerSongs', ref.id, limit)
  ));
  return expandDiscoverFeed(bundles);
}

export function reloadActive(): void {
  const sec = activeSection();
  if (sec) void ensureSection(sec.sec, true);
}

export const platformNameMap: ComputedRef<Record<string, string>> = computed(() => {
  const map: Record<string, string> = {};
  for (const p of discover.platforms) map[p.id] = p.name;
  return map;
});

export function platformLabel(id: string): string {
  return platformNameMap.value[id] || platformName(id);
}