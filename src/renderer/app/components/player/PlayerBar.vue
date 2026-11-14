<script setup lang="ts">
import { computed } from 'vue';
import {
  player, currentKey, togglePlay, next, prev, seekTo, setVolume, setRate,
  setQuality, cycleMode,
} from '../../stores/player';
import type { PlayMode } from '../../stores/types';
import { lyrics } from '../../stores/lyrics';
import { playlists, isFavorite, toggleFavorite } from '../../stores/playlist';
import { callSafe } from '../../core/bridge';
import { fmtDuration, pct, platformName } from '../../core/format';
import Icon from '../common/Icon.vue';

const MODE_ICON: Readonly<Record<PlayMode, string>> = {
  order: 'list', 'list-loop': 'repeat', single: 'repeatOne', shuffle: 'shuffle',
};
const MODE_LABEL: Readonly<Record<PlayMode, string>> = {
  order: '顺序播放', 'list-loop': '列表循环', single: '单曲循环', shuffle: '随机播放',
};
const RATES: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

const fav = computed(() => (player.current ? isFavorite(player.current) : false));
const modeIcon = computed(() => MODE_ICON[player.mode] || 'list');
const modeLabel = computed(() => MODE_LABEL[player.mode] || '顺序播放');
const progressPct = computed(() => pct(player.progress, player.duration));

function onScrub(e: MouseEvent): void {
  const track = e.currentTarget;
  if (!(track instanceof HTMLElement)) return;
  const r = track.getBoundingClientRect();
  seekTo(((e.clientX - r.left) / r.width) * (player.duration || 0));
}
function onScrubKeydown(e: KeyboardEvent): void {
  const duration = Math.max(0, player.duration);
  let target: number;
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      target = player.progress - 5;
      break;
    case 'ArrowRight':
    case 'ArrowUp':
      target = player.progress + 5;
      break;
    case 'PageDown':
      target = player.progress - Math.max(1, duration * 0.1);
      break;
    case 'PageUp':
      target = player.progress + Math.max(1, duration * 0.1);
      break;
    case 'Home':
      target = 0;
      break;
    case 'End':
      target = duration;
      break;
    default:
      return;
  }
  e.preventDefault();
  seekTo(Math.max(0, Math.min(duration, target)));
}
function onVolume(e: Event): void {
  if (e.target instanceof HTMLInputElement) setVolume(Number(e.target.value) / 100);
}
function onRate(e: Event): void {
  if (e.target instanceof HTMLSelectElement) setRate(e.target.value);
}
function onQuality(e: Event): void {
  if (e.target instanceof HTMLSelectElement) setQuality(e.target.value);
}
function openNow(): void {
  player.fullscreen = true;
}
function openQueue(): void {
  player.queueOpen = true;
}
function openDesktopLyric(): void {
  callSafe('openDesktopLyric', [], null);
}
function openMini(): void {
  callSafe('openMiniPlayer', [], null);
}
function onHeart(): void {
  if (player.current) toggleFavorite(player.current);
}
</script>

<template>
  <footer class="pb ly-glass">
    <div class="left">
      <button class="thumb" :class="{ live: player.playing, ph: !player.current?.cover }" :title="player.current ? '打开播放页' : ''" @click="openNow">
        <img v-if="player.current?.cover" :src="player.current.cover" alt="" />
        <Icon v-else name="disc" :size="18" />
      </button>
      <div class="tx">
        <div class="t" :title="player.current?.title">{{ player.current ? player.current.title : '未在播放' }}</div>
        <div class="a" :title="player.current ? `${player.current.artist} · ${platformName(player.current.source)}` : ''">
          {{ player.current ? `${player.current.artist || '未知歌手'} · ${platformName(player.current.source)}` : '从列表点一首开始' }}
        </div>
      </div>
      <button
        class="ly-icon-btn heart" :class="{ on: fav }"
        :title="fav ? '取消收藏' : '收藏'" :aria-label="fav ? '取消收藏' : '收藏'"
        :disabled="!player.current" @click="onHeart"
      >
        <Icon name="heart" :size="16" />
      </button>
    </div>

    <div class="center">
      <div class="ctl">
        <button class="ly-icon-btn" :title="modeLabel" :aria-label="modeLabel" @click="cycleMode">
          <Icon :name="modeIcon" :size="15" />
        </button>
        <button class="ly-icon-btn" title="上一首" aria-label="上一首" @click="prev">
          <Icon name="prev" :size="14" />
        </button>
        <button class="pp" :aria-label="player.playing ? '暂停' : '播放'" @click="togglePlay">
          <Icon :name="player.playing ? 'pause' : 'play'" :size="16" />
        </button>
        <button class="ly-icon-btn" title="下一首" aria-label="下一首" @click="next()">
          <Icon name="next" :size="14" />
        </button>
        <button class="ly-icon-btn" title="播放队列" aria-label="播放队列" @click="openQueue">
          <Icon name="queue" :size="15" />
          <span v-if="player.queue.length" class="qbadge">{{ player.queue.length }}</span>
        </button>
      </div>

      <div class="scrub">
        <span class="time">{{ fmtDuration(player.progress) }}</span>
        <div
          class="track" role="slider" aria-label="播放进度" tabindex="0"
          :aria-valuenow="Math.min(Math.round(player.progress), Math.round(player.duration))"
          aria-valuemin="0" :aria-valuemax="Math.round(player.duration)"
          :aria-valuetext="`${fmtDuration(player.progress)} / ${fmtDuration(player.duration)}`"
          :aria-disabled="player.duration <= 0"
          @click="onScrub" @keydown="onScrubKeydown"
        >
          <i :style="{ width: progressPct + '%' }"><b></b></i>
        </div>
        <span class="time">{{ fmtDuration(player.duration) }}</span>
      </div>

      <div v-if="player.error" class="err" :title="String(player.error)">{{ player.error }}</div>
    </div>

    <div class="right">
      <select class="mini-select quality" :value="player.quality" title="音质" aria-label="音质" @change="onQuality">
        <option value="standard">128K</option>
        <option value="hq">320K</option>
        <option value="lossless">FLAC</option>
      </select>

      <select class="mini-select rate" :value="player.rate" title="倍速" aria-label="播放速度" @change="onRate">
        <option v-for="r in RATES" :key="r" :value="r">{{ r }}x</option>
      </select>

      <div class="vol">
        <Icon :name="player.volume === 0 ? 'volumeMute' : 'volume'" :size="15" />
        <input type="range" min="0" max="100" :value="Math.round(player.volume * 100)" aria-label="音量" @input="onVolume" />
      </div>

      <button class="ly-icon-btn" title="歌词" aria-label="歌词" @click="openNow">
        <Icon name="quote" :size="15" />
      </button>
      <button class="ly-icon-btn" title="桌面歌词" aria-label="桌面歌词" @click="openDesktopLyric">
        <Icon name="layers" :size="15" />
      </button>
      <button class="ly-icon-btn" title="迷你播放器" aria-label="迷你播放器" @click="openMini">
        <Icon name="external" :size="15" />
      </button>
      <span v-if="lyrics.items.length" class="ly-tag lyric-ok">LRC</span>
    </div>
  </footer>
