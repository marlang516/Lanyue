<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import {
  downloads, queueStats, initDownloads, loadHistory, loadHistoryStats,
  cancelDownload, retryDownload, removeQueueItem, moveQueueItem, togglePauseQueue,
  clearFinished, clearAll, removeHistoryEntry, removeDeadEntries, clearHistory,
  historyNext, historyPrev, openHistoryItem,
} from '../stores/download';
import type { AddQueueResult, DownloadHistoryItem, DownloadTask } from '../stores/types';
import { callSafe } from '../core/bridge';
import { confirmDialog } from '../core/dialog';
import { fmtSize, fmtDuration, platformName, timeAgo } from '../core/format';
import { toast } from '../core/toast';
import Icon from '../components/common/Icon.vue';

const tab = ref('queue');
const historyKeyword = ref('');

/** 队列/历史状态徽标：缺失状态回退为原值展示 */
const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '等待中', cls: '' },
  downloading: { label: '下载中', cls: 'ly-tag-accent' },
  done: { label: '已完成', cls: 'ly-tag-ok' },
  error: { label: '失败', cls: 'ly-tag-danger' },
};

const HIST_SORTS = [
  { id: 'recent', label: '最近完成' },
  { id: 'oldest', label: '最早完成' },
  { id: 'title', label: '歌名' },
  { id: 'artist', label: '歌手' },
  { id: 'size', label: '大小' },
];

const histPages = computed(() => Math.max(1, Math.ceil(downloads.history.total / downloads.history.limit)));

onMounted(async () => {
  initDownloads();
  await Promise.all([loadHistory(1), loadHistoryStats()]);
});

function switchTab(t: string) {
  tab.value = t;
  if (t === 'history') loadHistory(1);
}

function prog(q: DownloadTask) {
  const p = downloads.progress[q.taskId];
  if (p) return p.progress;
  return Number(q.progress) || 0;
}
function speedOf(q: DownloadTask) {
  const p = downloads.progress[q.taskId];
  if (!p || !p.speedBps) return '';
  return `${(p.speedBps / 1024 / 1024).toFixed(2)} MB/s`;
}
function etaOf(q: DownloadTask) {
  const p = downloads.progress[q.taskId];
  if (!p || !Number.isFinite(p.etaSec)) return '';
  return `剩余 ${fmtDuration(p.etaSec)}`;
}

async function onClearAll() {
  const ok = await confirmDialog({ title: '清空下载队列', body: '正在下载的任务会被取消，确定继续？', danger: true, okText: '清空' });
  if (!ok) return;
  await clearAll();
}

async function onClearFinished() {
  await clearFinished();
}

async function onClearHistory() {
  const ok = await confirmDialog({ title: '清空下载历史', body: '只删除历史记录，不会删除磁盘上的音乐文件。', danger: true, okText: '清空历史' });
  if (!ok) return;
  await clearHistory();
}

async function onRemoveDead() {
  const n = (downloads.history.deadEntries || []).length;
  if (!n) return toast.info('没有失联记录');
  await removeDeadEntries();
  toast.success(`已清理 ${n} 条失联记录`);
}

function searchHistory() {
  downloads.history.keyword = historyKeyword.value;
  loadHistory(1);
}

/** 历史筛选下拉：取值按 HTMLSelectElement 收窄，随后立即重查第一页 */
function onHistoryStatusChange(e: Event) {
  if (!(e.target instanceof HTMLSelectElement)) return;
  downloads.history.status = e.target.value;
  loadHistory(1);
}

function onHistorySortChange(e: Event) {
  if (!(e.target instanceof HTMLSelectElement)) return;
  downloads.history.sort = e.target.value;
  loadHistory(1);
}

async function redownload(item: DownloadHistoryItem) {
  const r = await callSafe<AddQueueResult>('addToQueue', [{
    id: item.id, source: item.source, title: item.title, artist: item.artist,
    album: item.album, duration: item.duration, cover: item.cover, forceRedownload: true,
  }], null);
  if (r && r.queued) toast.success('已重新加入下载队列');
  else toast.warn((r && (r.error || '该任务已在队列中')) || '加入失败');
}

