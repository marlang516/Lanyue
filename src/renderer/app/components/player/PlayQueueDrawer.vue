<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  player, togglePlay, next, prev, seekTo, playSong, removeFromQueue,
  clearQueue, persistQueue,
} from '../../stores/player';
import { fmtDurationMs, platformName } from '../../core/format';
import { toast } from '../../core/toast';
import { useModalAccessibility } from '../../composables/useModalAccessibility';
import Icon from '../common/Icon.vue';

const dragIndex = ref(-1);
const dragOver = ref(-1);
const drawerEl = ref<HTMLElement | null>(null);

const currentIdx = computed(() => player.queueIdx);

useModalAccessibility(() => player.queueOpen, drawerEl, close);

function close(): void {
  player.queueOpen = false;
}

function playAt(i: number): void {
  if (!player.queue[i]) return;
  player.queueIdx = i;
  playSong(player.queue[i]);
  persistQueue();
}

function removeAt(i: number, e: MouseEvent): void {
  e.stopPropagation();
  removeFromQueue(i);
  toast.info('已从队列移除');
}

function clear(): void {
  clearQueue();
  toast.info('播放队列已清空');
  persistQueue();
}

function onDragStart(i: number, e: DragEvent): void {
  dragIndex.value = i;
  // dataTransfer 在部分合成事件里为空，此时仅保留内部排序状态
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(i: number, e: DragEvent): void {
  e.preventDefault();
  dragOver.value = i;
}
function onDrop(i: number): void {
  const from = dragIndex.value;
  dragIndex.value = -1;
  dragOver.value = -1;
  if (from < 0 || from === i) return;
  const list = player.queue;
  const [item] = list.splice(from, 1);
  list.splice(i, 0, item);
  if (player.queueIdx === from) player.queueIdx = i;
  else if (from < player.queueIdx && i >= player.queueIdx) player.queueIdx -= 1;
  else if (from > player.queueIdx && i <= player.queueIdx) player.queueIdx += 1;
  persistQueue();
}
function onDragEnd(): void {
  dragIndex.value = -1;
  dragOver.value = -1;
}

/** 封面加载失败时移除自身（与原内联 handler 等价，额外容忍 target 为空） */
function dropBrokenImg(e: Event): void {
  if (e.target instanceof HTMLElement) e.target.remove();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="qd">
      <div v-if="player.queueOpen" class="mask" @mousedown.self="close">
        <aside ref="drawerEl" class="drawer ly-card" role="dialog" aria-modal="true" aria-label="播放队列" tabindex="-1">
          <header class="hd">
            <div>
              <h3>播放队列</h3>
              <p>{{ player.queue.length }} 首 · {{ player.queueIdx + 1 > player.queue.length ? 0 : player.queueIdx + 1 }} 正在播放</p>
            </div>
            <button class="ly-icon-btn" title="关闭" aria-label="关闭" @click="close"><Icon name="x" /></button>
          </header>

          <div class="body">
            <div v-if="!player.queue.length" class="ly-empty">
              <Icon name="queue" /><b>队列为空</b>
              <p>在任意列表点「加入播放队列」</p>
            </div>

            <div v-else class="qlist">
              <div
                v-for="(s, i) in player.queue" :key="(s.id || s.filePath) + '-' + i"
                class="qitem" :class="{ on: i === currentIdx, over: i === dragOver }"
                draggable="true"
                @dragstart="onDragStart(i, $event)"
                @dragover="onDragOver(i, $event)"
                @drop.prevent="onDrop(i)"
                @dragend="onDragEnd"
              >
                <button class="qplay" type="button" :aria-label="`播放 ${s.title} - ${s.artist || '未知歌手'}`" @click="playAt(i)">
                  <span class="grip" aria-hidden="true"><Icon name="grip" :size="12" /></span>
                  <span class="idx" aria-hidden="true">{{ i === currentIdx && player.playing ? '▶' : String(i + 1).padStart(2, '0') }}</span>
                  <span class="cov" :class="{ ph: !s.cover }">
                    <img v-if="s.cover" :src="s.cover" alt="" loading="lazy" @error="dropBrokenImg" />
                    <Icon v-else name="music" :size="13" />
                  </span>
                  <span class="tx">
                    <span class="t">{{ s.title }}</span>
                    <span class="a">{{ s.artist || '未知歌手' }} · {{ platformName(s.source) }}</span>
                  </span>
                  <span class="dur">{{ fmtDurationMs(s.duration) }}</span>
                </button>
                <button class="ly-icon-btn danger" title="移除" aria-label="移除" @click="removeAt(i, $event)">
                  <Icon name="x" :size="13" />
                </button>
              </div>
            </div>
          </div>

          <footer class="ft">
            <button class="ly-btn ly-btn-sm" :disabled="!player.queue.length" @click="clear">
              <Icon name="trash" :size="13" /> 清空队列
            </button>
            <span class="hint">拖动条目可调整顺序</span>
          </footer>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: var(--z-popover);
  background: rgba(12, 16, 28, .28);
  backdrop-filter: blur(3px);
  display: flex; justify-content: flex-end;
}
.drawer {
  width: min(440px, 92vw); height: 100%;
  border-radius: var(--r-xl) 0 0 var(--r-xl);
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: var(--shadow-pop);
}
.hd { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-4) var(--sp-5); border-bottom: 1px solid var(--hairline); }
.hd h3 { font-size: var(--fs-lg); font-weight: var(--fw-bold); }
.hd p { margin-top: 2px; font-size: var(--fs-xs); color: var(--ink-3); }
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; padding: var(--sp-2) var(--sp-2) var(--sp-3); }
.qlist { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.qitem {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 7px var(--sp-2); border-radius: var(--r-md);
  transition: background var(--dur-1), box-shadow var(--dur-1);
}
.qitem:hover { background: var(--glass-3); }
.qplay {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-2);
  padding: 0; border: 0; border-radius: var(--r-sm);
  background: transparent; color: inherit; text-align: left; cursor: pointer;
}
.qplay:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 2px; }
.qitem.on { background: linear-gradient(95deg, rgba(124, 92, 255, .14), rgba(0, 198, 255, .1)); box-shadow: inset 0 0 0 1px var(--accent-line); }
.qitem.over { border-top: 2px solid var(--au-1); }
.grip { color: var(--ink-3); opacity: .5; cursor: grab; display: inline-flex; }
.idx { width: 22px; flex-shrink: 0; text-align: center; font-size: var(--fs-2xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.qitem.on .idx { color: var(--au-1); }
.cov { width: 32px; height: 32px; flex-shrink: 0; border-radius: 9px; overflow: hidden; background: var(--glass-3); display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
.cov img { width: 100%; height: 100%; object-fit: cover; }
.cov.ph { background: linear-gradient(135deg, var(--glass-2), var(--accent-soft)); }
.tx { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.t { font-size: var(--fs-sm); font-weight: var(--fw-med); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qitem.on .t { color: var(--au-1); }
.a { margin-top: 1px; font-size: var(--fs-2xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dur { font-size: var(--fs-2xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.danger:hover { color: var(--danger); background: rgba(229, 72, 77, .1); }
.ft { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-3) var(--sp-5); border-top: 1px solid var(--hairline); }
.hint { font-size: var(--fs-2xs); color: var(--ink-3); }

.qd-enter-active, .qd-leave-active { transition: opacity var(--dur-2) var(--ease); }
.qd-enter-active .drawer, .qd-leave-active .drawer { transition: transform var(--dur-2) var(--ease-emph); }
.qd-enter-from, .qd-leave-to { opacity: 0; }
.qd-enter-from .drawer, .qd-leave-to .drawer { transform: translateX(100%); }
</style>