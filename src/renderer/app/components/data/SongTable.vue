<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../common/Icon.vue';
import { fmtDurationMs, qualityBadge, platformName } from '../../core/format';
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
        <span v-else class="idx">
          <span v-if="isOn(s)" class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <template v-else>{{ String(i + 1).padStart(2, '0') }}</template>
        </span>

        <div class="cover" :class="{ nocover: !s.cover }">
          <img v-if="s.cover" :src="s.cover" alt="" loading="lazy" decoding="async" @error="dropBrokenImg" />
          <Icon v-if="!s.cover" name="music" :size="15" />
          <span class="cover-play" aria-label="播放" @click.stop="emit('play', i)"><Icon name="play" :size="12" /></span>
        </div>

        <div class="meta">
          <div class="t" :title="s.title">{{ s.title }}</div>
          <div class="a" :title="`${s.artist || ''}${s.album ? ' · ' + s.album : ''}`">
            {{ s.artist || '未知歌手' }}<template v-if="s.album"> · {{ s.album }}</template>
          </div>
        </div>

        <span class="q ly-tag" :class="{ 'ly-tag-accent': s.lossless }">{{ qualityBadge(s) }}</span>
        <span v-if="showSource" class="src">{{ platformName(s.source) }}</span>
        <span class="dur">{{ fmtDurationMs(s.duration) }}</span>

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
.rows {
  overflow-y: auto; min-height: 0;
  display: flex; flex-direction: column; gap: 2px;
  padding: 2px 4px 4px 2px;
}

.row {
  position: relative;
  display: flex; align-items: center; gap: var(--sp-3);
  min-height: 62px; padding: 7px var(--sp-3) 7px 6px;
  border-radius: var(--r-md);
  transition: background var(--dur-1) var(--ease),
              transform var(--dur-1) var(--ease),
              box-shadow var(--dur-1) var(--ease);
}
/* 左侧极光强调条：仅播放中行点亮 */
.row::before {
  content: ""; position: absolute; left: -2px; top: 50%; transform: translateY(-50%);
  width: 3px; height: 24px; border-radius: var(--r-full);
  background: var(--au-grad);
  opacity: 0; transition: opacity var(--dur-1) var(--ease);
}
.row:hover { background: var(--glass-3); transform: translateX(2px); }
.row.sel { background: var(--accent-soft); }
.row.on {
  background: linear-gradient(95deg, rgba(124, 92, 255, .16), rgba(0, 198, 255, .09));
  box-shadow: inset 0 0 0 1px var(--accent-line), 0 6px 18px rgba(124, 92, 255, .12);
}
.row.on::before { opacity: 1; }

.idx {
  width: 30px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  font-size: var(--fs-xs); color: var(--ink-3); font-variant-numeric: tabular-nums;
}
.row.on .idx { color: var(--au-1); }
.pick { width: 30px; flex-shrink: 0; display: flex; justify-content: center; }
.pick input { width: 14px; height: 14px; accent-color: var(--au-1); cursor: pointer; }

/* 播放中均衡器：仅当前行一根，4 条细柱，极轻量 */
.eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 13px; }
.eq i {
  display: block; width: 2.5px; border-radius: 2px;
  background: var(--au-grad);
  transform-origin: bottom;
  animation: eq-bars 1.05s ease-in-out infinite;
}
.eq i:nth-child(1) { height: 55%; animation-delay: -.55s; }
.eq i:nth-child(2) { height: 100%; animation-delay: -.25s; }
.eq i:nth-child(3) { height: 70%; animation-delay: -.4s; }
.eq i:nth-child(4) { height: 45%; animation-delay: -.7s; }
@keyframes eq-bars { 0%, 100% { transform: scaleY(.35); } 50% { transform: scaleY(1); } }

.cover {
  position: relative;
  width: 46px; height: 46px; flex-shrink: 0; border-radius: 12px;
  overflow: hidden; background: var(--glass-3);
  display: flex; align-items: center; justify-content: center;
  color: var(--ink-3);
  box-shadow: 0 2px 10px rgba(20, 24, 36, .12);
  transition: transform var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease);
}
.cover img { width: 100%; height: 100%; object-fit: cover; transition: transform var(--dur-2) var(--ease); }
.row:hover .cover { transform: scale(1.05); box-shadow: 0 8px 20px rgba(20, 24, 36, .20); }
.row:hover .cover img { transform: scale(1.1); }
.cover.nocover { background: linear-gradient(135deg, var(--glass-2), var(--accent-soft)); }
.cover-play {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(20, 24, 36, .42); color: #fff;
  opacity: 0; cursor: pointer;
  transition: opacity var(--dur-1) var(--ease);
}
.cover-play svg { width: 12px; height: 12px; transform: translateX(1px); }
.row:hover .cover-play { opacity: 1; }
.row.on .cover-play { background: rgba(124, 92, 255, .55); }

.meta { flex: 1; min-width: 0; }
.t {
  font-size: var(--fs-md); font-weight: var(--fw-bold); color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row.on .t {
  background: linear-gradient(95deg, var(--au-1) 30%, var(--au-2));
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.a {
  font-size: var(--fs-xs); color: var(--ink-2); margin-top: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.q { flex-shrink: 0; min-width: 42px; justify-content: center; }
.src {
  width: 72px; flex-shrink: 0; font-size: var(--fs-xs); color: var(--ink-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dur {
  width: 48px; flex-shrink: 0; text-align: right;
  font-size: var(--fs-xs); color: var(--ink-3); font-variant-numeric: tabular-nums;
}
.row.on .dur { color: var(--au-1); font-weight: var(--fw-med); }

.act {
  display: flex; gap: 2px; flex-shrink: 0;
  opacity: 0; transition: opacity var(--dur-1) var(--ease);
}
.row:hover .act, .row.on .act { opacity: 1; }

/* compact 变体：mini player / 抽屉复用，保持紧凑但沿用新视觉 */
.compact .row { min-height: 46px; padding: 5px var(--sp-2); }
.compact .row::before { height: 18px; }
.compact .cover { width: 34px; height: 34px; box-shadow: 0 1px 6px rgba(20, 24, 36, .1); }
.compact .idx { width: 26px; }
.compact .eq { height: 10px; }
.compact .t { font-size: var(--fs-sm); }
.compact .a { margin-top: 1px; }
.compact .src { display: none; }
</style>