<script setup lang="ts">
import { onMounted, computed } from 'vue';
import {
  playlists, activePlaylist, activeSongs, selectedCount, loadPlaylists, loadTrash,
  selectPlaylist, createPlaylist, renamePlaylist, removePlaylist, restorePlaylist, purgePlaylist,
  removeSongFrom, removeSelected, toggleSelect, toggleSelectAll, downloadActive,
  dedupeActive, exportActiveM3U,
} from '../stores/playlist';
import type { Song } from '../core/song';
import { player, currentKey, playFromList } from '../stores/player';
import { toast } from '../core/toast';
import SongTable from '../components/data/SongTable.vue';
import Icon from '../components/common/Icon.vue';

const SORTS = [
  { id: 'default', label: '默认顺序' },
  { id: 'title', label: '歌名' },
  { id: 'artist', label: '歌手' },
  { id: 'duration', label: '时长' },
];

onMounted(async () => {
  await Promise.all([loadPlaylists(), loadTrash()]);
});

const playable = computed(() => activeSongs.value);

function onPlay(i: number) {
  if (playable.value[i]) playFromList(playable.value, i);
}

function onRemove(song: Song) {
  if (!activePlaylist.value) return;
  removeSongFrom(activePlaylist.value.id, song);
}

function openTrash() {
  playlists.trashMode = true;
  loadTrash();
}

function exitTrash() {
  playlists.trashMode = false;
}

function playAll() {
  if (!playable.value.length) return toast.warn('歌单为空');
  playFromList(playable.value, 0);
}

function onExport() {
  exportActiveM3U();
}

/** 排序下拉：取值按 HTMLSelectElement 收窄 */
function onSortChange(e: Event) {
  if (e.target instanceof HTMLSelectElement) playlists.sort = e.target.value;
}

/** 封面加载失败时移除自身（与原内联 handler 等价，额外容忍 target 为空） */
function dropBrokenImg(e: Event): void {
  if (e.target instanceof HTMLElement) e.target.remove();
}
</script>

<template>
  <div class="pv">
    <aside class="side ly-card">
      <div class="side-head">
        <h2>我的歌单</h2>
        <button class="ly-icon-btn" title="新建歌单" aria-label="新建歌单" @click="createPlaylist">
          <Icon name="plus" />
        </button>
      </div>

      <button
        v-for="pl in playlists.lists" :key="pl.id"
        class="plitem" :class="{ on: !playlists.trashMode && playlists.activeId === pl.id }"
        @click="selectPlaylist(pl.id)"
      >
        <span class="plico" :class="{ fav: pl.id === 'favorites' }">
          <Icon :name="pl.id === 'favorites' ? 'heart' : 'playlist'" :size="15" />
        </span>
        <span class="pltx">
          <b>{{ pl.name }}</b>
          <small>{{ (pl.songs || []).length }} 首</small>
        </span>
      </button>

      <button class="plitem trash" :class="{ on: playlists.trashMode }" @click="openTrash">
        <span class="plico"><Icon name="trash" :size="15" /></span>
        <span class="pltx">
          <b>回收站</b>
          <small>{{ playlists.trash.length }} 个歌单</small>
        </span>
      </button>
    </aside>

    <section class="detail ly-card">
      <!-- 回收站 -->
      <template v-if="playlists.trashMode">
        <header class="head">
          <div>
            <h2>回收站</h2>
            <p>删除的歌单保留 30 天，之后自动清理</p>
          </div>
          <button class="ly-btn" @click="exitTrash">返回歌单</button>
        </header>
        <div class="body">
          <div v-if="!playlists.trash.length" class="ly-empty">
            <Icon name="trash" /><b>回收站为空</b>
          </div>
          <div v-else class="trash-list">
            <div v-for="t in playlists.trash" :key="t.id" class="trash-row">
              <span class="tico"><Icon name="playlist" :size="16" /></span>
              <div class="ttx">
                <b>{{ t.name }}</b>
                <small>{{ (t.songs || []).length }} 首 · 剩余 {{ t.daysLeft ?? '—' }} 天</small>
              </div>
              <button class="ly-btn ly-btn-sm" @click="restorePlaylist(t)">恢复</button>
              <button class="ly-btn ly-btn-sm ly-btn-danger" @click="purgePlaylist(t)">彻底删除</button>
            </div>
          </div>
        </div>
      </template>

      <!-- 歌单详情 -->
      <template v-else>
        <header class="head" v-if="activePlaylist">
          <div class="cover" :class="{ fav: activePlaylist.id === 'favorites' }">
            <img v-if="activePlaylist.cover" :src="activePlaylist.cover" alt="" @error="dropBrokenImg" />
            <Icon v-else :name="activePlaylist.id === 'favorites' ? 'heart' : 'playlist'" :size="28" />
          </div>
          <div class="htx">
            <h2>{{ activePlaylist.name }}</h2>
            <p>
              {{ activeSongs.length }} 首
              <template v-if="activePlaylist.updatedAt"> · 更新于 {{ new Date(activePlaylist.updatedAt).toLocaleDateString() }}</template>
              <template v-if="activePlaylist.system"> · 系统歌单</template>
            </p>
          </div>
          <div class="hacts">
            <button class="ly-btn ly-btn-primary" @click="playAll"><Icon name="play" :size="12" /> 播放全部</button>
            <button class="ly-btn" @click="downloadActive"><Icon name="download" :size="14" /> 下载全部</button>
            <button class="ly-btn" title="去重" @click="dedupeActive"><Icon name="layers" :size="14" /> 去重</button>
            <button class="ly-btn" title="复制 M3U 清单" @click="onExport"><Icon name="copy" :size="14" /> 导出</button>
            <button v-if="!activePlaylist.system" class="ly-btn" @click="renamePlaylist(activePlaylist)"><Icon name="edit" :size="14" /> 重命名</button>
            <button
              v-if="!activePlaylist.system" class="ly-btn ly-btn-danger"
              :aria-label="`删除歌单 ${activePlaylist.name}`" :title="`删除歌单 ${activePlaylist.name}`"
              @click="removePlaylist(activePlaylist)"
            ><Icon name="trash" :size="14" /></button>
            <button class="ly-btn" :class="{ 'ly-btn-primary': playlists.batchMode }" @click="playlists.batchMode = !playlists.batchMode; playlists.selected.clear()">
              <Icon name="check" :size="14" /> 选择
            </button>
          </div>
        </header>
        <header v-else class="head"><h2>暂无歌单</h2></header>

        <div class="tools">
          <div class="ly-search kw">
            <Icon name="search" :size="16" />
            <input v-model="playlists.keyword" placeholder="在歌单内搜索…" aria-label="歌单内搜索" />
          </div>
          <select class="ly-input sort" :value="playlists.sort" aria-label="排序" @change="onSortChange">
            <option v-for="s in SORTS" :key="s.id" :value="s.id">{{ s.label }}</option>
          </select>
          <button class="ly-btn" @click="createPlaylist"><Icon name="plus" :size="14" /> 新建歌单</button>
        </div>

        <div class="body">
          <SongTable
            :songs="activeSongs" :active-key="currentKey"
            :selected="playlists.batchMode ? playlists.selected : null" :batch-mode="playlists.batchMode"
            empty-text="歌单还没有歌曲"
            @play="onPlay" @select="toggleSelect"
          />
        </div>

        <footer v-if="playlists.batchMode" class="batch">
          <label class="all"><input type="checkbox" :checked="selectedCount > 0 && selectedCount >= activeSongs.length" @change="toggleSelectAll" /> 全选</label>
          <span class="ly-num">已选 {{ selectedCount }} 首</span>
          <button class="ly-btn ly-btn-danger" :disabled="!selectedCount" @click="removeSelected">从歌单移除</button>
          <button class="ly-btn ly-btn-ghost" @click="playlists.batchMode = false; playlists.selected.clear()">退出选择</button>
        </footer>
      </template>
    </section>
  </div>
