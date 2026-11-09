<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import {
  discover, DISCOVER_SECTIONS, HERO_TAGS, initDiscover, showPlatform, showSection,
  activeSection, sectionState, platformSections, platformLabel, reloadActive,
} from '../stores/discover';
import type { DiscoverSectionState, PlaylistSummary } from '../stores/types';
import type { SongLike } from '../core/song';
import { ui, openSearch } from '../stores/ui';
import { player, currentKey, playFromList } from '../stores/player';
import { appendToQueue } from '../stores/player';
import { downloadSongs } from '../stores/search';
import { fmtDuration, platformName } from '../core/format';
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
const heroKw = ref('');

onMounted(initDiscover);

function gotoSearch(kw: string) {
  openSearch(kw);
}

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

/** 封面加载失败时移除自身（与原内联 handler 等价，额外容忍 target 为空） */
function dropBrokenImg(e: Event): void {
  if (e.target instanceof HTMLElement) e.target.remove();
}
</script>

<template>
  <div class="discover">
    <!-- Hero -->
    <section class="hero ly-card">
      <div class="hero-copy">
        <div class="tag">AURORA MIX · {{ ui.appVersion || 'v2' }}</div>
        <h1 class="ly-accent-text">聚合发现</h1>
        <p class="sub">8 音源并行比价，自动锁定每曲最高码率源；从榜单与歌单里挑一首，剩下的交给播放器。</p>

        <form class="hero-search ly-search" @submit.prevent="gotoSearch(heroKw)">
          <Icon name="search" :size="16" />
          <input v-model="heroKw" placeholder="搜索歌曲、歌手、专辑…" aria-label="搜索" />
          <button class="ly-btn ly-btn-sm ly-btn-primary" type="submit">搜索</button>
        </form>

        <div class="hero-tags">
          <button v-for="t in HERO_TAGS" :key="t" class="htag" @click="gotoSearch(t)">{{ t }}</button>
        </div>
      </div>

      <div class="hero-deco" aria-hidden="true">
        <div class="ring r1"></div>
        <div class="ring r2"></div>
        <div class="ring r3"></div>
      </div>
    </section>

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
          <div>
            <h2>{{ sec ? sec.title : '推荐' }}</h2>
            <p>{{ platformName(discover.activePlat) }} · {{ st.data.length }} 项</p>
          </div>
          <span v-if="sec && sec.kind === 'list' && st.data.length" class="ly-tag">前 {{ Math.min(st.data.length, 20) }} 首</span>
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

      <!-- 侧栏：仅在 A 布局显示 -->
      <aside class="side">
        <div class="now ly-card">
          <div class="disc" :class="{ live: player.playing }">
            <div class="in">
              <div class="art" :class="{ ph: !player.current?.cover }">
                <img v-if="player.current?.cover" :src="player.current.cover" alt="" @error="dropBrokenImg" />
                <Icon v-else name="disc" :size="26" />
              </div>
            </div>
          </div>
          <div class="now-tx">
            <b>{{ player.current ? player.current.title : '未在播放' }}</b>
            <span>{{ player.current ? `${player.current.artist} · ${platformName(player.current.source)}` : '从右侧列表点一首开始' }}</span>
          </div>
          <div class="now-meta">
            <span>{{ fmtDuration(player.progress) }} / {{ fmtDuration(player.duration) }}</span>
            <span class="ly-tag">{{ player.quality === 'lossless' ? 'FLAC' : player.quality === 'hq' ? '320K' : '128K' }}</span>
          </div>
        </div>

        <div class="krow">
          <div class="kc"><b>{{ DISCOVER_SECTIONS.length }}</b><span>平台</span></div>
          <div class="kc"><b>{{ st.data.length }}</b><span>本区</span></div>
          <div class="kc"><b>{{ ui.appVersion || '—' }}</b><span>版本</span></div>
        </div>
      </aside>
    </div>

    <PlaylistPeek :open="peek.open" :playlist="peek.playlist" @close="closePeek" />
  </div>
</template>

