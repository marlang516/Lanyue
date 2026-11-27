<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { copySoundingFrequency, player } from '../../stores/player';
import {
  followBands,
  paintSpectrumAtmosphere,
  shapeBands,
  shouldPaintSpectrum,
  spectrumAtmospherePlan,
} from '../../core/spectrumAtmosphere.js';

const props = defineProps<{
  surface: 'main' | 'fullscreen';
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = ref(motionMq.matches);

let shown: number[] = [];
let raf = 0;
let wait = 0;
let last = -1;
let alive = true;
let cleared = true;

function onMotion(e: MediaQueryListEvent): void {
  reduced.value = e.matches;
}

function planNow() {
  return spectrumAtmospherePlan({
    enabled: player.spectrumAtmosphere,
    playing: !!player.playing,
    projecting: player.desktopStage,
    surface: props.surface,
    reducedMotion: reduced.value,
  });
}

function draw(bands: number[]): void {
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
  paintSpectrumAtmosphere(ctx, bands, cssW, cssH);
  el.hidden = false;
  el.setAttribute('data-spectrum-atmosphere', planNow().tier);
}

function clearCanvas(): void {
  const el = canvas.value;
  if (!el) return;
  const ctx = el.getContext('2d');
  if (ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.width || 0, el.height || 0);
  }
  el.hidden = true;
  el.setAttribute('data-spectrum-atmosphere', 'off');
}

function loop(now: number): void {
  if (!alive) return;
  const plan = planNow();
  if (!plan.visible) {
    if (!cleared) {
      shown = [];
      clearCanvas();
      cleared = true;
      last = -1;
    }
    wait = window.setTimeout(() => {
      wait = 0;
      if (alive) raf = requestAnimationFrame(loop);
    }, 200);
    return;
  }
  cleared = false;
  if (plan.count > 0 && shown.length !== plan.count) shown = new Array(plan.count).fill(0);
  if (shouldPaintSpectrum(last, now, plan)) {
    last = now;
    const raw = copySoundingFrequency();
    const target = raw ? shapeBands(raw, plan.count) : [];
    shown = followBands(shown, target, plan.animate ? 0.45 : 0);
    if (plan.animate) draw(shown);
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
    class="spectrum-atmosphere"
    data-spectrum-atmosphere=""
    aria-hidden="true"
  />
</template>

<style scoped>
.spectrum-atmosphere {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
}
</style>