</template>

<style scoped>
.pv { flex: 1; min-height: 0; display: grid; grid-template-columns: 250px 1fr; gap: var(--gap-app); }
.side { min-height: 0; display: flex; flex-direction: column; gap: 4px; padding: var(--sp-4) var(--sp-3); overflow-y: auto; }
.side-head { display: flex; align-items: center; justify-content: space-between; padding: 0 var(--sp-2) var(--sp-2); }
.side-head h2 { font-size: var(--fs-lg); font-weight: var(--fw-bold); }
.plitem {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: 8px var(--sp-3); border: 0; border-radius: var(--r-md);
  background: transparent; text-align: left; cursor: pointer; color: inherit;
  transition: background var(--dur-1);
}
.plitem:hover { background: var(--glass-3); }
.plitem.on { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent-line); }
.plico {
  width: 32px; height: 32px; flex-shrink: 0; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--glass-3); color: var(--ink-2);
}
.plico.fav { background: linear-gradient(135deg, rgba(255, 95, 176, .22), rgba(124, 92, 255, .2)); color: var(--au-3); }
.pltx { min-width: 0; display: flex; flex-direction: column; }
.pltx b { font-size: var(--fs-sm); font-weight: var(--fw-med); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pltx small { font-size: var(--fs-2xs); color: var(--ink-3); margin-top: 1px; }
.plitem.trash { margin-top: auto; border-top: 1px solid var(--hairline); padding-top: 10px; border-radius: 0; }

.detail { min-height: 0; display: flex; flex-direction: column; padding: var(--sp-4) var(--sp-5); overflow: hidden; }
.head { display: flex; align-items: center; gap: var(--sp-4); padding-bottom: var(--sp-3); }
.cover {
  width: 72px; height: 72px; flex-shrink: 0; border-radius: var(--r-lg);
  overflow: hidden; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, var(--glass-2), var(--accent-soft)); color: var(--ink-3);
}
.cover.fav { color: var(--au-3); background: linear-gradient(135deg, rgba(255, 95, 176, .25), rgba(124, 92, 255, .22)); }
.cover img { width: 100%; height: 100%; object-fit: cover; }
.htx { flex: 1; min-width: 0; }
.htx h2 { font-size: var(--fs-2xl); font-weight: var(--fw-black); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.htx p { margin-top: 3px; font-size: var(--fs-xs); color: var(--ink-3); }
.hacts { display: flex; gap: var(--sp-2); flex-wrap: wrap; justify-content: flex-end; }

.tools { display: flex; gap: var(--sp-2); align-items: center; padding: var(--sp-2) 0 var(--sp-3); border-bottom: 1px solid var(--hairline); }
.kw { flex: 1; min-width: 200px; }
.sort { width: 130px; flex-shrink: 0; height: 36px; }
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding-top: var(--sp-3); overflow: hidden; }
.batch { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--hairline); }
.batch .all { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--ink-2); }
.batch input { accent-color: var(--au-1); }

.trash-list { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.trash-row { display: flex; align-items: center; gap: var(--sp-3); padding: 10px var(--sp-3); border-radius: var(--r-md); }
.trash-row:hover { background: var(--glass-3); }
.tico { width: 34px; height: 34px; border-radius: 10px; background: var(--glass-3); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-3); }
.ttx { flex: 1; min-width: 0; }
.ttx b { display: block; font-size: var(--fs-sm); font-weight: var(--fw-med); }
.ttx small { font-size: var(--fs-2xs); color: var(--ink-3); }
</style>