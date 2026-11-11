/**
 * core/format.ts —— 展示层格式化（纯函数，可单测）
 *
 * 入参统一按 unknown 接收：这些函数本身就是「把任意脏数据渲染成文案」的边界，
 * 内部经 Number()/String() 归一，非法值按 0/空串处理。
 */

export function fmtDuration(sec: unknown): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function fmtDurationMs(ms: unknown): string {
  return fmtDuration((Number(ms) || 0) / 1000);
}

export function fmtSize(bytes: unknown): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtCount(n: unknown): string {
  const v = Number(n) || 0;
  if (v < 10000) return String(v);
  if (v < 100000000) return `${(v / 10000).toFixed(1)} 万`;
  return `${(v / 100000000).toFixed(1)} 亿`;
}

export function fmtDate(ts: unknown, withTime = false): string {
  const d = ts instanceof Date ? ts : new Date(Number(ts) || 0);
  if (Number.isNaN(d.getTime()) || !Number(ts)) return '—';
  const p = (x: number): string => String(x).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
}

export function timeAgo(ts: unknown): string {
  const t = Number(ts) || 0;
  if (!t) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 86400_000 * 30) return `${Math.floor(diff / 86400_000)} 天前`;
  return fmtDate(t);
}

/** 平台唯一标识 → 中文名；未知平台回退原值 */
const PLATFORM_NAMES: Readonly<Record<string, string>> = Object.freeze({
  all: '全部',
  netease: '网易云',
  qq: 'QQ 音乐',
  kugou: '酷狗',
  kuwo: '酷我',
  migu: '咪咕',
  bilibili: 'B 站',
  soda: '汽水',
  fivesing: '5sing',
  local: '本地',
});

export function platformName(source: unknown): string {
  const k = String(source || '').toLowerCase();
  // 与原实现一致：未知平台原样回退 source 本身（调用方按字符串展示）
  return PLATFORM_NAMES[k] || (source as string) || '未知';
}

/** 音质档位 → 展示文案 */
const QUALITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  standard: '标准',
  hq: '高品质',
  lossless: '无损',
});

export function qualityLabel(q: unknown): string {
  const raw = q ? String(q) : '';
  const k = raw.toLowerCase();
  return QUALITY_LABELS[k] || raw || '标准';
}

/** 歌曲行右侧的音质徽标所需字段（与 core/song 的 Song 结构兼容） */
export interface QualitySource {
  lossless?: unknown;
  quality?: unknown;
  bitrate?: unknown;
}

/** 歌曲行右侧的音质徽标：优先看解析结果，其次看平台声明 */
export function qualityBadge(song: unknown): string {
  if (!song || typeof song !== 'object') return '—';
  const s = song as QualitySource;
  if (s.lossless || s.quality === 'lossless') return 'FLAC';
  if (s.quality === 'hq' || Number(s.bitrate) >= 320) return '320K';
  return '128K';
}

export function fmtBitrate(kbps: unknown): string {
  const n = Number(kbps) || 0;
  return n > 0 ? `${n} kbps` : '—';
}

/** 百分比夹取，用于进度条/音量 */
export function pct(cur: unknown, total: unknown): number {
  const c = Number(cur) || 0;
  const t = Number(total) || 0;
  if (!t || t <= 0) return 0;
  return Math.min(100, Math.max(0, (c / t) * 100));
}