<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { lyrics, setOffset } from '../../stores/lyrics';
import { player, seekTo } from '../../stores/player';
import Icon from '../common/Icon.vue';
import {
  displayWords,
  glowFromCoverPixels,
  lineFitScale,
  lyricDisplaySeconds,
  lyricPlaySeconds,
  projectPlayhead,
  resolveLyricFrame,
  resolveWordSweep,
} from '../../core/lyricMotion.js';

const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = ref(motionMq.matches);
const visualSnap = ref(false);

type LyricFrame = ReturnType<typeof resolveLyricFrame>;
type WordFrame = ReturnType<typeof resolveWordSweep>;
type PlayAnchor = { progress: number; at: number; rate: number };
type LyricCursor = { index: number; role: LyricFrame['role']; at: number };
type ShownWord = { t: number; dur: number; text: string };
type WordLook = 'unreached' | 'active' | 'linger' | 'sung';

const bootNow = performance.now();
let anchor: PlayAnchor | null = projectPlayhead(
  null, player.progress, bootNow, Number(player.rate) || 1, !!player.playing,
).anchor;
let cursor: LyricCursor | null = null;
const frame = ref<LyricFrame>(resolveLyricFrame(
  lyrics.items,
  lyricDisplaySeconds(anchor.progress, lyrics.offsetMs),
  null,
  bootNow,
  frameOpts(),
));
cursor = { index: frame.value.index, role: frame.value.role, at: bootNow };

const shownWords = ref<readonly ShownWord[]>([]);
const wordFrame = ref<WordFrame>({
  index: -1, states: [], sweep: [], band: [], bloom: [], linger: [],
});
const sweepAt = ref<number[]>([]);
const bandAt = ref<number[]>([]);
const bloomAt = ref<number[]>([]);
const lookAt = ref<WordLook[]>([]);
const prevText = ref('');
const nextText = ref('');
const prevKey = ref('p-none');
const nextKey = ref('n-none');
const glowVars = ref<Record<string, string>>({});
const stageEl = ref<HTMLElement | null>(null);
const nowBand = ref<HTMLElement | null>(null);
const lineEl = ref<HTMLElement | null>(null);
let wordsSig = '';

let raf = 0;
let snapGen = 0;
let coverGen = 0;
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

function armSnap(): void {
  visualSnap.value = true;
  const gen = ++snapGen;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (alive && gen === snapGen) visualSnap.value = false;
    });
  });
}

