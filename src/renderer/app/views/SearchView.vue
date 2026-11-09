<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import {
  search, initSearch, doSearch, setType, setSource, cycleSort,
  toggleSelect, toggleSelectAll, selectedCount, visibleSongs, detailSongs,
  openAlbum, openSinger, switchSingerTab, backToResults, goPage,
  downloadSelected, addSelectedToQueue, clearHistory, removeHistoryItem,
  downloadSongs,
} from '../stores/search';
import type { SearchAlbum, SearchSinger } from '../stores/types';
import type { SongLike } from '../core/song';
import { player, currentKey, setQuality, playFromList, appendToQueue } from '../stores/player';
import { ui } from '../stores/ui';
import { fmtDuration, platformName, qualityLabel } from '../core/format';
import { toast } from '../core/toast';
import SongTable from '../components/data/SongTable.vue';
import Icon from '../components/common/Icon.vue';

const kwInput = ref(search.keyword || '');
const showHistory = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);
let blurTimer: ReturnType<typeof setTimeout> | undefined;

const TYPES = [
  { id: 'song', label: '单曲', icon: 'music' },
  { id: 'album', label: '专辑', icon: 'disc' },
  { id: 'singer', label: '歌手', icon: 'mic' },
];

const sortLabel = computed(() => ({
  default: '默认序',
  duration: '时长',
  source: '来源',
}[search.sort] || '默认序'));

const listForPlay = computed(() => (search.detail ? detailSongs.value : visibleSongs.value));

const resultTitle = computed(() => {
  if (search.detail) return search.detail.name;
  return search.keyword ? `“${search.keyword}” 的搜索结果` : '搜索';
});

onMounted(async () => {
  await initSearch();
  consumePending();
});

watch(() => ui.pendingSearch, consumePending);

function consumePending() {
  const seed = String(ui.pendingSearch || '').trim();
  if (!seed) return;
  ui.pendingSearch = '';
  kwInput.value = seed;
  search.keyword = seed;
  search.detail = null;
  doSearch(1);
}

function submit() {
  const kw = kwInput.value.trim();
  if (!kw) return;
  search.keyword = kw;
  showHistory.value = false;
  doSearch(1);
}

function switchType(t: string) {
  setType(t);
  if (search.keyword) doSearch(1);
}

function changeSource(e: Event) {
  if (!(e.target instanceof HTMLSelectElement)) return;
  setSource(e.target.value);
  if (search.keyword) doSearch(1);
}

function changeQuality(e: Event) {
  if (e.target instanceof HTMLSelectElement) setQuality(e.target.value);
}

function pickHistory(h: string) {
  kwInput.value = h;
  submit();
}

function hideHistorySoon() {
  clearTimeout(blurTimer);
  blurTimer = setTimeout(() => { showHistory.value = false; }, 160);
}

function keepHistory() {
  clearTimeout(blurTimer);
  showHistory.value = true;
}

function playAt(i: number) {
  const list = listForPlay.value;
  if (list[i]) playFromList(list, i);
}

function onQueue(song: SongLike) {
  const n = appendToQueue([song]);
  toast.success(`已加入队列 ${n} 首`);
}

async function onDownload(song: SongLike) {
  await downloadSongs([song]);
}

function playAllDetail() {
  if (!detailSongs.value.length) return;
  playFromList(detailSongs.value, 0);
}

async function downloadAllDetail() {
  if (!detailSongs.value.length) return;
  await downloadSongs(detailSongs.value);
}

function onAlbumRow(a: SearchAlbum) {
  openAlbum(a.mid, a.source || search.source || 'qq');
}

function onSingerRow(s: SearchSinger) {
  openSinger(s.mid, s.name, s.source || search.source || 'qq');
}

function exitBatch() {
  search.batchMode = false;
  search.selected.clear();
}

