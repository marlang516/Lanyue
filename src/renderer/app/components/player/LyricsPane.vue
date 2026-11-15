<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { lyrics, setOffset } from '../../stores/lyrics';
import { player, seekTo } from '../../stores/player';
import Icon from '../common/Icon.vue';
import {
  displayWords,
  projectPlayhead,
  resolveLyricFrame,
  resolveWordStates,
} from '../../core/lyricMotion.js';

const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = ref(motionMq.matches);
const visualSnap = ref(false);

type LyricFrame = ReturnType<typeof resolveLyricFrame>;
type WordFrame = ReturnType<typeof resolveWordStates>;
type PlayAnchor = { progress: number; at: number; rate: number };
type LyricCursor = { index: number; role: LyricFrame['role']; at: number };
type ShownWord = { t: number; dur: number; text: string };

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

const shownWords = ref<readonly ShownWord[]>([]);
const wordFrame = ref<WordFrame>({ index: -1, states: [] });
const bounceAt = ref<boolean[]>([]);
let wordsSig = '';

let raf = 0;
let snapGen = 0;
let alive = true;

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

/**
 * 刚进入「在唱」才挂上弹入。seek / 减弱动效时不挂，已经在播的也拆掉。
 * 换句后按下标比较没有意义，整句按新词重算。
 */
function bounceFlags(states: readonly string[], prev: readonly string[], lineChanged: boolean, snap: boolean): boolean[] {
  return states.map((state, i) => {
    if (state !== 'active' || snap) return false;
    if (lineChanged || prev[i] !== 'active') return true;
    return bounceAt.value[i] === true;
  });
}

/** 只在活动句上准备词。前奏和间奏把舞台清空。 */
function paintWords(seconds: number, lyricFrame: LyricFrame): void {
  if (lyricFrame.role !== 'active' || lyricFrame.index < 0) {
    if (shownWords.value.length || bounceAt.value.length) {
      shownWords.value = [];
      wordFrame.value = { index: -1, states: [] };
      bounceAt.value = [];
      wordsSig = '';
    }
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
  const nextWords = resolveWordStates(words, seconds);
  const prev = lineChanged ? [] : wordFrame.value.states;
  const snap = visualSnap.value || reduced.value;
  const bounce = bounceFlags(nextWords.states, prev, lineChanged, snap);
  if (sameStates(prev, nextWords.states) && sameFlags(bounceAt.value, bounce)) return;
  wordFrame.value = nextWords;
  bounceAt.value = bounce;
}

function sameFlags(a: readonly boolean[], b: readonly boolean[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
  const seconds = projected.seconds + (Number(lyrics.offsetMs) || 0) / 1000;
  if (projected.seeked) armSnap();
  const next = resolveLyricFrame(lyrics.items, seconds, retarget ? null : cursor, now, frameOpts());
  const held = !retarget && !!cursor && cursor.index === next.index && cursor.role === next.role;
  if (!held) commit(next, now);
  paintWords(seconds, held ? frame.value : next);
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
  cancelAnimationFrame(raf);
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
      class="stage"
      :class="{ snap: visualSnap || reduced }"
      :data-lyric-role="frame.role"
      :data-lyric-motion="frame.motion"
    >
      <p v-if="frame.role === 'active' && shownWords.length" class="line" aria-live="polite">
        <button
          v-for="(w, i) in shownWords"
          :key="lyrics.loadedKey + ':' + frame.index + ':' + i"
          type="button"
          class="word"
          :class="[wordFrame.states[i] || 'unreached', bounceAt[i] ? 'bounce' : '']"
          :aria-current="wordFrame.states[i] === 'active' ? 'true' : undefined"
          @click="seekWord(w)"
        >{{ w.text }}</button>
      </p>
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
  flex: 1; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  padding: var(--sp-4) var(--sp-6);
  overflow: hidden;
}
.line {
  margin: 0;
  max-width: 18em;
  text-align: center;
  font-size: var(--fs-hero);
  font-weight: var(--fw-med);
  line-height: 1.45;
  color: var(--ink);
}

.word {
  border: 0;
  background: transparent;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  display: inline-block;
  transform-origin: center bottom;
  opacity: 0;
  transform: translate3d(0, 0.35em, 0) scale(0.86);
}
.word.unreached {
  opacity: 0;
  transform: translate3d(0, 0.35em, 0) scale(0.86);
}
.word.active {
  opacity: 1;
  color: var(--ink);
  transform: translate3d(0, 0, 0) scale(1);
}
.word.bounce {
  animation: word-bounce var(--dur-2) var(--ease-emph);
}
.word.sung {
  opacity: .72;
  color: var(--ink-2);
  transform: translate3d(0, 0, 0) scale(1);
}
.word.active:hover,
.word.sung:hover { color: var(--ink); }

@keyframes word-bounce {
  0% { opacity: 0; transform: translate3d(0, 0.35em, 0) scale(0.86); }
  55% { opacity: 1; transform: translate3d(0, -0.14em, 0) scale(1.06); }
  100% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}

.stage.snap .word,
.stage.snap .word.active,
.stage.snap .word.sung,
.stage.snap .word.unreached {
  animation: none;
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .word,
  .word.active,
  .word.sung,
  .word.unreached {
    animation: none;
    transition: none;
  }
}
</style>
