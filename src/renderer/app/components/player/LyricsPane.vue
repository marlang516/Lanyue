<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { lyrics, setOffset } from '../../stores/lyrics';
import { player, seekTo } from '../../stores/player';
import type { LyricLine } from '../../stores/types';
import {
  lineClasses,
  projectPlayhead,
  resolveLyricFrame,
} from '../../core/lyricMotion.js';
import Icon from '../common/Icon.vue';

const wrap = ref<HTMLElement | null>(null);
const lineEls = ref<(HTMLElement | null)[]>([]);
const visualSnap = ref(false);

const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = ref(motionMq.matches);

type LyricFrame = ReturnType<typeof resolveLyricFrame>;
type PlayAnchor = { progress: number; at: number; rate: number };
type LyricCursor = { index: number; role: LyricFrame['role']; at: number };

const bootNow = performance.now();
let anchor: PlayAnchor | null = projectPlayhead(
  null, player.progress, bootNow, Number(player.rate) || 1, !!player.playing,
).anchor;
let cursor: LyricCursor | null = null;
const frame = ref<LyricFrame>(resolveLyricFrame(
  lyrics.items,
  anchor.progress + (Number(lyrics.offsetMs) || 0) / 1000,
  null,
  bootNow,
  frameOpts(),
));
cursor = { index: frame.value.index, role: frame.value.role, at: bootNow };

let raf = 0;
let snapGen = 0;
let alive = true;
let ro: ResizeObserver | null = null;

function frameOpts(): { duration?: number; reducedMotion?: boolean } {
  return {
    duration: player.duration > 0 ? player.duration : undefined,
    reducedMotion: reduced.value,
  };
}

function onMotionMq(e: MediaQueryListEvent): void {
  reduced.value = e.matches;
}

/** 模板 ref 回调：只收真实 DOM 元素，组件实例/空值按未挂载处理 */
function setLineEl(el: Element | ComponentPublicInstance | null, i: number): void {
  lineEls.value[i] = el instanceof HTMLElement ? el : null;
}

function classesFor(i: number): ReturnType<typeof lineClasses> {
  return lineClasses(i, frame.value);
}

function currentAttr(i: number): 'true' | undefined {
  const c = classesFor(i);
  return c.on || c.rest ? 'true' : undefined;
}

function armSnap(): void {
  visualSnap.value = true;
  const gen = ++snapGen;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (alive && gen === snapGen) visualSnap.value = false;
    });
  });
}

/**
 * 上下留白至少半个滚动盒，第一句和最后一句才滚得到视觉中心。
 * 26vh 跟的是窗口而不是歌词列，列比窗口矮时会差半行，而且 scrollTop 不能为负。
 */
function ensureCenterPad(box: HTMLElement): void {
  const need = Math.round(box.clientHeight / 2);
  if (need < 40) return;
  const top = Number.parseFloat(box.style.paddingTop);
  if (Number.isFinite(top) && Math.abs(top - need) < 1) return;
  box.style.paddingTop = `${need}px`;
  box.style.paddingBottom = `${need}px`;
}

function scrollToNow(index: number, behavior: ScrollBehavior): void {
  const box = wrap.value;
  if (!box) return;
  ensureCenterPad(box);
  if (index < 0) {
    if (box.scrollTop === 0) return;
    if (behavior === 'auto') box.scrollTop = 0;
    else box.scrollTo({ top: 0, behavior });
    return;
  }
  const el = lineEls.value[index];
  if (!el) return;
  // offsetTop 的参照是最近的定位祖先（全屏根是 fixed），不是歌词滚动盒。
  // 用视口差值滚动，缩放后的视觉中心才对准盒子中心，窗口变高时也能拉回来。
  const boxRect = box.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const delta = (elRect.top + elRect.height / 2) - (boxRect.top + boxRect.height / 2);
  if (Math.abs(delta) < 2) return;
  if (behavior === 'auto') box.scrollTop += delta;
  else box.scrollBy({ top: delta, behavior: 'smooth' });
}

function commit(next: LyricFrame, now: number): void {
  const indexMoved = !cursor || cursor.index !== next.index;
  if (next.motion === 'snap') armSnap();
  cursor = {
    index: next.index,
    role: next.role,
    at: indexMoved ? now : (cursor ? cursor.at : now),
  };
  frame.value = next;
  if (next.scroll === 'hold') return;
  void nextTick(() => scrollToNow(next.index, next.scroll === 'smooth' ? 'smooth' : 'auto'));
}