<style scoped>
.discover { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--gap-app); overflow: hidden; }
.hero {
  position: relative; flex-shrink: 0;
  padding: var(--sp-7) var(--sp-8);
  display: flex; align-items: flex-start; gap: var(--sp-6);
  overflow: hidden;
}
.hero-copy { position: relative; z-index: 2; flex: 1; min-width: 0; }
.tag { font-size: var(--fs-xs); letter-spacing: .28em; color: var(--au-1); font-weight: var(--fw-bold); }
h1 { font-size: var(--fs-hero); font-weight: var(--fw-black); margin-top: var(--sp-2); letter-spacing: -.01em; }
.sub { margin-top: var(--sp-2); color: var(--ink-2); font-size: var(--fs-sm); line-height: 1.7; max-width: 62ch; }
.hero-search { margin-top: var(--sp-5); max-width: 620px; }
.hero-tags { margin-top: var(--sp-3); display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.htag {
  border: 1px solid var(--hairline); background: var(--glass-3);
  color: var(--ink-2); font-size: var(--fs-xs); padding: 5px 10px;
  border-radius: var(--r-full); cursor: pointer;
  transition: color var(--dur-1), border-color var(--dur-1), background var(--dur-1);
}
.htag:hover { color: var(--au-1); border-color: var(--accent-line); background: var(--accent-soft); }

.hero-deco { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.ring { position: absolute; border-radius: 50%; border: 1px solid var(--accent-line); opacity: .35; }
.r1 { width: 320px; height: 320px; right: -80px; top: -150px; }
.r2 { width: 220px; height: 220px; right: 30px; top: -60px; background: radial-gradient(circle, var(--accent-soft), transparent 70%); }
.r3 { width: 140px; height: 140px; right: 180px; top: 40px; border-style: dashed; }

.cols { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 300px; gap: var(--gap-app); }

.feed { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: var(--sp-4) var(--sp-6) var(--sp-5); overflow: hidden; }

.plat-tabs { display: flex; gap: var(--sp-1); padding-bottom: var(--sp-3); border-bottom: 1px solid var(--hairline); overflow-x: auto; scrollbar-width: none; }
.plat-tabs::-webkit-scrollbar { display: none; }
.ptab {
  height: 30px; padding: 0 var(--sp-4); border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--ink-3); font-size: var(--fs-sm); font-weight: var(--fw-med);
  cursor: pointer; white-space: nowrap;
  transition: color var(--dur-1), background var(--dur-1);
}
.ptab:hover { color: var(--ink-2); background: var(--glass-3); }
.ptab.on { color: var(--au-1); background: var(--accent-soft); }

.chips { display: flex; gap: var(--sp-1); padding: var(--sp-3) 0 0; overflow-x: auto; scrollbar-width: none; }
.chips::-webkit-scrollbar { display: none; }
.chip {
  height: 26px; padding: 0 var(--sp-3); border: 1px solid transparent; border-radius: var(--r-full);
  background: transparent; color: var(--ink-3); font-size: var(--fs-xs);
  cursor: pointer; white-space: nowrap;
  transition: color var(--dur-1), border-color var(--dur-1), background var(--dur-1);
}
.chip:hover { color: var(--ink-2); background: var(--glass-3); }
.chip.on { color: var(--ink); background: var(--glass-2); border-color: var(--hairline); }
.chip.ghost { width: 26px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }

.sec-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-4) 0 var(--sp-3); }
.sec-head h2 { font-size: var(--fs-xl); font-weight: var(--fw-bold); }
.sec-head p { margin-top: 2px; font-size: var(--fs-xs); color: var(--ink-3); }

.sec-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: var(--sp-4); padding-bottom: var(--sp-3); }
.skel { gap: var(--sp-4); }
.skel > div { border-radius: var(--r-md); }

.side { min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); overflow-y: auto; }
.now { padding: var(--sp-5); display: flex; flex-direction: column; align-items: center; gap: var(--sp-3); }
.disc {
  width: 168px; height: 168px; border-radius: 50%;
  background: var(--au-grad-3); box-shadow: var(--glow-accent);
  display: flex; align-items: center; justify-content: center;
  animation: spin 22s linear infinite;
}
.disc.live { animation-duration: 9s; }
@keyframes spin { to { transform: rotate(360deg); } }
.disc .in {
  width: 78%; height: 78%; border-radius: 50%;
  background: var(--glass-3); backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center;
}
.art { width: 82%; height: 82%; border-radius: 50%; overflow: hidden; display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
.art img { width: 100%; height: 100%; object-fit: cover; }
.art.ph { background: linear-gradient(135deg, var(--glass-2), var(--accent-soft)); }
.now-tx { text-align: center; min-width: 0; width: 100%; }
.now-tx b { display: block; font-size: var(--fs-md); font-weight: var(--fw-bold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.now-tx span { display: block; margin-top: 3px; font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.now-meta { width: 100%; display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }

.krow { display: flex; gap: var(--sp-2); }
.kc {
  flex: 1; padding: var(--sp-3) var(--sp-2); text-align: center;
  border-radius: var(--r-md); background: var(--glass-3); border: 1px solid var(--hairline);
}
.kc b { display: block; font-size: var(--fs-md); font-weight: var(--fw-black); color: var(--au-1); }
.kc span { font-size: var(--fs-2xs); color: var(--ink-3); letter-spacing: .06em; }
</style>