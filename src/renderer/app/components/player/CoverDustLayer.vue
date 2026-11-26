<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { player } from '../../stores/player';
import { lyrics } from '../../stores/lyrics';
import { activeLineIndex, lyricDisplaySeconds } from '../../core/lyricMotion.js';
import {
  coverDustPlan,
  coverRhythm,
  createCoverDust,
  paintCoverDust,
  shouldPaintCoverDust,
  stepCoverDust,
} from '../../core/coverParticles.js';

const props = defineProps<{
  surface: 'main' | 'fullscreen';
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = ref(motionMq.matches);

let field = createCoverDust(0, props.surface === 'fullscreen' ? 5 : 3);
let raf = 0;
let wait = 0;
let last = -1;
let alive = true;
let accent = 0;
let lastLine = -2;

function onMotion(e: MediaQueryListEvent): void {
  reduced.value = e.matches;
}

function planNow() {
  return coverDustPlan({
    enabled: player.coverParticles,
    projecting: player.desktopStage,
    surface: props.surface,
    reducedMotion: reduced.value,
  });
}

function rhythmNow(): number {
  const seconds = Number(player.progress) || 0;
  const idx = lyrics.items.length
    ? activeLineIndex(lyrics.items, lyricDisplaySeconds(seconds, lyrics.offsetMs))
    : -1;
  if (idx !== lastLine) {
    lastLine = idx;
    accent = player.playing ? 1 : 0;
  } else {
    accent *= 0.9;
  }
  return coverRhythm({
    playing: !!player.playing,
    seconds,
    accent,
  });
}

function draw(rhythm: number): void {
  const el = canvas.value;
  if (!el) return;
  const cssW = el.clientWidth;
  const cssH = el.clientHeight;
  if (cssW < 2 || cssH < 2) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.floor(cssW * dpr);
  const h = Math.floor(cssH * dpr);
  if (el.width !== w) el.width = w;
  if (el.height !== h) el.height = h;
  const ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintCoverDust(ctx, field, cssW, cssH, rhythm);
}

function loop(now: number): void {
  if (!alive) return;
  const plan = planNow();
  if (plan.visible) {
    if (field.motes.length !== plan.count) {
      field = createCoverDust(plan.count, props.surface === 'fullscreen' ? 5 : 3);
    }
    if (shouldPaintCoverDust(last, now, plan)) {
      const dt = last < 0 ? plan.frameMs : now - last;
      last = now;
      const rhythm = rhythmNow();
      stepCoverDust(field, now, rhythm, dt, plan.animate);
      draw(rhythm);
    }
  }
  if (plan.tier === 'cheap') {
    wait = window.setTimeout(() => {
      wait = 0;
      if (alive) raf = requestAnimationFrame(loop);
    }, plan.frameMs || 200);
    return;
  }
  raf = requestAnimationFrame(loop);
}

onMounted(() => {
  motionMq.addEventListener('change', onMotion);
  raf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  alive = false;
  cancelAnimationFrame(raf);
  window.clearTimeout(wait);
  motionMq.removeEventListener('change', onMotion);
});
</script>

<template>
  <canvas
    ref="canvas"
    class="cover-dust"
    data-cover-dust=""
    aria-hidden="true"
  />
</template>

<style scoped>
.cover-dust {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
}
</style>
