<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../common/Icon.vue';
import { fmtDuration, fmtSize } from '../../core/format';
import type { LocalSong } from '../../stores/types';

/** 表格行：本地索引条目，主进程还会附带用于展示的 fileName */
interface LocalSongRow extends LocalSong {
  fileName?: string;
}

interface LocalSongTableProps {
  songs?: LocalSongRow[];
  /** 当前播放项：按 filePath 比对 */
  activeKey?: string;
  /** 批量选择集合；null 表示非批量模式 */
  selected?: Set<string> | null;
  batchMode?: boolean;
}

const props = withDefaults(defineProps<LocalSongTableProps>(), {
  songs: () => [],
  activeKey: '',
  selected: null,
  batchMode: false,
});

const emit = defineEmits<{
  play: [index: number];
  queue: [song: LocalSongRow];
  open: [song: LocalSongRow];
  delete: [song: LocalSongRow];
  select: [song: LocalSongRow];
}>();

const rows = computed<LocalSongRow[]>(() => props.songs || []);

function keyOf(s: LocalSongRow): string { return s.filePath || ''; }
function isSel(s: LocalSongRow): boolean { return !!(props.selected && props.selected.has(keyOf(s))); }
function isOn(s: LocalSongRow): boolean { return !!props.activeKey && keyOf(s) === props.activeKey; }
function extLabel(s: LocalSongRow): string { return String(s.ext || '').replace('.', '').toUpperCase() || '—'; }
function bitrate(s: LocalSongRow): string { return s.bitrate ? `${Math.round(s.bitrate / 1000)}k` : '—'; }
</script>

<template>
  <div class="lt">
    <div v-if="!rows.length" class="ly-empty">
      <Icon name="library" />
      <b>曲库为空</b>
      <p>选择音乐目录后扫描，或等待下载完成自动入库</p>
    </div>

    <div v-else class="rows">
      <div class="thead">
        <span class="idx"></span>
        <span class="cover-sp"></span>
        <span class="meta">歌曲</span>
        <span class="ext">格式</span>
        <span class="num br">码率</span>
        <span class="num sz">大小</span>
        <span class="num dur">时长</span>
        <span class="act-sp"></span>
      </div>
      <div
        v-for="(s, i) in rows" :key="keyOf(s) + i"
        class="row" :class="{ on: isOn(s), sel: isSel(s) }"
        @dblclick="emit('play', i)"
      >
        <label v-if="batchMode" class="pick" @click.stop>
          <input type="checkbox" :checked="isSel(s)" @change="emit('select', s)" />
        </label>
        <span v-else class="idx">{{ String(i + 1).padStart(2, '0') }}</span>

        <div class="cover" :class="{ nocover: !s.cover }">
          <img v-if="s.cover" :src="s.cover" alt="" loading="lazy" decoding="async" />
          <Icon v-else name="music" :size="15" />
        </div>

        <div class="meta">
          <div class="t" :title="s.title">{{ s.title || s.fileName }}</div>
          <div class="a" :title="`${s.artist || ''}${s.album ? ' · ' + s.album : ''}`">
            {{ s.artist || '未知歌手' }}<template v-if="s.album"> · {{ s.album }}</template>
          </div>
        </div>

        <span class="ext ly-tag" :class="{ 'ly-tag-accent': String(s.ext).toLowerCase() === '.flac' }">{{ extLabel(s) }}</span>
        <span class="num br">{{ bitrate(s) }}</span>
        <span class="num sz">{{ fmtSize(s.fileSize) }}</span>
        <span class="num dur">{{ fmtDuration((s.durationMs || 0) / 1000) }}</span>

        <div class="act">
          <button class="ly-icon-btn" title="播放" aria-label="播放" @click.stop="emit('play', i)">
            <Icon name="play" :size="13" />
          </button>
          <button class="ly-icon-btn" title="加入播放队列" aria-label="加入播放队列" @click.stop="emit('queue', s)">
            <Icon name="plus" :size="14" />
          </button>
          <button class="ly-icon-btn" title="打开文件位置" aria-label="打开文件位置" @click.stop="emit('open', s)">
            <Icon name="folder" :size="14" />
          </button>
          <button class="ly-icon-btn danger" title="移到回收站" aria-label="移到回收站" @click.stop="emit('delete', s)">
            <Icon name="trash" :size="14" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lt { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.rows { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 1px; padding-right: 2px; }
.thead {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: 4px var(--sp-3) 8px;
  position: sticky; top: 0; z-index: 2;
  background: var(--glass-3); backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--hairline);
  font-size: var(--fs-2xs); color: var(--ink-3); letter-spacing: .06em;
}
.thead .idx { width: 26px; }
.thead .cover-sp { width: 38px; }
.thead .ext { width: 52px; text-align: center; }
.thead .br { width: 52px; }
.thead .sz { width: 68px; }
.thead .dur { width: 50px; }
.thead .act-sp { width: 136px; }
.thead .num { text-align: right; }
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
.cover { width: 38px; height: 38px; flex-shrink: 0; border-radius: 10px; overflow: hidden; background: var(--glass-3); display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
.cover img { width: 100%; height: 100%; object-fit: cover; }
.cover.nocover { background: linear-gradient(135deg, var(--glass-2), var(--accent-soft)); }
.meta { flex: 1; min-width: 0; }
.t { font-size: var(--fs-sm); font-weight: var(--fw-med); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row.on .t { color: var(--au-1); }
.a { font-size: var(--fs-xs); color: var(--ink-3); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ext { flex-shrink: 0; width: 52px; justify-content: center; }
.num { flex-shrink: 0; text-align: right; font-size: var(--fs-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.br { width: 52px; }
.sz { width: 68px; }
.dur { width: 50px; }
.act { display: flex; flex-shrink: 0; opacity: 0; transition: opacity var(--dur-1) var(--ease); }
.row:hover .act, .row.on .act { opacity: 1; }
.act .danger:hover { color: var(--danger); background: rgba(229, 72, 77, .1); }
</style>