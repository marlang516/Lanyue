<script setup lang="ts">
import { computed } from 'vue';
import {
  player, togglePlay, next, prev, seekTo, setVolume, cycleMode,
} from '../stores/player';
import { isFavorite, toggleFavorite } from '../stores/playlist';
import { fmtDuration, pct, platformName, qualityLabel } from '../core/format';
import { downloadSongs } from '../stores/search';
import { toast } from '../core/toast';
import LyricsPane from '../components/player/LyricsPane.vue';
import Icon from '../components/common/Icon.vue';

const fav = computed(() => (player.current ? isFavorite(player.current) : false));
const progressPct = computed(() => pct(player.progress, player.duration));

function close() {
  player.fullscreen = false;
}
function onScrub(e: MouseEvent) {
  const el = e.currentTarget;
  if (!(el instanceof HTMLElement)) return;
  const r = el.getBoundingClientRect();
  seekTo(((e.clientX - r.left) / r.width) * (player.duration || 0));
}
function onVolume(e: Event) {
  const el = e.target;
  if (el instanceof HTMLInputElement) setVolume(Number(el.value) / 100);
}
function onHeart() {
  if (player.current) toggleFavorite(player.current);
}
async function onDownload() {
  if (!player.current) return;
  const n = await downloadSongs([player.current]);
  if (n) toast.success('已加入下载队列');
}
</script>

<template>
  <Teleport to="body">
    <Transition name="np">
      <div v-if="player.fullscreen" class="now">
        <div class="bg" :style="player.current?.cover ? { backgroundImage: `url(${player.current.cover})` } : {}"></div>
        <div class="veil"></div>

        <header class="hd ly-drag">
          <button class="ly-icon-btn" title="收起" aria-label="收起播放页" @click="close">
            <Icon name="chevron-down" />
          </button>
          <span class="hd-title">正在播放</span>
          <button class="ly-icon-btn" title="下载本曲" aria-label="下载本曲" :disabled="!player.current" @click="onDownload">
            <Icon name="download" />
          </button>
        </header>

        <main class="stage">
          <section class="art">
            <div class="cover" :class="{ ph: !player.current?.cover, live: player.playing }">
              <img v-if="player.current?.cover" :src="player.current.cover" alt="" />
              <Icon v-else name="disc" :size="64" />
            </div>

            <h1>{{ player.current ? player.current.title : '未在播放' }}</h1>
            <p class="sub">
              {{ player.current ? (player.current.artist || '未知歌手') : '从列表点一首开始' }}
              <template v-if="player.current?.album"> · {{ player.current.album }}</template>
            </p>

            <div class="meta">
              <span class="ly-tag" :class="{ 'ly-tag-accent': player.quality === 'lossless' }">{{ qualityLabel(player.quality) }}</span>
              <span v-if="player.current" class="ly-tag">{{ platformName(player.current.source) }}</span>
              <button
                class="ly-icon-btn heart" :class="{ on: fav }" :disabled="!player.current"
                :title="fav ? '取消收藏' : '收藏'" :aria-label="fav ? '取消收藏' : '收藏'" @click="onHeart"
              >
                <Icon name="heart" :size="16" />
              </button>
            </div>

            <div class="hero-err" v-if="player.error">{{ player.error }}</div>
          </section>

          <section class="ly ly-card">
            <LyricsPane />
          </section>
        </main>

        <footer class="ctr ly-card">
          <div class="scrub">
            <span class="time">{{ fmtDuration(player.progress) }}</span>
            <div class="track" role="slider" aria-label="播放进度" @click="onScrub">
              <i :style="{ width: progressPct + '%' }"></i>
            </div>
            <span class="time">{{ fmtDuration(player.duration) }}</span>
          </div>

          <div class="row">
            <div class="left-stub"></div>
            <div class="btns">
              <button class="ly-icon-btn" title="播放模式" aria-label="播放模式" @click="cycleMode">
                <Icon name="repeat" :size="17" />
              </button>
              <button class="ly-icon-btn" title="上一首" aria-label="上一首" @click="prev">
                <Icon name="prev" :size="17" />
              </button>
              <button class="pp" :aria-label="player.playing ? '暂停' : '播放'" @click="togglePlay">
                <Icon :name="player.playing ? 'pause' : 'play'" :size="20" />
              </button>
              <button class="ly-icon-btn" title="下一首" aria-label="下一首" @click="next()">
                <Icon name="next" :size="17" />
              </button>
              <button class="ly-icon-btn" title="播放队列" aria-label="播放队列" @click="player.queueOpen = true">
                <Icon name="queue" :size="17" />
              </button>
            </div>
            <div class="vol">
              <Icon name="volume" :size="16" />
              <input type="range" min="0" max="100" :value="Math.round(player.volume * 100)" aria-label="音量" @input="onVolume" />
            </div>
          </div>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.now {
  position: fixed; inset: 0; z-index: var(--z-modal);
  display: flex; flex-direction: column;
  color: var(--ink);
  overflow: hidden;
}
.bg {
  position: absolute; inset: -80px;
  background-size: cover; background-position: center;
  filter: blur(56px) saturate(150%);
  opacity: .55; transform: scale(1.08);
}
.veil {
  position: absolute; inset: 0;
  background:
    radial-gradient(44% 50% at 18% 20%, var(--blob-1), transparent 70%),
    radial-gradient(40% 46% at 82% 16%, var(--blob-2), transparent 70%),
    linear-gradient(180deg, rgba(242, 244, 249, .55), rgba(242, 244, 249, .9));
}
[data-theme="dark"] .veil {
  background:
    radial-gradient(44% 50% at 18% 20%, var(--blob-1), transparent 70%),
    radial-gradient(40% 46% at 82% 16%, var(--blob-2), transparent 70%),
    linear-gradient(180deg, rgba(13, 16, 32, .55), rgba(13, 16, 32, .92));
}

