<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  discover, discoverPlatformIds, initDiscover, showPlatform, showSection,
  activeSection, sectionState, platformSections, platformLabel, reloadActive,
} from '../stores/discover';
import type { DiscoverSectionState, PlaylistSummary } from '../stores/types';
import type { DiscoverPlaylistRef } from '../core/discoverFeed';
import { player, currentKey, playFromList } from '../stores/player';
import { lyrics } from '../stores/lyrics';
import { activeLineIndex, lyricDisplaySeconds, projectPlayhead } from '../core/lyricMotion.js';
import { platformName } from '../core/format';
import DiscoverRankList from '../components/data/DiscoverRankList.vue';
import PlaylistPeek from '../components/data/PlaylistPeek.vue';
import Icon from '../components/common/Icon.vue';

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
 * 窄栏只显示三句：上一句淡、当前句强调、下一句淡，每句保持一行。
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
  const seconds = lyricDisplaySeconds(projected.seconds, lyrics.offsetMs);
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

/** 打开这一首歌所属的那一个歌单，不把当前榜再播一遍。 */
function openPlaylist(ref: DiscoverPlaylistRef): void {
  const id = String(ref?.id || '').trim();
  const source = String(ref?.source || '').trim();
  if (!id || !source) return;
  peek.value = {
    open: true,
    playlist: { id, source, name: String(ref.name || '').trim() },
  };
}

function closePeek(): void {
  peek.value = { ...peek.value, open: false };
}

/** 封面加载失败时摘掉底图，舞台退回极光空底，不再补一块硬封面。 */
function dropBrokenImg(): void {
  coverGone.value = true;
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
        <div class="plat-tabs" role="tablist" aria-label="平台">
          <button
            v-for="id in discoverPlatformIds" :key="id"
            type="button"
            role="tab"
            class="ptab" :class="{ on: discover.activePlat === id }"
            :aria-selected="discover.activePlat === id"
            @click="showPlatform(id)"
          >
            {{ platformLabel(id) }}
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
            <p>{{ platformName(discover.activePlat) }} · {{ st.data.length }} 首</p>
          </div>
          <span v-if="!st.loading && st.data.length" class="ly-tag ly-tag-accent">前 {{ st.data.length }} 首</span>
        </header>

        <div class="sec-body">
          <div v-if="st.loading" class="rank-skel" aria-hidden="true">
            <div class="hero-skel">
              <div class="ly-skeleton cov"></div>
              <div class="lines">
                <div class="ly-skeleton"></div>
                <div class="ly-skeleton"></div>
                <div class="ly-skeleton"></div>
              </div>
            </div>
            <div v-for="n in 7" :key="n" class="row-skel">
              <div class="ly-skeleton no"></div>
              <div class="ly-skeleton art"></div>
              <div class="ly-skeleton tx"></div>
            </div>
          </div>

          <div v-else-if="st.error" class="ly-empty">
            <Icon name="warning" />
            <b>{{ st.error }}</b>
            <button class="ly-btn ly-btn-sm" @click="reloadActive">重试</button>
          </div>

          <DiscoverRankList
            v-else
            :songs="st.data"
            :active-key="currentKey"
            @play="onPlay"
            @open-playlist="openPlaylist"
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

.cols { flex: 1; min-height: 0; min-width: 0; display: grid; grid-template-columns: 1fr 300px; gap: var(--gap-app); }

.feed { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; padding: var(--sp-4) var(--sp-6) var(--sp-5); overflow: hidden; }

.plat-tabs {
  display: flex; flex-wrap: wrap; align-self: flex-start; max-width: 100%; min-width: 0;
  gap: 4px; padding: 4px;
  background: var(--glass-2); border: 1px solid var(--hairline);
  border-radius: var(--r-md); box-shadow: inset 0 1px 0 var(--stroke);
}
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
.rank-skel { display: flex; flex-direction: column; gap: var(--sp-3); padding-bottom: var(--sp-3); }
.rank-skel .ly-skeleton { display: block; }
.hero-skel {
  display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: var(--sp-4); align-items: center;
  padding: var(--sp-3); border-radius: 22px; border: 1px solid var(--stroke);
}
.hero-skel .cov { width: 132px; height: 132px; border-radius: 18px; }
.hero-skel .lines { display: flex; flex-direction: column; gap: var(--sp-2); }
.hero-skel .lines .ly-skeleton { height: 14px; border-radius: var(--r-full); width: 42%; }
.hero-skel .lines .ly-skeleton:nth-child(2) { width: 68%; height: 26px; }
.hero-skel .lines .ly-skeleton:nth-child(3) { width: 36%; }
.row-skel {
  display: grid; grid-template-columns: 36px 40px minmax(0, 1fr); gap: 10px; align-items: center;
  height: 54px; padding: 0 8px;
}
.row-skel .no { width: 22px; height: 14px; border-radius: var(--r-full); justify-self: center; }
.row-skel .art { width: 40px; height: 40px; border-radius: 10px; }
.row-skel .tx { height: 14px; border-radius: var(--r-full); width: 46%; }

/* ── 侧栏：当前歌曲封面半透明铺满整列，歌词是主体；歌名贴在上沿 ── */
.side { min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.stage {
  position: relative; flex: 1 1 auto; min-height: 0; min-width: 0; width: 100%;
  overflow: hidden; display: flex; flex-direction: column;
  padding: 0; text-align: center; cursor: pointer;
}
.stage.idle { cursor: default; }
.side .stage.ly-card:hover { transform: none; box-shadow: var(--shadow-card); }
.wash {
  position: absolute; top: -8%; left: -8%; width: 116%; height: 116%;
  max-width: none; max-height: none;
  object-fit: cover;
  /* .58：封面仍是这首歌的图，玻璃底透出来，歌词不用跟实图抢。8px 只去硬边。 */
  filter: blur(8px) saturate(1.2);
  opacity: .58;
  pointer-events: none;
}
.veil {
  position: absolute; inset: 0; pointer-events: none;
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--bg) 46%, transparent) 0%,
      color-mix(in srgb, var(--bg) 22%, transparent) 16%,
      color-mix(in srgb, var(--bg) 22%, transparent) 84%,
      color-mix(in srgb, var(--bg) 40%, transparent) 100%);
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
  text-shadow: 0 1px 14px color-mix(in srgb, var(--bg) 80%, transparent);
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
  display: block; min-width: 0; max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin: 0;
  font-size: var(--fs-lg); font-weight: var(--fw-med); line-height: 1.45;
  color: var(--ink-2); opacity: .72;
  text-shadow: 0 1px 14px color-mix(in srgb, var(--bg) 80%, transparent);
  /* 当前句跟播放时钟一起换。0.32s 的淡入会让这句在拍点之后才显出来。 */
  transition: none;
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

/* ── 卡片 hover 升起 ── */
.ly-card { transition: transform var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease); }
.ly-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-pop); }
</style>