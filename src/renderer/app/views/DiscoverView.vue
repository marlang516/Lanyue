<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  discover, DISCOVER_SECTIONS, initDiscover, showPlatform, showSection,
  activeSection, sectionState, platformSections, platformLabel, reloadActive,
} from '../stores/discover';
import type { DiscoverSectionState, PlaylistSummary } from '../stores/types';
import type { SongLike } from '../core/song';
import { player, currentKey, playFromList, appendToQueue } from '../stores/player';
import { lyrics } from '../stores/lyrics';
import { activeLineIndex, projectPlayhead } from '../core/lyricMotion.js';
import { downloadSongs } from '../stores/search';
import { platformName } from '../core/format';
import { toast } from '../core/toast';
import SongTable from '../components/data/SongTable.vue';
import PlaylistCard from '../components/data/PlaylistCard.vue';
import PlaylistPeek from '../components/data/PlaylistPeek.vue';
import Icon from '../components/common/Icon.vue';

/** PlaylistCard 的 open 事件载荷（卡片组件内的行形状，字段全可选） */
interface PlaylistCardRow {
  name?: string;
  source?: string;
  cover?: string;
  playCount?: number;
  [key: string]: unknown;
}

const sec = computed(() => activeSection());
const st = computed<DiscoverSectionState>(() => (sec.value
  ? sectionState(sec.value.sec)
  : { data: [], loading: false, error: '', loaded: false }));

const peek = ref<{ open: boolean; playlist: PlaylistSummary | null }>({ open: false, playlist: null });

interface LyricWindow {
  prev: string;
  cur: string;
  next: string;
}

type PlayAnchor = { progress: number; at: number; rate: number };

const lyricLines = ref<LyricWindow>({ prev: '', cur: '', next: '' });
const coverGone = ref(false);
let anchor: PlayAnchor | null = null;
let followKey = '';
let raf = 0;
let alive = true;

const songKeyNow = computed(() => (
  player.current ? `${player.current.id}:${player.current.source}` : ''
));
/** 切歌后 loadedKey 还没对齐时，不把上一首的句子画在这首的封面上。 */
const lyricsMatch = computed(() => !!songKeyNow.value && lyrics.loadedKey === songKeyNow.value);
const stageLabel = computed(() => {
  const song = player.current;
  if (!song) return '打开全屏歌词';
  return `打开全屏歌词：${song.title}，${song.artist || '未知歌手'}`;
});

function setLines(next: LyricWindow): void {
  const cur = lyricLines.value;
  if (cur.prev === next.prev && cur.cur === next.cur && cur.next === next.next) return;
  lyricLines.value = next;
}

/**
 * 窄栏只显示三句：上一句淡、当前句强调、下一句淡。
 * 播放头与行号都走 lyricMotion，不另起歌词时钟，也不做逐字跳动。
 * 句子没变就不写响应式，避免每一帧重绘左侧列表。
 */
function publishLines(now: number): void {
  const song = player.current;
  const key = song ? `${song.id}:${song.source}` : '';
  if (key !== followKey) {
    followKey = key;
    anchor = null;
  }
  if (!song) {
    setLines({ prev: '', cur: '', next: '' });
    return;
  }
  const projected = projectPlayhead(
    anchor,
    player.progress,
    now,
    Number(player.rate) || 1,
    !!player.playing,
  );
  anchor = projected.anchor;
  if (lyrics.loadedKey !== key || !lyrics.items.length) {
    setLines({ prev: '', cur: '', next: '' });
    return;
  }
  const seconds = projected.seconds + (Number(lyrics.offsetMs) || 0) / 1000;
  const idx = activeLineIndex(lyrics.items, seconds);
  const items = lyrics.items;
  const prev = idx > 0 ? (items[idx - 1]?.text ?? '') : '';
  const cur = idx >= 0 ? (items[idx]?.text ?? '') : '';
  // 前奏还没到第一句：当前句留空，第一句放在下一句（淡）。
  const next = idx >= 0 ? (items[idx + 1]?.text ?? '') : (items[0]?.text ?? '');
  setLines({ prev, cur, next });
}

function loop(now: number): void {
  if (!alive) return;
  if (document.visibilityState !== 'hidden') publishLines(now);
  raf = requestAnimationFrame(loop);
}