.hd {
  position: relative; z-index: 1;
  display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-6);
}
.hd-title { flex: 1; font-size: var(--fs-xs); letter-spacing: .26em; color: var(--ink-3); font-weight: var(--fw-bold); }

.stage {
  position: relative; z-index: 1;
  flex: 1; min-height: 0;
  display: grid; grid-template-columns: minmax(280px, 38%) 1fr;
  gap: var(--sp-8);
  padding: 0 var(--sp-8);
  max-width: 1400px; width: 100%; margin: 0 auto;
}
.art { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-3); min-height: 0; }
.cover {
  width: min(340px, 34vh); aspect-ratio: 1 / 1;
  border-radius: 50%; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  background: var(--au-grad-3); color: #fff;
  box-shadow: 0 24px 70px rgba(20, 24, 36, .28);
}
.cover.ph { background: linear-gradient(135deg, var(--glass-2), var(--accent-soft)); color: var(--ink-3); box-shadow: var(--shadow-pop); }
.cover img { width: 100%; height: 100%; object-fit: cover; }
.cover.live img { animation: spin 26s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.art h1 { margin-top: var(--sp-2); font-size: var(--fs-2xl); font-weight: var(--fw-black); text-align: center; max-width: 100%; }
.sub { font-size: var(--fs-sm); color: var(--ink-2); text-align: center; }
.meta { display: flex; align-items: center; gap: var(--sp-2); }
.heart.on { color: var(--au-3); }
.hero-err { font-size: var(--fs-xs); color: var(--danger); text-align: center; }

.ly { min-height: 0; display: flex; flex-direction: column; padding: var(--sp-5); overflow: hidden; }

.ctr {
  position: relative; z-index: 1;
  margin: var(--sp-5) var(--sp-8) var(--sp-6);
  padding: var(--sp-3) var(--sp-5) var(--sp-4);
  display: flex; flex-direction: column; gap: var(--sp-2);
  width: min(1000px, calc(100% - 2 * var(--sp-8)));
  align-self: center;
}
.scrub { display: flex; align-items: center; gap: var(--sp-3); }
.time { width: 42px; flex-shrink: 0; text-align: center; font-size: var(--fs-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.track { flex: 1; height: 16px; display: flex; align-items: center; cursor: pointer; }
.track > i { display: block; height: 4px; border-radius: var(--r-full); background: var(--au-grad); }
.track:hover > i { height: 6px; }

.row { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: var(--sp-4); }
.btns { display: flex; align-items: center; gap: var(--sp-2); }
.pp {
  width: 48px; height: 48px; border: 0; border-radius: 50%;
  background: var(--au-grad); color: #fff; box-shadow: var(--glow-accent);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; transition: transform var(--dur-1) var(--ease);
}
.pp:hover { transform: scale(1.06); }
.vol { display: flex; align-items: center; justify-content: flex-end; gap: 8px; color: var(--ink-3); }
.vol input { width: 110px; height: 4px; accent-color: var(--au-1); cursor: pointer; }

.np-enter-active, .np-leave-active { transition: opacity var(--dur-2) var(--ease), transform var(--dur-2) var(--ease-emph); }
.np-enter-from, .np-leave-to { opacity: 0; transform: translateY(30px) scale(.985); }

@media (max-width: 900px) {
  .stage { grid-template-columns: 1fr; gap: var(--sp-4); }
  .art { display: none; }
}
</style>