function sameStates(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameNums(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function quant(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 上一句、下一句只作参照，不参与光带。前奏没有上一句，间奏的当前槽留空。 */
function paintContext(lyricFrame: LyricFrame): void {
  const items = lyrics.items;
  let prev = '';
  let next = '';
  if (lyricFrame.role === 'active' && lyricFrame.index >= 0) {
    prev = items[lyricFrame.index - 1]?.text || '';
    next = items[lyricFrame.index + 1]?.text || '';
  } else if (lyricFrame.role === 'rest' && lyricFrame.index >= 0) {
    prev = items[lyricFrame.index]?.text || '';
    next = items[lyricFrame.index + 1]?.text || '';
  } else if (lyricFrame.role === 'prelude') {
    next = items[0]?.text || '';
  }
  const pk = lyricFrame.role === 'active' && lyricFrame.index > 0
    ? `p${lyricFrame.index - 1}`
    : lyricFrame.role === 'rest' && lyricFrame.index >= 0
      ? `p${lyricFrame.index}`
      : 'p-none';
  const nk = lyricFrame.role === 'prelude'
    ? 'n0'
    : (lyricFrame.role === 'active' || lyricFrame.role === 'rest') && lyricFrame.index >= 0
      ? `n${lyricFrame.index + 1}`
      : 'n-none';
  if (prevText.value !== prev) prevText.value = prev;
  if (nextText.value !== next) nextText.value = next;
  if (prevKey.value !== pk) prevKey.value = pk;
  if (nextKey.value !== nk) nextKey.value = nk;
}

function clearWords(): void {
  if (!shownWords.value.length && !lookAt.value.length) return;
  shownWords.value = [];
  wordFrame.value = { index: -1, states: [], sweep: [], band: [], bloom: [], linger: [] };
  sweepAt.value = [];
  bandAt.value = [];
  bloomAt.value = [];
  lookAt.value = [];
  wordsSig = '';
}

/**
 * 只在活动句上铺光带。位置来自 resolveWordSweep，和行时钟是同一播放秒。
 * 减弱动效时当前字直接全亮，不让光带走动。
 */
function paintWords(seconds: number, lyricFrame: LyricFrame): void {
  paintContext(lyricFrame);
  if (lyricFrame.role !== 'active' || lyricFrame.index < 0) {
    clearWords();
    return;
  }
  const line = lyrics.items[lyricFrame.index];
  const nextLine = lyrics.items[lyricFrame.index + 1];
  const words = displayWords(line, nextLine, player.duration > 0 ? player.duration : undefined);
  const sig = words.map((w) => `${w.t}|${w.dur}|${w.text}`).join('\n');
  const lineChanged = sig !== wordsSig;
  if (lineChanged) {
    wordsSig = sig;
    shownWords.value = words;
  }
  const glow = resolveWordSweep(words, seconds);
  const sweep: number[] = [];
  const band: number[] = [];
  const bloom: number[] = [];
  const look: WordLook[] = [];
  for (let i = 0; i < glow.states.length; i++) {
    const state = glow.states[i];
    let s = quant(glow.sweep[i] || 0);
    let b = quant(glow.band[i] || 0);
    let m = quant(glow.bloom[i] || 0);
    let face: WordLook = state === 'active' && glow.linger[i] ? 'linger' : state;
    if (state === 'active' && s <= 0 && m <= 0) face = 'unreached';
    if (reduced.value && (state === 'active' || state === 'sung')) {
      s = 1;
      b = 0;
      if (state === 'active') m = Math.max(m, 0.7);
      face = state === 'active' ? 'linger' : 'sung';
    }
    sweep.push(s);
    band.push(b);
    bloom.push(m);
    look.push(face);
  }
  if (
    !lineChanged
    && sameStates(wordFrame.value.states, glow.states)
    && sameNums(sweepAt.value, sweep)
    && sameNums(bandAt.value, band)
    && sameNums(bloomAt.value, bloom)
    && sameStates(lookAt.value, look)
  ) return;
  wordFrame.value = glow;
  sweepAt.value = sweep;
  bandAt.value = band;
  bloomAt.value = bloom;
  lookAt.value = look;
}

function wordStyle(i: number): Record<string, string> {
  return {
    '--lyric-sweep': String(sweepAt.value[i] ?? 0),
    '--lyric-band': String(bandAt.value[i] ?? 0),
    '--lyric-bloom': String(bloomAt.value[i] ?? 0),
  };
}

/** 字号只用来把整句收进一行，不改字重。 */
function fitLine(): void {
  const line = lineEl.value;
  const band = nowBand.value;
  if (!line || !band) return;
  line.style.fontSize = '';
  const box = window.getComputedStyle(band);
  const pad = (Number.parseFloat(box.paddingLeft) || 0) + (Number.parseFloat(box.paddingRight) || 0);
  const scale = lineFitScale(line.scrollWidth, band.clientWidth - pad);
  if (scale < 1) {
    const px = Number.parseFloat(window.getComputedStyle(line).fontSize);
    if (px > 0) line.style.fontSize = `${(px * scale).toFixed(2)}px`;
  }
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
}

/**
 * retarget：换歌 / 歌词数组换新，当作第一次观察，直接落在当前句。
 */
function publish(now: number, retarget: boolean): void {
  const projected = projectPlayhead(
    anchor, player.progress, now, Number(player.rate) || 1, !!player.playing,
  );
  anchor = projected.anchor;
  // 行号用带提前量的秒，逐字用同一播放秒再由 WORD_LEAD 提前，两处不要叠两次。
  const playSeconds = lyricPlaySeconds(projected.seconds, lyrics.offsetMs);
  const displaySeconds = lyricDisplaySeconds(projected.seconds, lyrics.offsetMs);
  if (projected.seeked) armSnap();
  const next = resolveLyricFrame(lyrics.items, displaySeconds, retarget ? null : cursor, now, frameOpts());
  const held = !retarget && !!cursor && cursor.index === next.index && cursor.role === next.role;
  if (!held) commit(next, now);
  paintWords(playSeconds, held ? frame.value : next);
}

function loop(now: number): void {
  if (!alive) return;
  if (document.visibilityState !== 'hidden') publish(now, false);
  raf = requestAnimationFrame(loop);
}

watch(
  [() => lyrics.loadedKey, () => lyrics.items],
  () => {
    cursor = null;
    anchor = null;
    wordsSig = '';
    publish(performance.now(), true);
  },
);

watch(shownWords, () => {
  nextTick(() => fitLine());
});

watch(nowBand, (el, prev) => {
  if (!ro) ro = new ResizeObserver(() => fitLine());
  if (prev) ro.unobserve(prev);
  if (el) ro.observe(el);
  fitLine();
});

function sampleCover(src: string): void {
  const gen = ++coverGen;
  if (!src) {
    glowVars.value = {};
    return;
  }
  glowVars.value = {};
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (!alive || gen !== coverGen) return;
    try {
      const canvas = document.createElement('canvas');
      const side = 12;
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, side, side);
      const color = glowFromCoverPixels(ctx.getImageData(0, 0, side, side).data);
      if (!alive || gen !== coverGen) return;
      glowVars.value = color ? { '--lyric-glow': color, '--lyric-hot': color } : {};
    } catch {
      if (alive && gen === coverGen) glowVars.value = {};
    }
  };
  img.onerror = () => {
    if (alive && gen === coverGen) glowVars.value = {};
  };
  img.src = src;
}

watch(() => player.current?.cover || '', (src) => { sampleCover(src); }, { immediate: true });

function seekWord(word: ShownWord): void {
  seekTo(Math.max(0, word.t - (Number(lyrics.offsetMs) || 0) / 1000));
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
  publish(performance.now(), true);
  raf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  alive = false;
  coverGen += 1;
  cancelAnimationFrame(raf);
  if (ro) ro.disconnect();
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
        <span class="val" :title="'点击字跳到该字；偏移 ' + offsetLabel">{{ offsetLabel }}</span>
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
      ref="stageEl"
      class="stage"
      :class="{ snap: visualSnap || reduced }"
      :style="glowVars"
      :data-lyric-role="frame.role"
      :data-lyric-motion="frame.motion"
    >
      <div class="band">
        <Transition name="lift">
          <p :key="prevKey" class="context" :class="{ on: !!prevText }" aria-hidden="true">{{ prevText }}</p>
        </Transition>
      </div>
      <div ref="nowBand" class="band now">
        <Transition name="lift">
          <p v-if="frame.role === 'active' && shownWords.length" :key="'l' + frame.index" ref="lineEl" class="line" aria-live="polite">
            <button
              v-for="(w, i) in shownWords"
              :key="lyrics.loadedKey + ':' + frame.index + ':' + i"
              type="button"
              class="word"
              :class="lookAt[i] || 'unreached'"
              :style="wordStyle(i)"
              :aria-current="wordFrame.states[i] === 'active' ? 'true' : undefined"
              @click="seekWord(w)"
            >
              <span class="face">{{ w.text }}</span>
              <span class="pass" aria-hidden="true">{{ w.text }}</span>
              <span class="beam" aria-hidden="true">{{ w.text }}</span>
            </button>
          </p>
          <p v-else :key="frame.role" class="line slot" aria-hidden="true">
            <span v-if="frame.role === 'prelude' || frame.role === 'rest'" class="dots">
              <i></i><i></i><i></i>
            </span>
          </p>
        </Transition>
      </div>
      <div class="band">
        <Transition name="lift">
          <p :key="nextKey" class="context" :class="{ on: !!nextText }" aria-hidden="true">{{ nextText }}</p>
        </Transition>
      </div>
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

.stage {
  flex: 1; min-height: 0; width: 100%;
  display: flex; flex-direction: column; align-items: stretch; justify-content: center;
  gap: var(--sp-6);
  padding: var(--sp-4) var(--sp-6);
  overflow: hidden;
}
.band {
  align-self: stretch;
  width: auto;
  min-width: 0;
  max-width: 100%;
  min-height: 1.6em;
  display: flex;
  justify-content: center;
  overflow: hidden;
}
.band.now { min-height: 2.2em; padding: 0 28px; }
.context {
  margin: 0;
  width: 100%;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
  font-size: var(--fs-xl);
  line-height: 1.45;
  color: var(--ink-3);
  opacity: 0;
}
.context.on { opacity: .42; }
.line {
  margin: 0;
  width: max-content;
  max-width: none;
  white-space: nowrap;
  text-align: center;
  font-size: clamp(var(--fs-hero), 6.4vw, 4.75rem);
  font-weight: var(--fw-med);
  line-height: 1.35;
  color: var(--ink);
}
.line.slot {
  width: auto;
  min-height: 1.2em;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dots { display: inline-flex; align-items: center; gap: .55em; height: 1.2em; }
.dots i {
  width: .42em; height: .42em; border-radius: 50%;
  background: var(--ink-2);
  animation: dot-hop 1.05s var(--ease) infinite;
}
.dots i:nth-child(2) { animation-delay: .16s; }
.dots i:nth-child(3) { animation-delay: .32s; }
@keyframes dot-hop {
  0%, 100% { transform: translateY(0); opacity: .35; }
  50% { transform: translateY(-.42em); opacity: 1; }
}
.lift-enter-active, .lift-leave-active {
  transition: transform var(--dur-2) var(--ease-emph), opacity var(--dur-2) var(--ease);
}
.lift-leave-active { position: absolute; left: 0; right: 0; }
.lift-enter-from { transform: translateY(12%); opacity: 1; }
.lift-leave-to { transform: translateY(-28%); opacity: .35; }

.word {
  position: relative;
  border: 0;
  background: transparent;
  padding: 0;
  margin: 0;
  font: inherit;
  line-height: inherit;
  color: color-mix(in srgb, var(--ink) 82%, transparent);
  cursor: pointer;
  display: inline-block;
  white-space: nowrap;
  vertical-align: baseline;
}
.word.unreached {
  color: color-mix(in srgb, var(--ink) 82%, transparent);
}
.word.active {
  color: color-mix(in srgb, var(--ink) 82%, transparent);
}
.face,
.pass,
.beam {
  font: inherit;
  line-height: inherit;
  white-space: nowrap;
}
.pass,
.beam {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  user-select: none;
}
.pass {
  color: var(--ink);
  opacity: 0;
  clip-path: inset(0 calc((1 - var(--lyric-sweep)) * 100%) 0 0);
  text-shadow:
    0 0 calc(8px + var(--lyric-bloom) * 16px) var(--lyric-glow),
    0 0 calc(20px + var(--lyric-bloom) * 28px) color-mix(in srgb, var(--lyric-hot) 72%, transparent);
}
.beam {
  color: transparent;
  opacity: 0;
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    var(--lyric-hot) 38%,
    var(--on-accent) 50%,
    var(--lyric-hot) 62%,
    transparent 100%
  );
  background-repeat: no-repeat;
  background-size: 0.72em 100%;
  background-position: calc(var(--lyric-band) * 100%) 50%;
  -webkit-background-clip: text;
  background-clip: text;
  filter: drop-shadow(0 0 calc(5px + var(--lyric-bloom) * 20px) var(--lyric-glow));
}
.word.active .pass { opacity: 1; }
.word.active .beam { opacity: 1; }
.word.linger .pass { opacity: 1; }
.word.linger .beam {
  opacity: 1;
  background-size: 1.45em 100%;
}
.word.sung .pass { opacity: .9; }
.word.sung .beam { opacity: 0; }
.word.unreached .pass,
.word.unreached .beam { opacity: 0; }
.word.active:hover,
.word.linger:hover,
.word.sung:hover { color: var(--ink); }

.stage.snap .word,
.stage.snap .pass,
.stage.snap .beam,
.stage.snap .dots i,
.stage.snap .lift-enter-active,
.stage.snap .lift-leave-active {
  animation: none;
  transition: none;
}
.stage.snap .beam { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .word,
  .pass,
  .beam,
  .dots i,
  .lift-enter-active,
  .lift-leave-active {
    animation: none;
    transition: none;
  }
  .word .beam,
  .word.active .beam,
  .word.linger .beam { opacity: 0; }
}
</style>