watch(
  () => [songKeyNow.value, lyrics.loadedKey, lyrics.items, lyrics.offsetMs, player.progress, player.playing, player.rate],
  () => publishLines(performance.now()),
  { immediate: true },
);
watch(() => player.current?.cover, () => { coverGone.value = false; });

onMounted(() => {
  initDiscover();
  raf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  alive = false;
  cancelAnimationFrame(raf);
});

function onPlay(i: number) {
  playFromList(st.value.data, i);
}

function onQueue(song: SongLike) {
  const n = appendToQueue([song]);
  toast.success(`已加入队列 ${n} 首`);
}

async function onDownload(song: SongLike) {
  await downloadSongs([song]);
}

/** 卡片事件载荷 → 歌单摘要（id/source/name 归一到字符串，其余字段原样透传） */
function toPlaylistSummary(p: PlaylistCardRow): PlaylistSummary {
  return {
    ...p,
    id: String(p.id ?? ''),
    source: String(p.source ?? ''),
    name: String(p.name ?? ''),
  };
}

function openPlaylist(p: PlaylistCardRow) {
  peek.value = { open: true, playlist: toPlaylistSummary(p) };
}

function closePeek() {
  peek.value = { ...peek.value, open: false };
}

/** 封面加载失败时摘掉底图，舞台退回极光空底，不再补一块硬封面。 */
function dropBrokenImg(e: Event): void {
  coverGone.value = true;
  if (e.target instanceof HTMLElement) e.target.remove();
}

function openStage(): void {
  player.fullscreen = true;
}
</script>

<template>
  <div class="discover">
    <div class="cols">
      <!-- 平台内容 -->
      <section class="feed ly-card">
        <div class="plat-tabs">
          <button
            v-for="p in DISCOVER_SECTIONS" :key="p.plat"
            class="ptab" :class="{ on: discover.activePlat === p.plat }"
            @click="showPlatform(p.plat)"
          >
            {{ platformLabel(p.plat) }}
          </button>
        </div>

        <div class="chips">
          <button
            v-for="s in platformSections(discover.activePlat)" :key="s.sec"
            class="chip" :class="{ on: sec && sec.sec === s.sec }"
            @click="showSection(discover.activePlat, s.sec)"
          >
            {{ s.title }}
          </button>
          <button class="chip ghost" title="刷新" aria-label="刷新" @click="reloadActive">
            <Icon name="refresh" :size="13" />
          </button>
        </div>

        <header class="sec-head">
          <div class="sec-title">
            <h2>{{ sec ? sec.title : '推荐' }}</h2>
            <p>{{ platformName(discover.activePlat) }} · {{ st.data.length }} 项</p>
          </div>
          <span v-if="sec && sec.kind === 'list' && st.data.length" class="ly-tag ly-tag-accent">前 {{ Math.min(st.data.length, 20) }} 首</span>
        </header>

        <div class="sec-body">
          <div v-if="st.loading" class="grid skel">
            <div v-for="n in 10" :key="n" class="ly-skeleton" style="aspect-ratio: 1 / 1"></div>
          </div>

          <div v-else-if="st.error" class="ly-empty">
            <Icon name="warning" />
            <b>{{ st.error }}</b>
            <button class="ly-btn ly-btn-sm" @click="reloadActive">重试</button>
          </div>

          <div v-else-if="sec && sec.kind === 'grid'" class="grid">
            <PlaylistCard
              v-for="p in st.data" :key="p.source + '-' + p.id"
              :playlist="p" @open="openPlaylist"
            />
          </div>

          <SongTable
            v-else :songs="st.data" :active-key="currentKey"
            :show-source="true" @play="onPlay" @queue="onQueue" @download="onDownload"
          />
        </div>
      </section>

      <!-- 侧栏：整列一块播放舞台。点击进入现有全屏歌词页。 -->
      <aside class="side">
        <button
          v-if="player.current"
          type="button"
          class="stage ly-card"
          :class="{ bare: !player.current.cover || coverGone }"
          :aria-label="stageLabel"
          :title="stageLabel"
          @click="openStage"
        >
          <img
            v-if="player.current.cover && !coverGone"
            class="wash"
            :src="player.current.cover"
            alt=""
            @error="dropBrokenImg"
          />
          <div class="veil"></div>
          <div class="stage-body">
            <div class="meta">
              <b>{{ player.current.title }}</b>
              <span>{{ player.current.artist || '未知歌手' }}</span>
            </div>
            <div class="lyrics" aria-hidden="true">
              <template v-if="lyricsMatch && lyrics.items.length">
                <span class="line prev">{{ lyricLines.prev }}</span>
                <span class="line" :class="lyricLines.cur ? 'cur' : 'gap'">{{ lyricLines.cur }}</span>
                <span class="line next">{{ lyricLines.next }}</span>
              </template>
              <span v-else-if="!lyricsMatch || lyrics.loading" class="wait">
                <i class="ly-skeleton"></i>
                <i class="ly-skeleton"></i>
                <i class="ly-skeleton"></i>
              </span>
              <span v-else class="none">{{ lyrics.error || '暂无歌词' }}</span>
            </div>
          </div>
        </button>

        <div v-else class="stage ly-card idle">
          <div class="veil"></div>
          <div class="stage-body">
            <div class="idle-copy">
              <b>未在播放</b>
              <span>从左侧列表点一首开始</span>
            </div>
          </div>
        </div>
      </aside>
    </div>

    <PlaylistPeek :open="peek.open" :playlist="peek.playlist" @close="closePeek" />
  </div>
