<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../common/Icon.vue';
import { fmtDuration, qualityBadge, platformName } from '../../core/format';
import { songKey } from '../../core/song';
import type { SongLike } from '../../core/song';

/**
 * 行数据形状：进入本组件的歌曲都会先过 normalizeSong，
 * 所以展示字段按已归一处理；其余透传字段保持 unknown。
 */
interface SongRow {
  id?: string;
  source?: string;
  title?: string;
  artist?: string;
  album?: string;
  cover?: string;
  duration?: number;
  lossless?: boolean;
  quality?: string;
  bitrate?: number;
  filePath?: string;
  [key: string]: unknown;
}

interface SongTableProps {
  /** 歌曲列表：接受未归一的 SongLike，行内按已归一字段展示 */
  songs?: readonly SongLike[];
  activeKey?: string;
  /** 批量选择集合；null 表示非批量模式 */
  selected?: Set<string> | null;
  batchMode?: boolean;
  showSource?: boolean;
  emptyText?: string;
  compact?: boolean;
}

const props = withDefaults(defineProps<SongTableProps>(), {
  songs: () => [],
  activeKey: '',
  selected: null,
  batchMode: false,
  showSource: true,
  emptyText: '暂无歌曲',
  compact: false,
});

const emit = defineEmits<{
  play: [index: number];
  queue: [song: SongLike];
  download: [song: SongLike];
  select: [song: SongLike];
}>();

const rows = computed<readonly SongRow[]>(() => (props.songs || []) as readonly SongRow[]);

function keyOf(s: SongRow): string { return songKey(s); }
function isSel(s: SongRow): boolean { return !!(props.selected && props.selected.has(keyOf(s))); }
function isOn(s: SongRow): boolean { return !!props.activeKey && keyOf(s) === props.activeKey; }

/** 封面加载失败时移除自身（与原内联 handler 等价，额外容忍 target 为空） */
function dropBrokenImg(e: Event): void {
  if (e.target instanceof HTMLElement) e.target.remove();
}
</script>

<template>
  <div class="song-table" :class="{ compact }">
    <div v-if="!rows.length" class="ly-empty">
      <Icon name="music" />
      <b>{{ emptyText }}</b>
      <p>换个关键词，或检查平台是否可用</p>
    </div>

    <div v-else class="rows">
      <div
        v-for="(s, i) in rows" :key="keyOf(s) + '-' + i"
        class="row" :class="{ on: isOn(s), sel: isSel(s) }"
        @dblclick="emit('play', i)"
      >
        <label v-if="batchMode" class="pick" @click.stop>
          <input type="checkbox" :checked="isSel(s)" @change="emit('select', s)" />
        </label>
        <span v-else class="idx">{{ String(i + 1).padStart(2, '0') }}</span>

        <div class="cover" :class="{ nocover: !s.cover }">
          <img v-if="s.cover" :src="s.cover" alt="" loading="lazy" decoding="async" @error="dropBrokenImg" />
          <Icon v-if="!s.cover" name="music" :size="15" />
        </div>

        <div class="meta">
          <div class="t" :title="s.title">{{ s.title }}</div>
          <div class="a" :title="`${s.artist || ''}${s.album ? ' · ' + s.album : ''}`">
            {{ s.artist || '未知歌手' }}<template v-if="s.album"> · {{ s.album }}</template>
          </div>
        </div>

        <span class="q ly-tag" :class="{ 'ly-tag-accent': s.lossless }">{{ qualityBadge(s) }}</span>
        <span v-if="showSource" class="src">{{ platformName(s.source) }}</span>
        <span class="dur">{{ fmtDuration(s.duration) }}</span>

        <div class="act">
          <button class="ly-icon-btn" title="播放" aria-label="播放" @click.stop="emit('play', i)">
            <Icon name="play" :size="13" />
          </button>
          <button class="ly-icon-btn" title="加入播放队列" aria-label="加入播放队列" @click.stop="emit('queue', s)">
            <Icon name="plus" :size="14" />
          </button>
          <button class="ly-icon-btn" title="下载" aria-label="下载" @click.stop="emit('download', s)">
            <Icon name="download" :size="14" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.song-table { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.rows { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 1px; padding-right: 2px; }

.row {
  display: flex; align-items: center; gap: var(--sp-3);
  min-height: 52px; padding: 6px var(--sp-3);
  border-radius: var(--r-md);
  transition: background var(--dur-1) var(--ease);
}
.row:hover { background: var(--glass-3); }
.row.sel { background: var(--accent-soft); }
.row.on { background: linear-gradient(95deg, rgba(124, 92, 255, .14), rgba(0, 198, 255, .1)); box-shadow: inset 0 0 0 1px var(--accent-line); }

.idx { width: 26px; flex-shrink: 0; text-align: right; font-size: var(--fs-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.pick { width: 26px; flex-shrink: 0; display: flex; justify-content: center; }
.pick input { width: 14px; height: 14px; accent-color: var(--au-1); cursor: pointer; }

.cover {
  width: 38px; height: 38px; flex-shrink: 0; border-radius: 10px;
  overflow: hidden; background: var(--glass-3);
  display: flex; align-items: center; justify-content: center;
  color: var(--ink-3);
}
.cover img { width: 100%; height: 100%; object-fit: cover; }
.cover.nocover { background: linear-gradient(135deg, var(--glass-2), var(--accent-soft)); }

.meta { flex: 1; min-width: 0; }
.t { font-size: var(--fs-sm); font-weight: var(--fw-med); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row.on .t { color: var(--au-1); }
.a { font-size: var(--fs-xs); color: var(--ink-3); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.q { flex-shrink: 0; min-width: 42px; justify-content: center; }
.src { width: 70px; flex-shrink: 0; font-size: var(--fs-xs); color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dur { width: 46px; flex-shrink: 0; text-align: right; font-size: var(--fs-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }

.act { display: flex; gap: 0; flex-shrink: 0; opacity: 0; transition: opacity var(--dur-1) var(--ease); }
.row:hover .act, .row.on .act { opacity: 1; }

.compact .row { min-height: 44px; padding: 4px var(--sp-2); }
.compact .cover { width: 32px; height: 32px; }
.compact .src { display: none; }
</style>