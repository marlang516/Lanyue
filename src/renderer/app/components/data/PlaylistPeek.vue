<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { call } from '../../core/bridge';
import { normalizeSongs } from '../../core/song';
import type { Song } from '../../core/song';
import { errText, toast } from '../../core/toast';
import { playFromList, appendToQueue } from '../../stores/player';
import type { PlaylistSummary } from '../../stores/types';
import { platformName } from '../../core/format';
import SongTable from './SongTable.vue';
import Icon from '../common/Icon.vue';

interface PlaylistPeekProps {
  open?: boolean;
  /** 预览中的歌单摘要（DiscoverView 的 peek.playlist） */
  playlist?: PlaylistSummary | null;
}

const props = withDefaults(defineProps<PlaylistPeekProps>(), {
  open: false,
  playlist: null,
});
const emit = defineEmits<{ close: [] }>();

const loading = ref(false);
const error = ref('');
const songs = ref<Song[]>([]);

const title = computed(() => props.playlist?.name || '歌单');

watch(() => [props.open, props.playlist?.id, props.playlist?.source], async () => {
  if (!props.open || !props.playlist) return;
  loading.value = true;
  error.value = '';
  songs.value = [];
  try {
    const list = await call('getPlaylistSongs', props.playlist.source, props.playlist.id, 300);
    songs.value = normalizeSongs(list);
    if (!songs.value.length) error.value = '歌单暂无歌曲';
  } catch (e) {
    error.value = errText(e, '加载歌单失败');
  } finally {
    loading.value = false;
  }
}, { immediate: true });

function playAll(): void {
  if (!songs.value.length) return;
  playFromList(songs.value, 0);
}

function playAt(i: number): void {
  playFromList(songs.value, i);
}

function queueAll(): void {
  if (!songs.value.length) return;
  const n = appendToQueue(songs.value);
  toast.success(`已加入播放队列 ${n} 首`);
}

/** 封面加载失败时移除自身（与原内联 handler 等价，额外容忍 target 为空） */
function dropBrokenImg(e: Event): void {
  if (e.target instanceof HTMLElement) e.target.remove();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="pk">
      <div v-if="open" class="mask" @mousedown.self="emit('close')">
        <div class="panel ly-card" role="dialog" aria-modal="true" :aria-label="title">
          <header class="hd">
            <div class="cover" :class="{ ph: !playlist?.cover }">
              <img v-if="playlist?.cover" :src="playlist.cover" alt="" @error="dropBrokenImg" />
              <Icon v-else name="playlist" :size="22" />
            </div>
            <div class="tx">
              <h3>{{ title }}</h3>
              <p>{{ platformName(playlist?.source) }}<template v-if="songs.length"> · {{ songs.length }} 首</template></p>
            </div>
            <div class="acts">
              <button class="ly-btn ly-btn-primary" :disabled="!songs.length" @click="playAll">
                <Icon name="play" :size="12" /> 播放全部
              </button>
              <button class="ly-btn" :disabled="!songs.length" @click="queueAll">加入队列</button>
              <button class="ly-icon-btn" aria-label="关闭" @click="emit('close')"><Icon name="x" /></button>
            </div>
          </header>

          <div class="body">
            <div v-if="loading" class="skels">
              <div v-for="n in 8" :key="n" class="ly-skeleton" style="height: 52px"></div>
            </div>
            <div v-else-if="error" class="ly-empty"><Icon name="warning" /><b>{{ error }}</b></div>
            <SongTable v-else :songs="songs" compact @play="playAt" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: var(--z-modal);
  background: rgba(12, 16, 28, .38);
  backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);
  display: flex; align-items: center; justify-content: center; padding: var(--sp-6);
}
.panel {
  width: min(760px, 94vw); height: min(72vh, 680px);
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: var(--shadow-pop);
}
.hd { display: flex; align-items: center; gap: var(--sp-4); padding: var(--sp-5); border-bottom: 1px solid var(--hairline); }
.cover {
  width: 64px; height: 64px; flex-shrink: 0; border-radius: var(--r-md);
  overflow: hidden; background: var(--glass-3);
  display: flex; align-items: center; justify-content: center; color: var(--ink-3);
}
.cover.ph { background: linear-gradient(135deg, var(--glass-3), var(--accent-soft)); }
.cover img { width: 100%; height: 100%; object-fit: cover; }
.tx { flex: 1; min-width: 0; }
.tx h3 { font-size: var(--fs-lg); font-weight: var(--fw-bold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tx p { margin-top: 3px; font-size: var(--fs-xs); color: var(--ink-3); }
.acts { display: flex; gap: var(--sp-2); align-items: center; }
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: var(--sp-3) var(--sp-4) var(--sp-4); }
.skels { display: flex; flex-direction: column; gap: var(--sp-2); }

.pk-enter-active, .pk-leave-active { transition: opacity var(--dur-1) var(--ease); }
.pk-enter-active .panel, .pk-leave-active .panel { transition: transform var(--dur-2) var(--ease-emph), opacity var(--dur-1); }
.pk-enter-from, .pk-leave-to { opacity: 0; }
.pk-enter-from .panel, .pk-leave-to .panel { transform: translateY(10px) scale(.98); opacity: 0; }
</style>