/**
 * retarget：换歌 / 歌词数组换新，当作第一次观察，直接落在当前句，
 * 不把上一首的行号当成「相邻一句」去播交接。
 */
function publish(now: number, retarget: boolean): void {
  const projected = projectPlayhead(
    anchor, player.progress, now, Number(player.rate) || 1, !!player.playing,
  );
  anchor = projected.anchor;
  const seconds = projected.seconds + (Number(lyrics.offsetMs) || 0) / 1000;
  const next = resolveLyricFrame(lyrics.items, seconds, retarget ? null : cursor, now, frameOpts());
  if (!retarget && cursor && cursor.index === next.index && cursor.role === next.role) return;
  commit(next, now);
}

function loop(now: number): void {
  if (!alive) return;
  if (document.visibilityState !== 'hidden') publish(now, false);
  raf = requestAnimationFrame(loop);
}

watch(wrap, (el, prev) => {
  if (!ro) return;
  if (prev) ro.unobserve(prev);
  if (!el) return;
  ro.observe(el);
  void nextTick(() => {
    if (frame.value.index >= 0) scrollToNow(frame.value.index, 'auto');
  });
});

watch(
  [() => lyrics.loadedKey, () => lyrics.items],
  () => {
    cursor = null;
    anchor = null;
    lineEls.value = [];
    publish(performance.now(), true);
  },
);

function jump(line: LyricLine): void {
  seekTo(Math.max(0, line.t - lyrics.offsetMs / 1000));
}

function nudge(ms: number): void {
  setOffset(lyrics.offsetMs + ms);
}

const offsetLabel = ref('');
watch(
  () => lyrics.offsetMs,
  (ms) => {
    const s = ms / 1000;
    offsetLabel.value = `${s > 0 ? '+' : ''}${s.toFixed(1)}s`;
  },
  { immediate: true },
);

onMounted(() => {
  motionMq.addEventListener('change', onMotionMq);
  ro = new ResizeObserver(() => {
    if (frame.value.index < 0) return;
    scrollToNow(frame.value.index, 'auto');
  });
  if (wrap.value) ro.observe(wrap.value);
  void nextTick(() => {
    if (frame.value.index >= 0) scrollToNow(frame.value.index, 'auto');
  });
  raf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  alive = false;
  cancelAnimationFrame(raf);
  ro?.disconnect();
  ro = null;
  motionMq.removeEventListener('change', onMotionMq);
});
</script>

