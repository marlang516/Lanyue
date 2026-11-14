/**
 * IPC 来源闸（senderTrust）单测 —— 纯 Node，不依赖 Electron
 *
 * 钉住四条契约：
 *  1. 未登记 / 已销毁的 webContents 一律拒绝（主进程侧白名单，不靠 preload 自觉）；
 *  2. 二级窗口只能进契约声明的 secondary 能力面，摸不到主窗口特权通道；
 *  3. 只信任顶层框架，iframe 不能借宿主身份调 IPC；
 *  4. senderFrame 的 URL 必须是包内 file: 或 dev server 同源。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const st = require('../src/main/ipc/senderTrust');

const APP_ROOT = path.resolve('C:/lanyue-app');
const FILE_IN_APP = pathToFileURL(path.join(APP_ROOT, 'dist/renderer/index.html')).href;
const FILE_OUTSIDE = pathToFileURL(path.resolve('C:/Windows/Temp/fishing.html')).href;

function mkFrame(url = FILE_IN_APP, parent = null) {
  return { url, parent };
}

function mkSender(id, { destroyed = false, mainFrame = mkFrame() } = {}) {
  return { id, isDestroyed: () => destroyed, mainFrame };
}

function mkEvent(sender, frame) {
  return { sender, senderFrame: frame === undefined ? sender.mainFrame : frame };
}

function setup() {
  st.reset();
  st.configure({ appPath: APP_ROOT });
}

test('未登记的 webContents 被拒绝', () => {
  setup();
  const wc = mkSender(101);
  assert.strictEqual(st.check(mkEvent(wc), 'search-music', 'invoke').ok, false);
});

test('登记后主窗口可进 main 面通道', () => {
  setup();
  const wc = mkSender(102);
  st.trust(wc, 'main');
  assert.strictEqual(st.check(mkEvent(wc), 'search-music', 'invoke').ok, true);
  assert.strictEqual(st.check(mkEvent(wc), 'window-minimize', 'send').ok, true);
});

test('二级窗口进不了主窗口特权通道，但能用 secondary 通道', () => {
  setup();
  const wc = mkSender(103);
  st.trust(wc, 'secondary');
  const denied = st.check(mkEvent(wc), 'search-music', 'invoke');
  assert.strictEqual(denied.ok, false);
  assert.match(denied.reason, /能力面/);
  assert.strictEqual(st.check(mkEvent(wc), 'mini-toggle-play', 'send').ok, true);
});

test('iframe（非顶层框架）被拒绝', () => {
  setup();
  const wc = mkSender(104, { mainFrame: mkFrame() });
  st.trust(wc, 'main');
  const child = mkFrame(FILE_IN_APP, mkFrame());
  const r = st.check(mkEvent(wc, child), 'search-music', 'invoke');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /非顶层框架/);
});

test('senderFrame 不是主框架时拒绝（防伪造对象）', () => {
  setup();
  const wc = mkSender(105, { mainFrame: mkFrame() });
  st.trust(wc, 'main');
  const fakeMain = mkFrame();
  const r = st.check(mkEvent(wc, fakeMain), 'search-music', 'invoke');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /主框架/);
});

test('已销毁的 sender 被拒绝并摘牌', () => {
  setup();
  const wc = mkSender(106, { destroyed: true });
  st.trust(wc, 'main');
  assert.strictEqual(st.check(mkEvent(wc), 'search-music', 'invoke').ok, false);
  assert.strictEqual(st._trusted.has(106), false);
});

test('包外 file: 页面被拒绝', () => {
  setup();
  const wc = mkSender(107, { mainFrame: mkFrame(FILE_OUTSIDE) });
  st.trust(wc, 'main');
  const r = st.check(mkEvent(wc), 'search-music', 'invoke');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /来源不可信/);
});

test('远程 http(s) 页面默认被拒绝', () => {
  setup();
  const wc = mkSender(108, { mainFrame: mkFrame('https://evil.example/x.html') });
  st.trust(wc, 'main');
  assert.strictEqual(st.check(mkEvent(wc), 'search-music', 'invoke').ok, false);
});

test('dev server 同源只对主窗口放行（vite 整页刷新不误伤）', () => {
  setup();
  st.configure({ appPath: APP_ROOT, devOrigin: 'http://localhost:5173' });
  const main = mkSender(109, { mainFrame: mkFrame('http://localhost:5173/index.html') });
  st.trust(main, 'main');
  assert.strictEqual(st.check(mkEvent(main), 'search-music', 'invoke').ok, true);

  const secondary = mkSender(110, { mainFrame: mkFrame('http://localhost:5173/desktop-lyric.html') });
  st.trust(secondary, 'secondary');
  assert.strictEqual(st.check(mkEvent(secondary), 'mini-toggle-play', 'send').ok, false,
    '二级窗口只加载本地固定页，dev server 同源也不该给它开');
});

test('缺 sender / senderFrame 时拒绝（fail-closed）', () => {
  setup();
  assert.strictEqual(st.check({}, 'search-music', 'invoke').ok, false);
  const wc = mkSender(111);
  st.trust(wc, 'main');
  assert.strictEqual(st.check({ sender: wc }, 'search-music', 'invoke').ok, false);
});