/** 封面加载失败时移除自身（与原内联 handler 等价，额外容忍 target 为空） */
function dropBrokenImg(e: Event): void {
  if (e.target instanceof HTMLElement) e.target.remove();
}
</script>

<template>
  <div class="dv">
    <section class="head ly-card">
      <div class="htx">
        <h2>下载管理</h2>
        <p>
          {{ queueStats.total }} 个任务 · 下载中 {{ queueStats.downloading }} · 等待 {{ queueStats.pending }}
          <template v-if="queueStats.error"> · 失败 {{ queueStats.error }}</template>
        </p>
      </div>

      <div class="tabs ly-seg">
        <button :class="{ on: tab === 'queue' }" @click="switchTab('queue')">队列</button>
        <button :class="{ on: tab === 'history' }" @click="switchTab('history')">历史</button>
      </div>

      <div class="acts">
        <template v-if="tab === 'queue'">
          <button class="ly-btn" @click="togglePauseQueue">
            <Icon :name="downloads.paused ? 'play' : 'pause'" :size="13" />
            {{ downloads.paused ? '继续' : '暂停' }}
          </button>
          <button class="ly-btn" @click="onClearFinished">清空已完成</button>
          <button class="ly-btn ly-btn-danger" @click="onClearAll">清空队列</button>
        </template>
        <template v-else>
          <button class="ly-btn" @click="loadHistory(1); loadHistoryStats()">刷新</button>
          <button class="ly-btn" :disabled="!(downloads.history.deadEntries || []).length" @click="onRemoveDead">
            清理失联
          </button>
          <button class="ly-btn ly-btn-danger" @click="onClearHistory">清空历史</button>
        </template>
      </div>
    </section>

    <!-- 队列 -->
    <section v-if="tab === 'queue'" class="body ly-card">
      <div v-if="!downloads.queue.length" class="ly-empty">
        <Icon name="download" />
        <b>下载队列为空</b>
        <p>在搜索、歌单或发现页点「下载」即可加入队列</p>
      </div>

      <div v-else class="qlist">
        <div v-for="q in downloads.queue" :key="q.taskId" class="qrow" :class="q.status">
          <div class="cov" :class="{ ph: !q.cover }">
            <img v-if="q.cover" :src="q.cover" alt="" @error="dropBrokenImg" />
            <Icon v-else name="music" :size="16" />
          </div>

          <div class="qmeta">
            <div class="qt">
              <span class="title">{{ q.title || q.fileName || '未命名' }}</span>
              <span class="ly-tag" :class="STATUS[q.status]?.cls">{{ STATUS[q.status]?.label || q.status }}</span>
            </div>
            <div class="qa">{{ q.artist || '' }}<template v-if="q.album"> · {{ q.album }}</template> · {{ platformName(q.source) }}</div>

            <div v-if="q.status === 'downloading'" class="pg">
              <div class="pbar"><i :style="{ width: prog(q) + '%' }"></i></div>
              <span class="pnum">{{ Math.round(prog(q)) }}%</span>
              <span v-if="speedOf(q)" class="pmeta">{{ speedOf(q) }}</span>
              <span v-if="etaOf(q)" class="pmeta">{{ etaOf(q) }}</span>
            </div>
            <div v-else-if="q.status === 'done'" class="qdone">
              <span class="pmeta">已保存 {{ q.savePath || q.filePath || '到下载目录' }}</span>
            </div>
            <div v-else-if="q.status === 'error'" class="qerr">{{ q.error || '下载失败' }}</div>
          </div>

          <div class="qact">
            <template v-if="q.status === 'pending'">
              <button class="ly-icon-btn" title="置顶" aria-label="置顶" @click="moveQueueItem(q.taskId, 'top')"><Icon name="upload" :size="14" /></button>
              <button class="ly-icon-btn" title="上移" aria-label="上移" @click="moveQueueItem(q.taskId, 'up')"><Icon name="chevron-down" :size="14" class="flip" /></button>
              <button class="ly-icon-btn" title="下移" aria-label="下移" @click="moveQueueItem(q.taskId, 'down')"><Icon name="chevron-down" :size="14" /></button>
            </template>
            <button
              v-if="q.status === 'pending' || q.status === 'downloading'"
              class="ly-icon-btn" title="取消" aria-label="取消" @click="cancelDownload(q.taskId)"
            ><Icon name="x" :size="14" /></button>
            <button
              v-if="q.status === 'error'"
              class="ly-icon-btn" title="重试" aria-label="重试" @click="retryDownload(q.taskId)"
            ><Icon name="refresh" :size="14" /></button>
            <button
              v-if="q.status === 'done'"
              class="ly-icon-btn" title="打开文件位置" aria-label="打开文件位置" @click="openHistoryItem({ savePath: q.savePath || q.filePath })"
            ><Icon name="folder" :size="14" /></button>
            <button class="ly-icon-btn danger" title="移除" aria-label="移除" @click="removeQueueItem(q.taskId)">
              <Icon name="trash" :size="14" />
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 历史 -->
    <section v-else class="body ly-card">
      <div class="htools">
        <form class="ly-search hkw" @submit.prevent="searchHistory">
          <Icon name="search" :size="16" />
          <input v-model="historyKeyword" placeholder="搜索历史歌名、歌手、专辑…" aria-label="搜索历史" />
        </form>
        <select class="ly-input st" :value="downloads.history.status" aria-label="状态" @change="onHistoryStatusChange">
          <option value="all">全部状态</option>
          <option value="done">已完成</option>
          <option value="error">失败</option>
        </select>
        <select class="ly-input so" :value="downloads.history.sort" aria-label="排序" @change="onHistorySortChange">
          <option v-for="o in HIST_SORTS" :key="o.id" :value="o.id">{{ o.label }}</option>
        </select>
      </div>

      <div class="hcontent">
        <div v-if="downloads.history.loading" class="skels">
          <div v-for="n in 8" :key="n" class="ly-skeleton" style="height: 52px"></div>
        </div>

        <div v-else-if="downloads.history.error" class="ly-empty">
          <Icon name="warning" /><b>{{ downloads.history.error }}</b>
          <button class="ly-btn ly-btn-sm" @click="loadHistory(1)">重试</button>
        </div>

        <div v-else-if="!downloads.history.items.length" class="ly-empty">
          <Icon name="clock" />
          <b>暂无下载历史</b>
          <p>成功或失败的下载都会记录在这里</p>
        </div>

        <div v-else class="hlist">
          <div v-for="h in downloads.history.items" :key="h.source + ':' + h.id" class="hrow">
            <div class="cov" :class="{ ph: !h.cover }">
              <img v-if="h.cover" :src="h.cover" alt="" @error="dropBrokenImg" />
              <Icon v-else name="music" :size="16" />
            </div>
            <div class="hmeta">
              <div class="ht">
                <span class="title">{{ h.title || '未命名' }}</span>
                <span class="ly-tag" :class="STATUS[h.status || '']?.cls">{{ STATUS[h.status || '']?.label || h.status }}</span>
                <span v-if="h.missing" class="ly-tag ly-tag-warn">文件已失联</span>
              </div>
              <div class="ha">{{ h.artist || '未知歌手' }} · {{ platformName(h.source) }}<template v-if="h.album"> · {{ h.album }}</template></div>
            </div>
            <span class="hsize ly-num">{{ h.size ? fmtSize(h.size) : '—' }}</span>
            <span class="htime">{{ h.finishedAt ? timeAgo(h.finishedAt) : '—' }}</span>
            <div class="hact">
              <button class="ly-icon-btn" title="打开文件位置" aria-label="打开文件位置" :disabled="!h.savePath" @click="openHistoryItem(h)">
                <Icon name="folder" :size="14" />
              </button>
              <button class="ly-icon-btn" title="重新下载" aria-label="重新下载" @click="redownload(h)">
                <Icon name="download" :size="14" />
              </button>
              <button class="ly-icon-btn danger" title="删除记录" aria-label="删除记录" @click="removeHistoryEntry(h)">
                <Icon name="trash" :size="14" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <footer class="pager">
        <button class="ly-btn ly-btn-sm" :disabled="downloads.history.page <= 1" @click="historyPrev">上一页</button>
        <span class="ly-num">{{ downloads.history.page }} / {{ histPages }} 页 · 共 {{ downloads.history.total }} 条</span>
        <button class="ly-btn ly-btn-sm" :disabled="downloads.history.page >= histPages" @click="historyNext">下一页</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.dv { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--gap-app); }