<template>
  <div class="lp">
    <div class="lp-head">
      <span class="ttl">歌词</span>
      <div class="offset" v-if="lyrics.items.length">
        <button class="ly-icon-btn" title="歌词提前 0.5 秒" aria-label="歌词提前 0.5 秒" @click="nudge(500)">
          <Icon name="chevron-left" :size="12" />
        </button>
        <span class="val" :title="'点击行跳转；偏移 ' + offsetLabel">{{ offsetLabel }}</span>
        <button class="ly-icon-btn" title="歌词延后 0.5 秒" aria-label="歌词延后 0.5 秒" @click="nudge(-500)">
          <Icon name="chevron-right" :size="12" />
        </button>
      </div>
    </div>

    <div v-if="lyrics.loading" class="state">
      <div class="ly-skeleton" style="height: 18px; width: 60%"></div>
      <div class="ly-skeleton" style="height: 18px; width: 74%"></div>
      <div class="ly-skeleton" style="height: 18px; width: 52%"></div>
    </div>

    <div v-else-if="lyrics.error" class="state">
      <Icon name="quote" :size="26" />
      <b>{{ lyrics.error }}</b>
      <p>{{ player.current ? '可在设置中开启在线歌词，或为本地文件放置同名 .lrc' : '还没有播放歌曲' }}</p>
    </div>

    <div v-else-if="!lyrics.items.length" class="state">
      <Icon name="quote" :size="26" />
      <b>暂无歌词</b>
      <p>播放一首歌后自动加载</p>
    </div>

    <div
      v-else
      ref="wrap"
      class="lines"
      :class="{ snap: visualSnap }"
      :data-lyric-role="frame.role"
      :data-lyric-motion="frame.motion"
    >
      <button
        v-for="(l, i) in lyrics.items"
        :key="lyrics.loadedKey + ':' + i + ':' + l.t"
        :ref="(el) => setLineEl(el, i)"
        type="button"
        class="line"
        :class="classesFor(i)"
        :aria-current="currentAttr(i)"
        @click="jump(l)"
      >
        {{ l.text }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.lp { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.lp-head { display: flex; align-items: center; justify-content: space-between; padding: 0 var(--sp-2) var(--sp-2); }
.ttl { font-size: var(--fs-2xs); letter-spacing: .22em; color: var(--ink-3); font-weight: var(--fw-bold); }
.offset { display: flex; align-items: center; gap: 2px; }
.offset .ly-icon-btn { width: 24px; height: 24px; }
.val { width: 46px; text-align: center; font-size: var(--fs-2xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }

.state {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--sp-2); color: var(--ink-3); text-align: center;
}
.state b { font-size: var(--fs-sm); color: var(--ink-2); font-weight: var(--fw-med); }
.state p { font-size: var(--fs-xs); max-width: 34ch; line-height: 1.6; }
.state .ly-skeleton { border-radius: var(--r-sm); }

.lines {
  position: relative;
  flex: 1; min-height: 0;
  overflow-x: clip; overflow-y: auto; scrollbar-width: thin;
  /* 右侧多留一截：当前行从左缘放大 4%，不能把末字裁掉，也不能挤出横向滚动。 */
  padding: 26vh max(var(--sp-8), 6%) 30vh var(--sp-4);
  display: flex; flex-direction: column; gap: 4px;
  overflow-anchor: none;
  -webkit-mask-image: linear-gradient(180deg, transparent, black 12%, black 88%, transparent);
  mask-image: linear-gradient(180deg, transparent, black 12%, black 88%, transparent);
}
/* 静止变换写死，入场关键帧 0% 必须与它相同，避免换行时先跳再升起。 */
.line {
  position: relative;
  border: 0; background: transparent; text-align: left; cursor: pointer;
  padding: 7px var(--sp-3); border-radius: var(--r-md);
  font-size: var(--fs-lg); font-weight: var(--fw-med); line-height: 1.5;
  color: var(--ink-3);
  opacity: .8;
  transform: translate3d(0, 0, 0) scale(1);
  transform-origin: left center;
  transition:
    color var(--dur-2) var(--ease),
    opacity var(--dur-2) var(--ease),
    transform var(--dur-2) var(--ease-emph);
}
/* 光带单独淡入淡出，换行是交叉而不是背景色硬切。不占布局。 */
.line::before {
  content: "";
  position: absolute; inset: 0; border-radius: inherit;
  background: linear-gradient(105deg, var(--accent-soft), color-mix(in srgb, var(--au-2) 16%, transparent) 46%, transparent 76%);
  box-shadow: inset 3px 0 0 var(--au-1);
  opacity: 0;
  transition: opacity var(--dur-2) var(--ease);
  pointer-events: none;
}
.line:hover { color: var(--ink-2); }
.line.near { color: var(--ink-2); opacity: .94; }
.line.past { color: var(--ink-2); opacity: .72; }
.line.rest {
  color: var(--ink-2);
  opacity: .86;
  transform: translate3d(0, 0, 0) scale(1.012);
}
.line.on {
  color: var(--ink);
  opacity: 1;
  transform: translate3d(0, -1px, 0) scale(1.04);
  will-change: transform, opacity;
}
.line.on::before { opacity: 1; }
.line.on:hover { color: var(--ink); }
/* 0% = .line 静止姿态。只在相邻换行时加，seek / 连唱走 .snap 取消。 */
.line.on.handoff {
  animation: lyric-arrive var(--dur-2) var(--ease-emph);
}
@keyframes lyric-arrive {
  0% { opacity: .94; transform: translate3d(0, 0, 0) scale(1); }
  100% { opacity: 1; transform: translate3d(0, -1px, 0) scale(1.04); }
}

.lines.snap .line,
.lines.snap .line.on,
.lines.snap .line.on.handoff,
.lines.snap .line::before {
  animation: none;
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .line,
  .line.on,
  .line.on.handoff,
  .line::before {
    animation: none;
    transition: none;
  }
}
</style>
