/**
 * core/env.d.ts —— preload / 无头验证台注入的全局契约声明
 *
 * 只声明 bridge 实际用到的成员；完整契约仍以 src/shared/ipcContract.js 为准，
 * 这里不做第二份实现，只做最小类型背书（避免 Window 上 unknown 属性满层 as）。
 *
 * 注入方：
 *  - src/preload/*：暴露 musicAPI（camelCase 方法名）与 ipcRenderer.invoke
 *  - concept/v2-preview.html：注入 window.__LY_MOCK__ 桩（同名方法即桩实现）
 */

/** IPC 方法：参数 / 返回值按 IPC 边界保守声明，调用方需要时再收窄 */
export type MusicApiMethod = (...args: unknown[]) => unknown;

/** preload 暴露的契约对象：方法名 → 实现 */
export interface MusicApi {
  [method: string]: MusicApiMethod;
}

/** 无头验证台桩：未注入的方法为 undefined，bridge 会回落到真实契约 */
export type LyMock = Readonly<Record<string, MusicApiMethod | undefined>>;

/** preload 暴露的直连通道（mcp-* / ai-assistant-* 白名单） */
export interface IpcRendererLike {
  invoke: (channel: string, ...args: unknown[]) => unknown;
}

declare global {
  interface Window {
    musicAPI?: MusicApi;
    __LY_MOCK__?: LyMock;
    ipcRenderer?: IpcRendererLike;
  }
}