</template>

<style scoped>
.pb {
  flex-shrink: 0; height: var(--player-h);
  display: grid; grid-template-columns: minmax(210px, 1fr) minmax(360px, 2fr) minmax(260px, 1fr);
  align-items: center; gap: var(--sp-4);
  padding: 0 var(--sp-5);
  z-index: var(--z-player);
}

.left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.thumb {
  width: 46px; height: 46px; flex-shrink: 0; border: 0; border-radius: 13px;
  overflow: hidden; background: var(--au-grad-3); color: #fff;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; box-shadow: var(--glow-accent);
}
.thumb.ph { background: linear-gradient(135deg, var(--glass-2), var(--accent-soft)); color: var(--ink-3); box-shadow: none; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb.live img { animation: spin 12s linear infinite; border-radius: 50%; }
@keyframes spin { to { transform: rotate(360deg); } }
.tx { min-width: 0; flex: 1; }
.t { font-size: var(--fs-sm); font-weight: var(--fw-bold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.a { margin-top: 2px; font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.heart:disabled { opacity: .4; }
.heart.on { color: var(--au-3); }

.center { display: flex; flex-direction: column; align-items: center; gap: 5px; min-width: 0; }
.ctl { display: flex; align-items: center; gap: 6px; }
.pp {
  width: 38px; height: 38px; flex-shrink: 0; border: 0; border-radius: 50%;
  background: var(--au-grad); color: #fff; box-shadow: var(--glow-accent);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; transition: transform var(--dur-1) var(--ease);
}
.pp:hover { transform: scale(1.06); }
.pp:active { transform: scale(.95); }
.qbadge {
  position: absolute; top: 2px; right: 0;
  min-width: 14px; height: 14px; padding: 0 3px;
  border-radius: var(--r-full); background: var(--accent-soft); color: var(--au-1);
  font-size: 9px; line-height: 14px; font-weight: var(--fw-bold);
}
.ly-icon-btn { position: relative; }

.scrub { display: flex; align-items: center; gap: 10px; width: 100%; max-width: 560px; }
.time { width: 38px; flex-shrink: 0; text-align: center; font-size: var(--fs-2xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.track { flex: 1; height: 14px; display: flex; align-items: center; cursor: pointer; }
.track:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 3px; border-radius: var(--r-full); }
.track > i {
  position: relative; display: block; width: 0; height: 4px; border-radius: var(--r-full);
  background: var(--au-grad); transition: width .12s linear;
}
.track > i b {
  position: absolute; right: -4px; top: 50%; transform: translateY(-50%);
  width: 10px; height: 10px; border-radius: 50%; background: #fff;
  box-shadow: 0 1px 6px rgba(124, 92, 255, .35);
  opacity: 0; transition: opacity var(--dur-1);
}
.track:hover > i b { opacity: 1; }
.track::before {
  content: ""; position: absolute; height: 4px; border-radius: var(--r-full);
  background: var(--hairline-2);
}
.err { font-size: var(--fs-2xs); color: var(--danger); max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.right { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }
.mini-select {
  height: 26px; padding: 0 6px; border: 1px solid var(--hairline); border-radius: var(--r-sm);
  background: var(--glass-3); color: var(--ink-2); font-size: var(--fs-2xs);
  cursor: pointer;
}
.quality { width: 62px; }
.rate { width: 58px; }
.vol { display: flex; align-items: center; gap: 6px; color: var(--ink-3); }
.vol input { width: 64px; height: 4px; accent-color: var(--au-1); cursor: pointer; }
.lyric-ok { flex-shrink: 0; }

@media (max-width: 1080px) {
  .pb { grid-template-columns: minmax(180px, 1fr) minmax(300px, 1.6fr) auto; }
  .vol input { display: none; }
  .mini-select.rate { display: none; }
}
</style>