</template>

<style scoped>
.discover { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }

.cols { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 300px; gap: var(--gap-app); }

.feed { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: var(--sp-4) var(--sp-6) var(--sp-5); overflow: hidden; }

.plat-tabs {
  display: inline-flex; align-self: flex-start; gap: 4px; padding: 4px;
  background: var(--glass-2); border: 1px solid var(--hairline);
  border-radius: var(--r-md); box-shadow: inset 0 1px 0 var(--stroke);
  overflow-x: auto; scrollbar-width: none;
}
.plat-tabs::-webkit-scrollbar { display: none; }
.ptab {
  height: 30px; padding: 0 var(--sp-4); border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--ink-3); font-size: var(--fs-sm); font-weight: var(--fw-med);
  cursor: pointer; white-space: nowrap;
  transition: color var(--dur-1) var(--ease), background var(--dur-1) var(--ease), transform var(--dur-0) var(--ease);
}
.ptab:hover { color: var(--ink); background: var(--glass-3); }
.ptab:active { transform: scale(.97); }
.ptab.on {
  color: var(--on-accent); background: var(--au-grad);
  box-shadow: 0 4px 12px rgba(124, 92, 255, .35);
}

.chips { display: flex; align-items: center; gap: var(--sp-1); padding: var(--sp-3) 0 0; overflow-x: auto; scrollbar-width: none; }
.chips::-webkit-scrollbar { display: none; }
.chip {
  height: 28px; padding: 0 var(--sp-3); border: 1px solid transparent; border-radius: var(--r-full);
  background: transparent; color: var(--ink-3); font-size: var(--fs-xs); font-weight: var(--fw-med);
  cursor: pointer; white-space: nowrap;
  transition: color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease), background var(--dur-1) var(--ease), transform var(--dur-0) var(--ease);
}
.chip:hover { color: var(--ink-2); background: var(--glass-3); }
.chip:active { transform: scale(.95); }
.chip.on {
  color: var(--au-1); background: var(--accent-soft); border-color: var(--accent-line);
  box-shadow: 0 2px 8px rgba(124, 92, 255, .15);
}
.chip.ghost { width: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }

.sec-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-5) 0 var(--sp-3); }
.sec-title { position: relative; display: flex; align-items: baseline; gap: var(--sp-3); padding-left: 12px; }
.sec-title::before {
  content: ""; position: absolute; left: 0; top: 6px; bottom: 6px;
  width: 3px; border-radius: var(--r-full); background: var(--au-grad);
}
.sec-title h2 { font-size: var(--fs-xl); font-weight: var(--fw-bold); letter-spacing: .01em; }
.sec-title p { font-size: var(--fs-xs); color: var(--ink-3); }

.sec-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: var(--sp-4); padding-bottom: var(--sp-3); }
.skel { gap: var(--sp-4); }
.skel > div { border-radius: var(--r-md); }

