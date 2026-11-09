<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { lyrics, activeLineIndex, setOffset } from '../../stores/lyrics';
import { player, seekTo } from '../../stores/player';
import type { LyricLine } from '../../stores/types';
import Icon from '../common/Icon.vue';

const wrap = ref<HTMLElement | null>(null);
const lineEls = ref<(HTMLElement | null)[]>([]);

const idx = computed(() => activeLineIndex(lyrics.items, player.progress + lyrics.offsetMs / 1000));
const offsetLabel = computed(() => {
  const s = lyrics.offsetMs / 1000;
  return `${s > 0 ? '+' : ''}${s.toFixed(1)}s`;
});

watch(idx, async () => {
  await nextTick();
  const el = lineEls.value[idx.value];
  const box = wrap.value;
  if (!el || !box) return;
  const top = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
  box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
});

// 换歌时回到顶部
watch(() => lyrics.loadedKey, () => {
  lineEls.value = [];
  if (wrap.value) wrap.value.scrollTop = 0;
});

/** 模板 ref 回调：只收真实 DOM 元素，组件实例/空值按未挂载处理 */
function setLineEl(el: Element | ComponentPublicInstance | null, i: number): void {
  lineEls.value[i] = el instanceof HTMLElement ? el : null;
}

function jump(line: LyricLine): void {
  seekTo(Math.max(0, line.t - lyrics.offsetMs / 1000));
}

function nudge(ms: number): void {
  setOffset(lyrics.offsetMs + ms);
}
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

    <div v-else ref="wrap" class="lines">
      <button
        v-for="(l, i) in lyrics.items" :key="i"
        :ref="(el) => setLineEl(el, i)"
        class="line" :class="{ on: i === idx, past: i < idx }"
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
  flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin;
  padding: 26vh var(--sp-4) 30vh;
  display: flex; flex-direction: column; gap: 4px;
  -webkit-mask-image: linear-gradient(180deg, transparent, #000 12%, #000 88%, transparent);
  mask-image: linear-gradient(180deg, transparent, #000 12%, #000 88%, transparent);
}
.line {
  border: 0; background: transparent; text-align: left; cursor: pointer;
  padding: 7px var(--sp-3); border-radius: var(--r-md);
  font-size: var(--fs-lg); font-weight: var(--fw-med); line-height: 1.5;
  color: var(--ink-3);
  transition: color var(--dur-2) var(--ease), background var(--dur-2) var(--ease), transform var(--dur-2) var(--ease-emph);
}
.line:hover { color: var(--ink-2); background: var(--glass-3); }
.line.past { color: var(--ink-2); opacity: .62; }
.line.on {
  color: var(--ink);
  font-weight: var(--fw-bold);
  background: linear-gradient(95deg, rgba(124, 92, 255, .14), rgba(0, 198, 255, .1));
  box-shadow: inset 0 0 0 1px var(--accent-line);
  transform: translateX(3px);
}
</style>