.head { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-4); padding: var(--sp-4) var(--sp-5); }
.htx { flex: 1; min-width: 0; }
.htx h2 { font-size: var(--fs-xl); font-weight: var(--fw-bold); }
.htx p { margin-top: 2px; font-size: var(--fs-xs); color: var(--ink-3); }
.acts { display: flex; gap: var(--sp-2); }

.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: var(--sp-4) var(--sp-5); overflow: hidden; }
.qlist, .hlist { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }

.qrow, .hrow {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: 8px var(--sp-3); border-radius: var(--r-md);
}
.qrow:hover, .hrow:hover { background: var(--glass-3); }
.cov { width: 42px; height: 42px; flex-shrink: 0; border-radius: 10px; overflow: hidden; background: var(--glass-3); display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
.cov img { width: 100%; height: 100%; object-fit: cover; }
.cov.ph { background: linear-gradient(135deg, var(--glass-2), var(--accent-soft)); }
.qmeta, .hmeta { flex: 1; min-width: 0; }
.qt, .ht { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.title { font-size: var(--fs-sm); font-weight: var(--fw-med); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qa, .ha { margin-top: 2px; font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pg { display: flex; align-items: center; gap: var(--sp-2); margin-top: 6px; }
.pbar { flex: 1; max-width: 420px; height: 4px; border-radius: var(--r-full); background: var(--hairline); overflow: hidden; }
.pbar i { display: block; height: 100%; background: var(--au-grad); border-radius: var(--r-full); transition: width .25s linear; }
.pnum { width: 38px; flex-shrink: 0; font-size: var(--fs-xs); color: var(--ink-2); font-variant-numeric: tabular-nums; text-align: right; }
.pmeta { font-size: var(--fs-2xs); color: var(--ink-3); white-space: nowrap; }
.qdone .pmeta { display: block; margin-top: 5px; font-size: var(--fs-2xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qerr { margin-top: 5px; font-size: var(--fs-xs); color: var(--danger); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qact, .hact { display: flex; gap: 0; flex-shrink: 0; }
.qact .danger:hover, .hact .danger:hover { color: var(--danger); background: rgba(229, 72, 77, .1); }
.flip { transform: rotate(180deg); }

.htools { display: flex; gap: var(--sp-2); padding-bottom: var(--sp-3); }
.hkw { flex: 1; min-width: 220px; }
.st { width: 130px; flex-shrink: 0; height: 36px; }
.so { width: 130px; flex-shrink: 0; height: 36px; }
.hcontent { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.skels { display: flex; flex-direction: column; gap: var(--sp-2); }
.hsize { width: 72px; flex-shrink: 0; text-align: right; font-size: var(--fs-xs); color: var(--ink-2); }
.htime { width: 82px; flex-shrink: 0; text-align: right; font-size: var(--fs-2xs); color: var(--ink-3); }
.pager { flex-shrink: 0; display: flex; align-items: center; justify-content: center; gap: var(--sp-4); padding-top: var(--sp-3); border-top: 1px solid var(--hairline); font-size: var(--fs-sm); color: var(--ink-2); }
</style>