/* ── 侧栏：模糊封面铺满整列，歌词是主体；歌名贴在上沿 ── */
.side { min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.stage {
  position: relative; flex: 1 1 auto; min-height: 0; min-width: 0; width: 100%;
  overflow: hidden; display: flex; flex-direction: column;
  padding: 0; text-align: center; cursor: pointer;
}
.stage.idle { cursor: default; }
.side .stage.ly-card:hover { transform: none; box-shadow: var(--shadow-card); }
.wash {
  position: absolute; top: -22%; left: -22%; width: 144%; height: 144%;
  max-width: none; max-height: none;
  object-fit: cover; filter: blur(56px) saturate(1.45);
  pointer-events: none;
}
.veil {
  position: absolute; inset: 0; pointer-events: none;
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--bg) 58%, transparent) 0%,
      color-mix(in srgb, var(--bg) 34%, transparent) 22%,
      color-mix(in srgb, var(--bg) 34%, transparent) 78%,
      color-mix(in srgb, var(--bg) 52%, transparent) 100%);
}
.stage.idle .veil,
.stage.bare .veil {
  background:
    radial-gradient(72% 46% at 50% 28%, var(--blob-1), transparent 70%),
    radial-gradient(58% 40% at 84% 80%, var(--blob-2), transparent 72%),
    radial-gradient(48% 34% at 12% 88%, var(--blob-3), transparent 74%),
    linear-gradient(180deg, color-mix(in srgb, var(--glass-2) 72%, transparent), var(--glass));
}
.stage-body {
  position: relative; z-index: 1; flex: 1; min-height: 0;
  display: flex; flex-direction: column; justify-content: center;
  padding: var(--sp-8) var(--sp-5) var(--sp-5);
}
.meta {
  position: absolute; top: var(--sp-4); left: var(--sp-4); right: var(--sp-4);
  min-width: 0; text-align: left;
}
.meta b, .meta span {
  display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meta b { font-size: var(--fs-sm); font-weight: var(--fw-med); color: var(--ink-2); }
.meta span { margin-top: 2px; font-size: var(--fs-xs); color: var(--ink-3); }
.idle-copy { width: 100%; min-width: 0; }
.idle-copy b {
  display: block; font-size: var(--fs-lg); font-weight: var(--fw-bold); letter-spacing: .01em;
}
.idle-copy span {
  display: block; margin-top: var(--sp-2); font-size: var(--fs-sm); color: var(--ink-3);
}
.lyrics {
  width: 100%; min-height: 0;
  display: flex; flex-direction: column; justify-content: center; gap: var(--sp-3);
}
.line {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
  margin: 0; overflow: hidden; overflow-wrap: break-word;
  font-size: var(--fs-lg); font-weight: var(--fw-med); line-height: 1.45;
  color: var(--ink-2); opacity: .72;
  transition: color var(--dur-2) var(--ease), opacity var(--dur-2) var(--ease);
}
.line.prev { opacity: .55; }
.line.next { opacity: .68; }
.line.cur {
  font-size: var(--fs-2xl); font-weight: var(--fw-bold); line-height: 1.35;
  color: var(--ink); opacity: 1;
}
.line.gap { opacity: 0; }
.none {
  display: block; font-size: var(--fs-xl); font-weight: var(--fw-bold); line-height: 1.4;
  color: var(--ink-2);
}
.wait { width: 100%; display: flex; flex-direction: column; align-items: center; gap: var(--sp-3); }
.wait .ly-skeleton { height: 14px; border-radius: var(--r-full); width: 72%; }
.wait .ly-skeleton:nth-child(2) { width: 88%; height: 22px; }
.wait .ly-skeleton:nth-child(3) { width: 64%; }
@media (prefers-reduced-motion: reduce) {
  .line { transition: none; }
}

/* ── 搜索列表行 hover 向右位移 + active 内发光（极光风行态）── */
.ly-row {
  transition: transform var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
}
.ly-row:hover { transform: translateX(4px); background: var(--glass-3); }
.ly-row.is-active {
  background: linear-gradient(95deg, rgba(124, 92, 255, .13), rgba(0, 198, 255, .1));
  box-shadow: inset 0 0 0 1px var(--accent-line);
}

/* ── 歌单卡片 hover 升起 ── */
.ly-card { transition: transform var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease); }
.ly-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-pop); }
</style>