/** 封面加载失败时移除自身（与原内联 handler 等价，额外容忍 target 为空） */
function dropBrokenImg(e: Event): void {
  if (e.target instanceof HTMLElement) e.target.remove();
}
</script>

<template>
  <div class="sv">
    <!-- 搜索工具条 -->
    <section class="bar ly-card">
      <div class="row">
        <div class="types ly-seg" role="tablist" aria-label="搜索类型">
          <button
            v-for="t in TYPES" :key="t.id"
            :class="{ on: search.type === t.id }" role="tab"
            :aria-selected="search.type === t.id"
            @click="switchType(t.id)"
          >
            {{ t.label }}
          </button>
        </div>

        <form class="ly-search input-wrap" role="search" @submit.prevent="submit">
          <Icon name="search" :size="16" />
          <input
            ref="inputEl"
            v-model="kwInput"
            placeholder="搜索歌曲、歌手、专辑…（支持直接粘贴平台链接）"
            aria-label="搜索关键词"
            @focus="keepHistory"
            @blur="hideHistorySoon"
            @keydown.enter.prevent="submit"
          />
          <button class="ly-btn ly-btn-sm ly-btn-primary" type="submit">搜索</button>

          <Transition name="ly-pop">
            <div v-if="showHistory && search.history.length && !search.keyword" class="history" @mousedown.prevent>
              <header>
                <span>最近搜索</span>
                <button class="ly-btn ly-btn-sm ly-btn-ghost" @click="clearHistory">清空</button>
              </header>
              <div class="hlist">
                <div v-for="h in search.history" :key="h" class="hitem">
                  <button class="hbtn" @mousedown.prevent="pickHistory(h)">
                    <Icon name="clock" :size="13" /> {{ h }}
                  </button>
                  <button class="hdel" aria-label="移除" @mousedown.prevent="removeHistoryItem(h)">
                    <Icon name="x" :size="11" />
                  </button>
                </div>
              </div>
            </div>
          </Transition>
        </form>

        <select class="ly-input src" :value="search.source" aria-label="平台" @change="changeSource">
          <option value="all">全部平台</option>
          <option v-for="p in search.platforms" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>

        <select class="ly-input q" :value="player.quality" aria-label="音质" @change="changeQuality">
          <option value="standard">{{ qualityLabel('standard') }} 128k</option>
          <option value="hq">{{ qualityLabel('hq') }} 320k</option>
          <option value="lossless">{{ qualityLabel('lossless') }} FLAC</option>
        </select>

        <button class="ly-btn" :title="'排序：' + sortLabel" @click="cycleSort">
          <Icon name="sort" :size="14" /> {{ sortLabel }}
        </button>

        <button
          class="ly-btn" :class="{ 'ly-btn-primary': search.batchMode }"
          :aria-pressed="search.batchMode"
          :disabled="search.type !== 'song' || !!search.detail"
          @click="search.batchMode = !search.batchMode; search.selected.clear()"
        >
          <Icon name="check" :size="14" /> 选择
        </button>
      </div>
    </section>

    <!-- 结果区 -->
    <section class="res ly-card">
      <header class="res-head">
        <div class="rh-tx">
          <button v-if="search.detail" class="ly-btn ly-btn-sm" @click="backToResults">
            <Icon name="chevron-left" :size="13" /> 返回
          </button>
          <div>
            <h2>{{ resultTitle }}</h2>
            <p v-if="search.detail">
              {{ search.detail.kind === 'album' ? '专辑' : '歌手' }} ·
              {{ platformName(search.detail.source) }}
            </p>
            <p v-else-if="search.keyword">{{ search.total }} 条结果 · {{ search.type === 'song' ? '单曲' : search.type === 'album' ? '专辑' : '歌手' }}</p>
            <p v-else>输入关键词开始搜索，支持多平台聚合</p>
          </div>
        </div>

        <div v-if="search.detail" class="rh-acts">
          <button class="ly-btn ly-btn-primary" :disabled="!detailSongs.length" @click="playAllDetail">
            <Icon name="play" :size="12" /> 播放全部
          </button>
          <button class="ly-btn" :disabled="!detailSongs.length" @click="downloadAllDetail">
            <Icon name="download" :size="14" /> 下载全部
          </button>
          <button
            v-if="search.detail.kind === 'singer'"
            class="ly-btn" @click="appendToQueue(detailSongs); toast.success('已加入播放队列')"
          >
            <Icon name="plus" :size="14" /> 加入队列
          </button>
        </div>
      </header>

      <!-- 详情：歌手页签 -->
      <div v-if="search.detail && search.detail.kind === 'singer'" class="detail-tabs">
        <button
          class="ly-btn ly-btn-sm" :class="{ 'ly-btn-primary': search.singerTab === 'songs' }"
          @click="switchSingerTab('songs')"
        >热门歌曲</button>
        <button
          class="ly-btn ly-btn-sm" :class="{ 'ly-btn-primary': search.singerTab === 'albums' }"
          @click="switchSingerTab('albums')"
        >全部专辑</button>
      </div>

      <div class="res-body">
        <!-- 加载 -->
        <div v-if="search.loading || (search.detail && search.detail.loading)" class="skels">
          <div v-for="n in 8" :key="n" class="ly-skeleton" style="height: 52px"></div>
        </div>

        <!-- 错误 / 空 -->
        <div v-else-if="search.detail && search.detail.error" class="ly-empty">
          <Icon name="warning" />
          <b>{{ search.detail.error }}</b>
          <button class="ly-btn ly-btn-sm" @click="backToResults">返回结果</button>
        </div>
        <div v-else-if="!search.detail && search.error" class="ly-empty">
          <Icon name="search" />
          <b>{{ search.error }}</b>
          <p>试试更短的关键词，或切换平台</p>
        </div>

        <!-- 专辑详情 -->
        <SongTable
          v-else-if="search.detail && search.detail.kind === 'album'"
          :songs="detailSongs" :active-key="currentKey"
          :selected="search.batchMode ? search.selected : null" :batch-mode="search.batchMode"
          @play="playAt" @queue="onQueue" @download="onDownload" @select="toggleSelect"
        />

        <!-- 歌手详情 -->
        <template v-else-if="search.detail && search.detail.kind === 'singer'">
          <SongTable
            v-if="search.singerTab === 'songs'"
            :songs="detailSongs" :active-key="currentKey" empty-text="暂无歌曲"
            @play="playAt" @queue="onQueue" @download="onDownload"
          />
          <div v-else class="album-grid">
            <button v-for="a in search.detail.albums" :key="a.mid + a.source" class="acard" @click="onAlbumRow(a)">
              <div class="acov" :class="{ ph: !a.cover }">
                <img v-if="a.cover" :src="a.cover" alt="" loading="lazy" @error="dropBrokenImg" />
                <Icon v-else name="disc" :size="22" />
              </div>
              <div class="at">{{ a.title }}</div>
              <div class="am">{{ a.artist }}<template v-if="a.publishTime"> · {{ a.publishTime }}</template></div>
            </button>
            <div v-if="!search.detail.albums?.length" class="ly-empty"><Icon name="disc" /><b>暂无专辑</b></div>
          </div>
        </template>

        <!-- 搜索结果 -->
        <template v-else>
          <SongTable
            v-if="search.type === 'song' && search.songs.length"
            :songs="visibleSongs" :active-key="currentKey"
            :selected="search.batchMode ? search.selected : null" :batch-mode="search.batchMode"
            @play="playAt" @queue="onQueue" @download="onDownload" @select="toggleSelect"
          />

          <div v-else-if="search.type === 'album'" class="album-list">
            <button v-for="a in search.albums" :key="a.mid + a.source" class="arow" @dblclick="onAlbumRow(a)" @click="onAlbumRow(a)">
              <div class="acov sm" :class="{ ph: !a.cover }">
                <img v-if="a.cover" :src="a.cover" alt="" loading="lazy" @error="dropBrokenImg" />
                <Icon v-else name="disc" :size="18" />
              </div>
              <div class="atx">
                <div class="at">{{ a.title }}</div>
                <div class="am">{{ a.artist }}<template v-if="a.songCount"> · {{ a.songCount }} 首</template><template v-if="a.publishTime"> · {{ a.publishTime }}</template></div>
              </div>
              <span class="ly-tag">{{ platformName(a.source) }}</span>
              <Icon name="chevron-right" :size="14" class="arrow" />
            </button>
            <div v-if="!search.albums.length" class="ly-empty"><Icon name="disc" /><b>没有匹配专辑</b></div>
          </div>

          <div v-else class="singer-list">
            <button v-for="s in search.singers" :key="s.mid + s.source" class="srow" @click="onSingerRow(s)">
              <div class="avatar" :class="{ ph: !s.avatar }">
                <img v-if="s.avatar" :src="s.avatar" alt="" loading="lazy" @error="dropBrokenImg" />
                <Icon v-else name="mic" :size="18" />
              </div>
              <div class="atx">
                <div class="at">{{ s.name }}</div>
                <div class="am">歌曲 {{ s.songCount || 0 }} · 专辑 {{ s.albumCount || 0 }} · MV {{ s.mvCount || 0 }}</div>
              </div>
              <span class="ly-tag">{{ platformName(s.source) }}</span>
              <Icon name="chevron-right" :size="14" class="arrow" />
            </button>
            <div v-if="!search.singers.length" class="ly-empty"><Icon name="mic" /><b>没有匹配歌手</b></div>
          </div>

          <!-- 欢迎态 -->
          <div v-if="!search.keyword" class="ly-empty welcome">
            <Icon name="music" />
            <b>输入关键词开始搜索</b>
            <p>支持歌名、歌手、专辑，多平台同时检索</p>
            <div class="quick">
              <button v-for="w in ['周杰伦', 'Taylor Swift', '轻音乐', 'LoFi']" :key="w" class="ly-btn ly-btn-sm" @click="kwInput = w; submit()">{{ w }}</button>
            </div>
          </div>
        </template>
      </div>

      <!-- 分页 -->
      <footer v-if="!search.detail && search.keyword && !search.loading && !search.error" class="pager">
        <button class="ly-btn ly-btn-sm" :disabled="search.page <= 1" @click="goPage(-1)">上一页</button>
        <span class="ly-num">第 {{ search.page }} 页</span>
        <button class="ly-btn ly-btn-sm" :disabled="!search.hasNext" @click="goPage(1)">下一页</button>
      </footer>

      <!-- 批量工具栏 -->
      <footer v-if="search.batchMode && !search.detail" class="batch">
        <label class="all"><input type="checkbox" :checked="selectedCount > 0 && selectedCount >= visibleSongs.length" @change="toggleSelectAll" /> 全选</label>
        <span class="ly-num">已选 {{ selectedCount }} 首</span>
        <button class="ly-btn ly-btn-primary" :disabled="!selectedCount" @click="downloadSelected">加入下载队列</button>
        <button class="ly-btn" :disabled="!selectedCount" @click="addSelectedToQueue">加入播放队列</button>
        <button class="ly-btn ly-btn-ghost" @click="exitBatch">退出选择</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.sv { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--gap-app); }
