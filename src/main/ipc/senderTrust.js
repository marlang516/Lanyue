/**
 * IPC 来源白名单（senderFrame 校验）
 *
 * 为什么需要：register.js 的 handle/on 只做契约校验，不看**消息是谁发的**。
 * Electron 的 ipcMain 是进程级广播 —— 应用里任何 webContents（主窗口、迷你
 * 播放器、桌面歌词窗、乃至将来新增的任何一个窗）都能 invoke 全量通道。
 * 现状里二级窗口靠 preload-secondary 的通道白名单自保，但那只是「不给钥匙」，
 * 不是「门锁」：一旦某个窗口被注入脚本，脚本可以自己 `require('electron')`
 * 之外的路子（例如 navigator 间接）—— 更现实的是新增窗口时忘了收窄 preload。
 *
 * 本模块把「哪一类窗口能调哪些通道」变成主进程侧的事实：
 *   1. 窗口创建时显式登记（trust），未登记的 sender 一律拒绝；
 *   2. 通道声明的能力面（ipcContract 的 invoke/send 数组）必须包含该窗口的
 *      surface —— 二级窗口即使伪造通道名也进不了主窗口的特权面；
 *   3. 只信任顶层框架（iframe 一律拒绝，页面内嵌内容不能借宿主身份调 IPC）；
 *   4. 发送方 URL 必须是应用包内 file: 或 dev server 同源 —— 导航防护若将来
 *      出现缺口，这一层仍能把「被导去远程页的窗口」拦在 IPC 之外。
 *
 * 依赖方向：只依赖 ipcContract 与 Node 内置模块，不 require electron，
 * 保持 node 直测（见 test/ipc-sender-trust.test.js）。
 */

'use strict';

const path = require('path');
const { fileURLToPath } = require('url');
const { CHANNELS } = require('../../shared/ipcContract');

/** @type {Map<number, {surface: 'main'|'secondary'}>} webContents.id → 能力面 */
const trusted = new Map();

/** 运行期注入的 URL 判据基准（index.js 在 whenReady 里 configure 一次） */
let appPath = null;
let devOrigin = null;

function configure({ appPath: ap, devOrigin: origin } = {}) {
  appPath = ap ? path.resolve(ap) : null;
  try {
    devOrigin = origin ? new URL(String(origin)).origin : null;
  } catch (_) {
    devOrigin = null;
  }
}

/**
 * 登记一个可信窗口。surface 必须与契约里的能力面同名（main / secondary）。
 * @param {object} webContents
 * @param {'main'|'secondary'} surface
 * @returns {boolean}
 */
function trust(webContents, surface) {
  if (!webContents || typeof webContents.id !== 'number') return false;
  if (surface !== 'main' && surface !== 'secondary') return false;
  trusted.set(webContents.id, { surface });
  try {
    // 窗口销毁即摘牌（id 可能被复用，残留条目等于给新窗口发通行证）
    webContents.once('destroyed', () => trusted.delete(webContents.id));
  } catch (_) { /* 测试替身没有事件接口 */ }
  return true;
}

function revoke(webContents) {
  if (webContents && typeof webContents.id === 'number') trusted.delete(webContents.id);
}

function reset() {
  trusted.clear();
}

function _isInsideAppPath(u) {
  // 未配置包根时（例如纯逻辑单测）只按协议判定，不做路径收窄。
  if (!appPath) return true;
  try {
    const fp = path.resolve(fileURLToPath(u));
    const rel = path.relative(appPath, fp);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch (_) {
    return false;
  }
}

function _urlAllowed(rawUrl, surface) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (_) { return false; }
  if (u.protocol === 'file:') return _isInsideAppPath(u);
  // 打包运行时窗口只加载本地文件；http(s) 仅 dev server 同源（与 createWindow
  // 的 sameHttpOrigin 放行口径一致，否则 vite 整页刷新后 IPC 会全部失效）。
  if (surface === 'main' && devOrigin && u.origin === devOrigin) return true;
  return false;
}

/**
 * 校验一次 IPC 事件是否有权进入某个通道。
 *
 * @param {object} event            ipcMain 事件（需要 sender / senderFrame）
 * @param {string} channel
 * @param {'invoke'|'send'} dir
 * @returns {{ok: boolean, reason?: string}}
 */
function check(event, channel, dir) {
  const sender = event && event.sender;
  if (!sender || typeof sender.id !== 'number') return { ok: false, reason: '无 sender' };

  const entry = trusted.get(sender.id);
  if (!entry) return { ok: false, reason: `未登记的 webContents #${sender.id}` };
  if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
    trusted.delete(sender.id);
    return { ok: false, reason: 'sender 已销毁' };
  }

  const frame = event.senderFrame;
  if (!frame) return { ok: false, reason: '无 senderFrame' };
  if (frame.parent) return { ok: false, reason: '非顶层框架' };
  if (sender.mainFrame && frame !== sender.mainFrame) {
    return { ok: false, reason: 'senderFrame 不是主框架' };
  }
  if (!_urlAllowed(frame.url, entry.surface)) {
    return { ok: false, reason: `窗口来源不可信: ${frame.url}` };
  }

  const declared = (CHANNELS[channel] && CHANNELS[channel][dir]) || [];
  if (!declared.includes(entry.surface)) {
    return { ok: false, reason: `通道不在 ${entry.surface} 能力面内` };
  }
  return { ok: true };
}

module.exports = {
  configure,
  trust,
  revoke,
  reset,
  check,
  _urlAllowed,
  _trusted: trusted,
};
