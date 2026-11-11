/**
 * core/bridge.ts —— 渲染层与主进程的唯一通道
 *
 * 约束（重构期硬规则）：
 *  1. 组件与 store **不得**直接访问 window.musicAPI；
 *     所有 IPC 必须经本文件，方法名即 preload 契约的 camelCase。
 *  2. 无头验证台（concept/v2-preview.html）通过 window.__LY_MOCK__ 注入桩，
 *     这里优先走桩，保证同一套组件可在浏览器里独立截图。
 *  3. 错误不吞：preload 已把信封解包成 reject，调用方自行决定兜底；
 *     只有「读偏好」这类非关键路径才允许静默降级。
 */
import type { BridgeMethods, BridgeMethodName, BridgeEvents, BridgeEventName } from './bridge.gen';

/**
 * 事件订阅回调。
 *
 * 事件载荷的形状由主进程各 channel 自己决定（进度 / 队列 / 日志 …），
 * bridge 只做转发，无法在通道层给出统一结构，因此参数保持宽松；
 * 需要字段时由订阅方自行收窄。
 */
export type EventListener = (...args: any[]) => void;

/** 契约探测：主窗口有 preload，二级窗口走最小契约 */
export function api(): BridgeMethods {
  const a = window.musicAPI;
  if (!a) throw new Error('musicAPI 未注入（preload 缺失？）');
  return a as unknown as BridgeMethods;
}

export function hasApi(): boolean {
  return !!window.musicAPI;
}

/** 从 unknown 异常里尽力取可读信息（mock 失败日志用） */
function errMessage(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    return typeof m === 'string' ? m : undefined;
  }
  return undefined;
}

/**
 * 统一 IPC 调用。
 * @param method preload 契约方法名（camelCase）
 * @param args 原样转发给契约方法
 */
export async function call<T = unknown>(method: BridgeMethodName, ...args: unknown[]): Promise<T> {
  const mockMethod = window.__LY_MOCK__?.[method];
  if (typeof mockMethod === 'function') {
    return (mockMethod as (...a: unknown[]) => unknown)(...args) as T;
  }
  const a = api();
  const fn = a[method] as ((...args: unknown[]) => unknown) | undefined;
  if (typeof fn !== 'function') {
    throw new Error(`musicAPI.${method} 不在契约白名单`);
  }
  return fn(...args) as T;
}

/**
 * 不抛错的调用：失败返回 fallback，用于启动期非关键读取。
 *
 * 默认返回 any：调用方是未迁移的 JS store，各方法回包形状由主进程契约决定，
 * 桥接层无法收敛成统一结构；需要类型时显式传 T（见 core/prefs.ts）。
 * @param fallback 失败时的返回值（类型参与返回值推导）
 */
export async function callSafe<T = any, F = null>(method: BridgeMethodName, args: unknown[] = [], fallback: F = null as F): Promise<T | F> {
  try {
    return await call<T>(method, ...args);
  } catch {
    return fallback;
  }
}

/**
 * 直连通道调用（mcp-* / ai-assistant-* 这类不在 METHODS 语法糖里的通道）。
 * 仍走 preload 的 invoke 白名单，组件不得自行访问 ipcRenderer。
 */
export async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const mockMethod = window.__LY_MOCK__?.[channel];
  if (typeof mockMethod === 'function') {
    return mockMethod(...args) as T;
  }
  const r = window.ipcRenderer;
  if (!r || typeof r.invoke !== 'function') throw new Error('ipcRenderer 未注入（preload 缺失？）');
  return r.invoke(channel, ...args) as T;
}

/**
 * 订阅主进程推送事件。
 * preload 的订阅方法签名为 (cb) => ipcRenderer.on(channel, cb)。
 * @returns 尽力解绑；preload 未暴露 removeListener 时为空操作。
 */
export function on(event: BridgeEventName, cb: EventListener): () => void {
  // 无头验证台：桩数据同样可以推事件
  const mockListener = window.__LY_MOCK__?.[event];
  if (typeof mockListener === 'function') {
    try {
      const ret = mockListener(cb);
      return typeof ret === 'function' ? (ret as () => void) : () => {};
    } catch (e) {
      console.warn('[bridge] mock 事件订阅失败:', event, errMessage(e));
      return () => {};
    }
  }
  try {
    const a = api();
    const subscribe = a[event as unknown as BridgeMethodName] as ((cb: EventListener) => void) | undefined;
    if (typeof subscribe !== 'function') {
      console.warn(`[bridge] 未知事件 ${event}`);
      return () => {};
    }
    const ret = subscribe(cb);
    if (typeof ret === 'function') return ret as () => void;
  } catch (e) {
    console.warn('[bridge] 事件订阅失败:', event, errMessage(e));
  }
  return () => {};
}

/** 窗口控制（主界面外壳专用，避免组件里散落通道名） */
export const win = {
  minimize: () => callSafe('windowMinimize'),
  maximize: () => callSafe('windowMaximize'),
  close: () => callSafe('windowClose'),
};