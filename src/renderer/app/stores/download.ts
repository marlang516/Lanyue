/**
 * stores/download.ts —— 下载队列与下载历史
 *
 * 队列真相在主进程：这里只消费 queue-updated 整表快照 + download-progress
 * 增量进度。历史是服务端分页（limit/offset + 白名单排序），不整表拉到前端。
 */
import { reactive, computed } from 'vue';
import type { ComputedRef } from 'vue';
import { call, callSafe, on } from '../core/bridge';
import { toast, errText } from '../core/toast';
import type {
  DownloadErrorEvent,
  DownloadHistoryItem,
  DownloadHistoryState,
  DownloadProgress,
  DownloadProgressEvent,
  DownloadTask,
  HistoryQueryResult,
  HistoryStats,
  QueueMutationResult,
  QueueStats,
} from './types';

/** 下载域状态 */
interface DownloadsState {
  queue: DownloadTask[];
  paused: boolean;
  synced: boolean;
  /** taskId → 增量进度 */
  progress: Record<string, DownloadProgress>;
  history: DownloadHistoryState;
  stats: HistoryStats | null;
}

export const downloads = reactive<DownloadsState>({
  queue: [],
  paused: false,
  synced: false,
  progress: {},          // taskId → { progress, speedBps, etaSec, receivedBytes, totalBytes }
  history: {
    items: [],
    total: 0,
    page: 1,
    limit: 50,
    keyword: '',
    status: 'all',
    sort: 'recent',
    loading: false,
    error: '',
  },
  stats: null,
});

export const queueStats: ComputedRef<QueueStats> = computed(() => {
  const out: QueueStats = { total: downloads.queue.length, pending: 0, downloading: 0, done: 0, error: 0 };
  for (const q of downloads.queue) {
    const key = String(q.status);
    // 与原实现一致：只对统计表里已存在的键自增（键集合写死在上面）
    if (out[key as keyof QueueStats] !== undefined) {
      (out as Record<keyof QueueStats, number>)[key as keyof QueueStats] += 1;
    }
  }
  return out;
});

export const activeQueue: ComputedRef<DownloadTask[]> = computed(
  () => downloads.queue.filter((q) => q.status !== 'done'),
);

let started = false;

export function initDownloads(): void {
  if (started) return;
  started = true;
  on('onQueueUpdated', (list: unknown) => {
    downloads.queue = Array.isArray(list) ? (list as DownloadTask[]) : [];
    downloads.synced = true;
    // 快照里的终态会覆盖进度缓存
    for (const q of downloads.queue) {
      if (q.status === 'done' || q.status === 'error') delete downloads.progress[q.taskId];
    }
  });
  on('onQueuePausedChanged', (paused: unknown) => {
    downloads.paused = !!paused;
  });
  on('onDownloadProgress', (raw: unknown) => {
    const p = asRecord(raw) as DownloadProgressEvent | null;
    if (!p || !p.id) return;
    const id = p.id;
    downloads.progress[String(id)] = {
      progress: Number(p.progress) || 0,
      speedBps: Number(p.speedBps) || 0,
      etaSec: Number.isFinite(p.etaSec) ? (p.etaSec as number) : null,
      receivedBytes: Number(p.receivedBytes) || 0,
      totalBytes: Number(p.totalBytes) || 0,
    };
    const item = downloads.queue.find((q) => q.taskId === id);
    if (item && item.status !== 'done') item.status = 'downloading';
  });
  on('onDownloadError', (raw: unknown) => {
    const e = asRecord(raw) as DownloadErrorEvent | null;
    if (!e) return;
    const taskId = e.taskId || e.id;
    const item = downloads.queue.find((q) => q.taskId === taskId);
    if (item) item.error = e.error || e.message || '下载失败';
  });
}

/** unknown → 普通对象；非对象返回 null（等价于原实现的 `if (!x) return`） */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/* ── 队列操作 ─────────────────────────────────────────────── */

