<script setup lang="ts">
import { onMounted } from 'vue';
import {
  library, filteredSongs, formats, libraryStats, selectedCount, SORT_OPTIONS,
  initLibrary, scanLibrary, chooseDirectory, toggleSelect, toggleSelectAll,
  addSelectedToQueue, deleteSong, openInFolder,
} from '../stores/library';
import type { LocalSong } from '../stores/types';
import { player, currentKey, playFromList, appendToQueue } from '../stores/player';
import { fmtSize, timeAgo } from '../core/format';
import { toast } from '../core/toast';
import LocalSongTable from '../components/data/LocalSongTable.vue';
import Icon from '../components/common/Icon.vue';

onMounted(initLibrary);

function onPlay(i: number) {
  const list = filteredSongs.value;
  if (list[i]) playFromList(list, i);
}

function onQueue(song: LocalSong) {
  const n = appendToQueue([song]);
  toast.success(`已加入队列 ${n} 首`);
}

/** 下拉框取值：事件目标按 HTMLSelectElement 收窄，非表单元素直接忽略 */
function onSelectValue(e: Event, apply: (v: string) => void): void {
  if (e.target instanceof HTMLSelectElement) apply(e.target.value);
}

function onFormatChange(e: Event) {
  onSelectValue(e, (v) => { library.format = v; });
}

function onQualityChange(e: Event) {
  onSelectValue(e, (v) => { library.quality = v; });
}

function onSortChange(e: Event) {
  onSelectValue(e, (v) => { library.sort = v; });
}

function exitBatch() {
  library.batchMode = false;
  library.selected.clear();
}
</script>

<template>
  <div class="lv">
    <section class="head ly-card">
      <div class="line">
        <div class="dir">
          <span class="dico"><Icon name="folder" :size="16" /></span>
          <span class="dpath" :title="library.dirPath">{{ library.dirPath || '尚未选择曲库目录' }}</span>
        </div>
        <button class="ly-btn" @click="chooseDirectory">选择目录</button>
        <button class="ly-btn ly-btn-primary" :disabled="library.scanning || !library.dirPath" @click="scanLibrary()">
          <Icon name="refresh" :size="14" :class="{ spin: library.scanning }" />
          {{ library.scanning ? '扫描中…' : '扫描' }}
        </button>
      </div>

      <div class="line">
        <div class="ly-search kw">
          <Icon name="search" :size="16" />
          <input v-model="library.keyword" placeholder="过滤歌名、歌手、专辑…" aria-label="过滤曲库" />
        </div>

        <select class="ly-input fmt" :value="library.format" aria-label="格式" @change="onFormatChange">
          <option value="all">全部格式</option>
          <option v-for="f in formats" :key="f" :value="f">{{ f.toUpperCase() }}</option>
        </select>

        <select class="ly-input qual" :value="library.quality" aria-label="音质" @change="onQualityChange">
          <option value="all">全部音质</option>
          <option value="high">高品质及以上</option>
          <option value="lossless">无损</option>
        </select>

        <select class="ly-input sort" :value="library.sort" aria-label="排序" @change="onSortChange">
          <option v-for="o in SORT_OPTIONS" :key="o.id" :value="o.id">{{ o.label }}</option>
        </select>

        <button class="ly-btn" :class="{ 'ly-btn-primary': library.batchMode }" :aria-pressed="library.batchMode" @click="library.batchMode = !library.batchMode; library.selected.clear()">
          <Icon name="check" :size="14" /> 选择
        </button>
      </div>

      <div class="stats">
        <div class="st"><b>{{ libraryStats.count }}</b><span>曲目</span></div>
        <div class="st"><b>{{ formats.length }}</b><span>格式</span></div>
        <div class="st"><b>{{ fmtSize(libraryStats.size) }}</b><span>占用空间</span></div>
        <div class="st"><b>{{ library.lastScan ? timeAgo(library.lastScan) : '—' }}</b><span>最近扫描</span></div>
      </div>
    </section>

    <section class="body ly-card">
      <header class="bh">
        <div>
          <h2>本地曲库</h2>
          <p>{{ filteredSongs.length }} / {{ library.songs.length }} 首<template v-if="player.current && player.current.filePath"> · 正在播放「{{ player.current.title }}」</template></p>
        </div>
        <button class="ly-btn ly-btn-sm" title="重新读取索引" @click="initLibrary">
          <Icon name="refresh" :size="13" /> 刷新
        </button>
      </header>

      <div class="content">
        <div v-if="library.loading" class="skels">
          <div v-for="n in 8" :key="n" class="ly-skeleton" style="height: 52px"></div>
        </div>

        <div v-else-if="library.error" class="ly-empty">
          <Icon name="warning" />
          <b>{{ library.error }}</b>
          <button class="ly-btn ly-btn-sm" @click="scanLibrary()">重试</button>
        </div>

        <LocalSongTable
          v-else
          :songs="filteredSongs" :active-key="player.current && player.current.filePath ? player.current.filePath : ''"
          :selected="library.batchMode ? library.selected : null" :batch-mode="library.batchMode"
          @play="onPlay" @queue="onQueue" @open="openInFolder" @delete="deleteSong" @select="toggleSelect"
        />
      </div>

      <footer v-if="library.batchMode" class="batch">
        <label class="all"><input type="checkbox" :checked="selectedCount > 0 && selectedCount >= filteredSongs.length" @change="toggleSelectAll" /> 全选</label>
        <span class="ly-num">已选 {{ selectedCount }} 首</span>
        <button class="ly-btn ly-btn-primary" :disabled="!selectedCount" @click="addSelectedToQueue">加入播放队列</button>
        <button class="ly-btn ly-btn-ghost" @click="exitBatch">退出选择</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.lv { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--gap-app); }
.head { flex-shrink: 0; padding: var(--sp-4) var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-3); }
.line { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.dir { flex: 1; min-width: 240px; display: flex; align-items: center; gap: var(--sp-2); color: var(--ink-2); font-size: var(--fs-sm); }
.dico { color: var(--au-1); display: inline-flex; }
.dpath { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: var(--fs-xs); }
.kw { flex: 1; min-width: 240px; }
.fmt { width: 120px; flex-shrink: 0; height: 36px; }
.qual { width: 140px; flex-shrink: 0; height: 36px; }
.sort { width: 130px; flex-shrink: 0; height: 36px; }

.stats { display: flex; gap: var(--sp-2); }
.st {
  flex: 1; display: flex; align-items: baseline; gap: var(--sp-2);
  padding: 8px var(--sp-3); border-radius: var(--r-md);
  background: var(--glass-3); border: 1px solid var(--hairline);
}
.st b { font-size: var(--fs-md); font-weight: var(--fw-black); color: var(--au-1); }
.st span { font-size: var(--fs-2xs); color: var(--ink-3); }

.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: var(--sp-4) var(--sp-5); overflow: hidden; }
.bh { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); padding-bottom: var(--sp-3); }
.bh h2 { font-size: var(--fs-xl); font-weight: var(--fw-bold); }
.bh p { margin-top: 2px; font-size: var(--fs-xs); color: var(--ink-3); }
.content { flex: 1; min-height: 0; display: flex; flex-direction: column; padding-top: var(--sp-2); overflow: hidden; }
.skels { display: flex; flex-direction: column; gap: var(--sp-2); }
.batch { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--hairline); }
.batch .all { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--ink-2); }
.batch input { accent-color: var(--au-1); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>