.bar { flex-shrink: 0; padding: var(--sp-3) var(--sp-4); }
.row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.types button { display: inline-flex; align-items: center; gap: 4px; }
.input-wrap { flex: 1; min-width: 260px; }
.history {
  position: absolute; left: 0; right: 0; top: calc(100% + 6px);
  z-index: var(--z-popover);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--glass-3); backdrop-filter: blur(20px);
  border: 1px solid var(--stroke); box-shadow: var(--shadow-pop);
}
.input-wrap { position: relative; }
.history header { display: flex; align-items: center; justify-content: space-between; padding-bottom: var(--sp-2); font-size: var(--fs-xs); color: var(--ink-3); }
.hlist { display: flex; flex-direction: column; gap: 1px; max-height: 240px; overflow-y: auto; }
.hitem { display: flex; align-items: center; }
.hbtn {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-2);
  padding: 7px var(--sp-2); border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--ink-2); text-align: left;
  font-size: var(--fs-sm); cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hbtn:hover { background: var(--glass-2); color: var(--ink); }
.hdel { width: 24px; height: 24px; border: 0; border-radius: var(--r-xs); background: transparent; color: var(--ink-3); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.hdel:hover { color: var(--danger); background: rgba(229, 72, 77, .1); }
.src { width: 128px; flex-shrink: 0; height: 36px; }
.q { width: 128px; flex-shrink: 0; height: 36px; }

.res { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: var(--sp-4) var(--sp-5); overflow: hidden; }
.res-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-4); padding-bottom: var(--sp-3); }
.rh-tx { display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
.rh-tx h2 { font-size: var(--fs-xl); font-weight: var(--fw-bold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rh-tx p { margin-top: 2px; font-size: var(--fs-xs); color: var(--ink-3); }
.rh-acts { display: flex; gap: var(--sp-2); flex-shrink: 0; }
.detail-tabs { display: flex; gap: var(--sp-2); padding-bottom: var(--sp-3); border-bottom: 1px solid var(--hairline); }
.res-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding-top: var(--sp-3); overflow-y: auto; }
.skels { display: flex; flex-direction: column; gap: var(--sp-2); }

.album-list, .singer-list { display: flex; flex-direction: column; gap: 2px; }
.arow, .srow {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: 8px var(--sp-3); border: 0; border-radius: var(--r-md);
  background: transparent; text-align: left; cursor: pointer; color: inherit;
  transition: background var(--dur-1);
}
.arow:hover, .srow:hover { background: var(--glass-3); }
.acov {
  width: 48px; height: 48px; flex-shrink: 0; border-radius: 10px; overflow: hidden;
  background: var(--glass-3); display: flex; align-items: center; justify-content: center; color: var(--ink-3);
}
.acov.sm { width: 44px; height: 44px; }
.acov img { width: 100%; height: 100%; object-fit: cover; }
.acov.ph, .avatar.ph { background: linear-gradient(135deg, var(--glass-2), var(--accent-soft)); }
.atx { flex: 1; min-width: 0; }
.at { font-size: var(--fs-sm); font-weight: var(--fw-med); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.am { margin-top: 2px; font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.arrow { color: var(--ink-3); flex-shrink: 0; }

.avatar { width: 48px; height: 48px; flex-shrink: 0; border-radius: 50%; overflow: hidden; background: var(--glass-3); display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
.avatar img { width: 100%; height: 100%; object-fit: cover; }

.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--sp-4); overflow-y: auto; }
.acard { display: flex; flex-direction: column; gap: var(--sp-2); border: 0; background: transparent; text-align: left; cursor: pointer; min-width: 0; color: inherit; }
.acard .acov { width: 100%; aspect-ratio: 1 / 1; height: auto; border-radius: var(--r-md); }
.acard:hover .acov { box-shadow: var(--shadow-pop); }

.welcome { margin: auto; }
.quick { display: flex; gap: var(--sp-2); margin-top: var(--sp-2); }

.pager { flex-shrink: 0; display: flex; align-items: center; justify-content: center; gap: var(--sp-4); padding-top: var(--sp-3); border-top: 1px solid var(--hairline); font-size: var(--fs-sm); color: var(--ink-2); }
.batch {
  flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-3);
  padding-top: var(--sp-3); border-top: 1px solid var(--hairline);
}
.batch .all { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--ink-2); }
.batch input { accent-color: var(--au-1); }
</style>