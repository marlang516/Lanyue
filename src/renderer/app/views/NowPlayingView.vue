<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  player, togglePlay, next, prev, seekTo, setVolume, cycleMode,
} from '../stores/player';
import { useModalAccessibility } from '../composables/useModalAccessibility';
import { fmtDuration, pct } from '../core/format';
import { downloadSongs } from '../stores/search';
import { toast } from '../core/toast';
import LyricsPane from '../components/player/LyricsPane.vue';
import Icon from '../components/common/Icon.vue';

const progressPct = computed(() => pct(player.progress, player.duration));
const nowEl = ref<HTMLElement | null>(null);

useModalAccessibility(() => player.fullscreen, nowEl, close);

function close() {
  player.fullscreen = false;
}
function onRootClick(e: MouseEvent) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  // 只在点到背景遮罩层时收起；点歌词/控制条不触发，避免误关
  if (t.classList.contains('now') || t.classList.contains('bg') || t.classList.contains('veil')) {
    close();
  }
}
function onScrub(e: MouseEvent) {
  const el = e.currentTarget;
  if (!(el instanceof HTMLElement)) return;
  const r = el.getBoundingClientRect();
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
function onVolume(e: Event) {
  const el = e.target;
  if (el instanceof HTMLInputElement) setVolume(Number(el.value) / 100);
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
      <div
        v-if="player.fullscreen" ref="nowEl" class="now" role="dialog" aria-modal="true"
        aria-label="正在播放" tabindex="-1" @click="onRootClick"
      >
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
          <p class="hero-err" v-if="player.error">{{ player.error }}</p>
          <section class="ly">
            <LyricsPane />
          </section>
        </main>

        <footer class="ctr ly-card">
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
  position: absolute; inset: -12%;
  background-size: cover; background-position: center;
  filter: blur(46px) saturate(165%);
  opacity: .82;
  animation: cover-drift 46s var(--ease) infinite alternate;
}
@keyframes cover-drift {
  from { transform: scale(1.12) translate3d(-1.6%, -1%, 0); }
  to { transform: scale(1.22) translate3d(1.8%, 1.4%, 0); }
}
.veil {
  position: absolute; inset: 0;
  background:
    radial-gradient(44% 50% at 18% 20%, var(--blob-1), transparent 72%),
    radial-gradient(40% 46% at 82% 16%, var(--blob-2), transparent 72%),
    linear-gradient(180deg, rgba(242, 244, 249, .18), rgba(242, 244, 249, .4));
}
[data-theme="dark"] .veil {
  background:
    radial-gradient(44% 50% at 18% 20%, var(--blob-1), transparent 72%),
    radial-gradient(40% 46% at 82% 16%, var(--blob-2), transparent 72%),
    linear-gradient(180deg, rgba(13, 16, 32, .16), rgba(13, 16, 32, .42));
}
@media (prefers-reduced-motion: reduce) {
  .bg { animation: none; transform: scale(1.12); }
}

.hd {
  position: relative; z-index: 1;
  display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-6);
}
.hd-title { flex: 1; font-size: var(--fs-xs); letter-spacing: .26em; color: var(--ink-3); font-weight: var(--fw-bold); }

.stage {
  position: relative; z-index: 1;
  flex: 1; min-height: 0; width: 100%;
  display: flex; flex-direction: column;
}
.hero-err { font-size: var(--fs-xs); color: var(--danger); text-align: center; padding: 0 var(--sp-4); }
.ly { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; overflow: hidden; }

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
.track:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 3px; border-radius: var(--r-full); }
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
</style>