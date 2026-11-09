/**
 * core/toast.ts —— 全局轻提示队列
 * 组件只调用 toast.success / error / info；渲染由 components/shell/ToastHost.vue 负责。
 */
import { reactive } from 'vue';

/** 视觉/语义档位，ToastHost 据此着色 */
export type ToastType = 'info' | 'success' | 'warn' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
}

let seq = 0;

export const toastState = reactive({
  items: [] as ToastItem[],
});

const MAX_VISIBLE = 4;

function push(message: unknown, type: ToastType, duration: number): number {
  const id = ++seq;
  const text = String(message ?? '');
  if (!text) return id;
  toastState.items.push({ id, message: text, type, duration });
  while (toastState.items.length > MAX_VISIBLE) {
    toastState.items.shift();
  }
  if (duration > 0) {
    setTimeout(() => dismiss(id), duration);
  }
  return id;
}

export function dismiss(id: number): void {
  const i = toastState.items.findIndex((x) => x.id === id);
  if (i >= 0) toastState.items.splice(i, 1);
}

export function clearToasts(): void {
  toastState.items.splice(0);
}

export const toast = {
  info: (msg: unknown, duration = 2600): number => push(msg, 'info', duration),
  success: (msg: unknown, duration = 2600): number => push(msg, 'success', duration),
  warn: (msg: unknown, duration = 3600): number => push(msg, 'warn', duration),
  error: (msg: unknown, duration = 5200): number => push(msg, 'error', duration),
  /** 下载/转换等长任务：默认不自动消失，由调用方 dismiss */
  sticky: (msg: unknown, type: ToastType = 'info'): number => push(msg, type, 0),
};

/** 错误对象 → 可读文案（IPC reject / 业务 error 字段都兼容） */
export function errText(e: unknown, fallback = '操作失败'): string {
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>;
    const msg = o.message || o.error;
    // 与原实现一致：message / error 有值即回退它本身（通常是字符串）
    return msg ? (msg as string) : fallback;
  }
  return fallback;
}