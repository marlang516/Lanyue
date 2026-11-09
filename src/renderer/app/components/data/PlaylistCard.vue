<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../common/Icon.vue';
import { fmtCount, platformName } from '../../core/format';

/** 卡片数据：PlaylistSummary 与发现页分区条目都满足该形状 */
interface PlaylistCardRow {
  name?: string;
  source?: string;
  cover?: string;
  playCount?: number;
  [key: string]: unknown;
}

interface PlaylistCardProps {
  playlist: PlaylistCardRow;
}

const props = defineProps<PlaylistCardProps>();
const emit = defineEmits<{ open: [playlist: PlaylistCardRow] }>();

const cover = computed(() => props.playlist.cover || '');
const plays = computed(() => (props.playlist.playCount ? fmtCount(props.playlist.playCount) : ''));

/** 封面加载失败时移除自身（与原内联 handler 等价，额外容忍 target 为空） */
function dropBrokenImg(e: Event): void {
  if (e.target instanceof HTMLElement) e.target.remove();
}
</script>

<template>
  <button class="pcard" type="button" :title="playlist.name" @click="emit('open', playlist)">
    <div class="cov">
      <img v-if="cover" :src="cover" alt="" loading="lazy" decoding="async" @error="dropBrokenImg" />
      <div v-else class="ph"><Icon name="playlist" :size="24" /></div>
      <span v-if="plays" class="plays"><Icon name="play" :size="10" /> {{ plays }}</span>
      <span class="hover"><Icon name="play" :size="16" /></span>
    </div>
    <div class="name">{{ playlist.name }}</div>
    <div class="src">{{ platformName(playlist.source) }}</div>
  </button>
</template>

<style scoped>
.pcard {
  display: flex; flex-direction: column; gap: var(--sp-2);
  padding: 0; border: 0; background: transparent;
  text-align: left; cursor: pointer; min-width: 0;
}
.cov {
  position: relative; width: 100%; aspect-ratio: 1 / 1;
  border-radius: var(--r-md); overflow: hidden;
  background: var(--glass-3);
  box-shadow: var(--shadow-card);
  transition: transform var(--dur-2) var(--ease-emph), box-shadow var(--dur-2) var(--ease);
}
.pcard:hover .cov { transform: translateY(-3px); box-shadow: var(--shadow-pop); }
.cov img { width: 100%; height: 100%; object-fit: cover; }
.ph {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  color: var(--ink-3);
  background: linear-gradient(135deg, var(--glass-2), var(--accent-soft));
}
.plays {
  position: absolute; left: 8px; top: 8px;
  display: inline-flex; align-items: center; gap: 3px;
  padding: 2px 7px; border-radius: var(--r-full);
  background: rgba(10, 14, 24, .5); color: #fff;
  font-size: var(--fs-2xs); font-weight: var(--fw-bold);
  backdrop-filter: blur(6px);
}
.plays svg { fill: currentColor; stroke: none; }
.hover {
  position: absolute; right: 9px; bottom: 9px;
  width: 34px; height: 34px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--au-grad); color: #fff;
  box-shadow: var(--glow-accent);
  opacity: 0; transform: translateY(6px) scale(.9);
  transition: opacity var(--dur-2) var(--ease), transform var(--dur-2) var(--ease-emph);
}
.hover svg { fill: currentColor; stroke: none; }
.pcard:hover .hover { opacity: 1; transform: none; }

.name { font-size: var(--fs-sm); font-weight: var(--fw-med); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.src { font-size: var(--fs-2xs); color: var(--ink-3); }
</style>