export async function cancelDownload(taskId: string): Promise<void> {
  const r = await callSafe<QueueMutationResult | null>('cancelDownload', [taskId], null);
  if (!r || !r.canceled) toast.warn('取消失败：任务可能已结束');
}

export async function retryDownload(taskId: string): Promise<void> {
  const r = await callSafe<QueueMutationResult | null>('retryDownload', [taskId], null);
  if (r && r.ok) toast.success('已重新排队');
  else toast.error((r && r.error) || '重试失败');
}

export async function removeQueueItem(taskId: string): Promise<void> {
  await callSafe('removeQueueItem', [taskId], null);
}

export async function moveQueueItem(taskId: string, action: string): Promise<void> {
  await callSafe('reorderQueueItem', [taskId, action], null);
}

export async function togglePauseQueue(): Promise<void> {
  const r = await callSafe<QueueMutationResult | null>('setQueuePaused', [!downloads.paused], null);
  if (r && r.ok) downloads.paused = !!r.paused;
}

export async function clearFinished(): Promise<void> {
  const r = await callSafe<QueueMutationResult | null>('clearFinishedQueue', [], null);
  if (r) toast.success(`已清理 ${r.removed} 个已完成任务`);
}

export async function clearAll(): Promise<void> {
  const r = await callSafe<QueueMutationResult | null>('clearAllQueue', [], null);
  if (r) toast.success(`已清空 ${r.removed} 个任务`);
}

/* ── 历史 ─────────────────────────────────────────────────── */

export async function loadHistory(page: number = downloads.history.page): Promise<void> {
  const h = downloads.history;
  h.page = Math.max(1, Number(page) || 1);
  h.loading = true;
  h.error = '';
  try {
    const r = await call<HistoryQueryResult>('queryHistory', {
      limit: h.limit,
      offset: (h.page - 1) * h.limit,
      keyword: h.keyword.trim() || undefined,
      status: h.status === 'all' ? undefined : h.status,
      sort: h.sort,
      markMissing: true,
    });
    h.items = Array.isArray(r && r.items) ? (r.items as DownloadHistoryItem[]) : [];
    h.total = Number(r && r.total) || 0;
    h.deadEntries = Array.isArray(r && r.deadEntries) ? (r.deadEntries as DownloadHistoryItem[]) : [];
  } catch (e) {
    h.error = errText(e, '读取历史失败');
  } finally {
    h.loading = false;
  }
}

export async function loadHistoryStats(): Promise<HistoryStats | null> {
  downloads.stats = await callSafe<HistoryStats | null>('historyStats', [], null);
  return downloads.stats;
}

export async function removeHistoryEntry(entry: DownloadHistoryItem): Promise<void> {
  const r = await callSafe('removeHistory', [[{ id: entry.id, source: entry.source }]], null);
  if (r) await refreshHistoryAfterMutation();
}

export async function removeDeadEntries(): Promise<void> {
  const dead = downloads.history.deadEntries || [];
  if (!dead.length) return;
  await callSafe('removeHistory', [dead], null);
  await refreshHistoryAfterMutation();
}

export async function clearHistory(): Promise<void> {
  await callSafe('clearHistory', [], null);
  downloads.history.items = [];
  downloads.history.total = 0;
  downloads.stats = await callSafe<HistoryStats | null>('historyStats', [], null);
  toast.success('下载历史已清空');
}

async function refreshHistoryAfterMutation(): Promise<void> {
  await Promise.all([loadHistory(downloads.history.page), loadHistoryStats()]);
  // 当前页被删空时回退一页
  if (!downloads.history.items.length && downloads.history.page > 1) {
    await loadHistory(downloads.history.page - 1);
  }
}

export function historyNext(): void {
  const h = downloads.history;
  if (h.page * h.limit >= h.total) return;
  void loadHistory(h.page + 1);
}

export function historyPrev(): void {
  if (downloads.history.page <= 1) return;
  void loadHistory(downloads.history.page - 1);
}

export function openHistoryItem(item: { savePath?: string } | null | undefined): void {
  if (item && item.savePath) void callSafe('openFolder', [item.savePath], null);
}