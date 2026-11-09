/**
 * core/dialog.ts —— 确认框 / 输入框的 Promise 封装
 *
 * 用法：
 *   if (await confirmDialog({ title: '移除歌曲', body: '...', danger: true })) ...
 *   const name = await promptDialog({ title: '歌单名称', value: '未命名' });
 *
 * 渲染由 components/shell/DialogHost.vue 负责，一次只允许一个活动对话框
 * （桌面端栈式弹窗会让焦点与 Esc 处理互相打架，旧层为此踩过坑）。
 */
import { reactive } from 'vue';

/** confirm：确定/取消；prompt：确认后返回输入值，取消返回 null */
export type DialogKind = 'confirm' | 'prompt';

export interface DialogOptions {
  /** 默认按 confirm 处理 */
  kind?: DialogKind;
  title?: string;
  body?: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  inputLabel?: string;
  /** prompt 的初始输入值 */
  value?: string | null;
  placeholder?: string;
}

interface DialogState {
  open: boolean;
  kind: DialogKind;
  title: string;
  body: string;
  okText: string;
  cancelText: string;
  danger: boolean;
  inputLabel: string;
  inputValue: string;
  placeholder: string;
  /** 当前等待结单的 Promise resolve；无活动对话框时 null */
  resolve: ((value: unknown) => void) | null;
}

export const dialogState = reactive<DialogState>({
  open: false,
  kind: 'confirm', // confirm | prompt
  title: '',
  body: '',
  okText: '确定',
  cancelText: '取消',
  danger: false,
  inputLabel: '',
  inputValue: '',
  placeholder: '',
  resolve: null,
});

function openDialog(opts: DialogOptions): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    // 已有对话框：先按取消结掉上一个，避免 Promise 永久挂起
    if (dialogState.open && dialogState.resolve) {
      dialogState.resolve(dialogState.kind === 'prompt' ? null : false);
    }
    Object.assign(dialogState, {
      open: true,
      kind: opts.kind || 'confirm',
      title: opts.title || '',
      body: opts.body || '',
      okText: opts.okText || '确定',
      cancelText: opts.cancelText || '取消',
      danger: !!opts.danger,
      inputLabel: opts.inputLabel || '',
      inputValue: opts.value ?? '',
      placeholder: opts.placeholder || '',
      resolve,
    });
  });
}

export function confirmDialog(opts: DialogOptions = {}): Promise<boolean> {
  return openDialog({ kind: 'confirm', ...opts }) as Promise<boolean>;
}

export function promptDialog(opts: DialogOptions = {}): Promise<string | null> {
  return openDialog({ kind: 'prompt', ...opts }) as Promise<string | null>;
}

export function alertDialog(opts: DialogOptions = {}): Promise<boolean> {
  return openDialog({ kind: 'confirm', okText: '知道了', cancelText: '', ...opts }) as Promise<boolean>;
}

/** 由 DialogHost 调用 */
export function settleDialog(ok: boolean): void {
  const { kind, resolve, inputValue } = dialogState;
  dialogState.open = false;
  if (resolve) {
    if (kind === 'prompt') resolve(ok ? inputValue : null);
    else resolve(!!ok);
  }
  dialogState.resolve = null;
}