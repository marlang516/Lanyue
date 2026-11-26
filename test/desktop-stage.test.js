/**
 * 舞台投桌面：沿用桌面歌词那一扇窗，铺成独立透明层。
 *
 * 不是系统壁纸，也不把窗口挂进桌面宿主。鼠标穿透，不抢焦点。
 * 投射开着时主窗口把同一舞台缩一档、少画，避免两份全价场景抢帧。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WORK = { x: 8, y: 16, width: 1440, height: 900 };
const ipcHandlers = new Map();
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: {
        handle(channel, fn) { ipcHandlers.set(`h:${channel}`, fn); },
        on(channel, fn) { ipcHandlers.set(channel, fn); },
      },
      app: { getPath: () => '/tmp/lanyue-desktop-stage' },
      shell: { showItemInFolder() {}, openExternal() {} },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      BrowserWindow: function BrowserWindow() {},
      screen: { getPrimaryDisplay: () => ({ workArea: WORK }) },
    };
  }
  return originalLoad(request, parent, isMain);
};

const ipcWindow = require(path.join(ROOT, 'src/main/ipc/window'));
const { normalizeArgs } = require(path.join(ROOT, 'src/shared/ipcContract'));
const { init: initContext } = require(path.join(ROOT, 'src/main/context'));
Module._load = originalLoad;

const made = [];
let wcSeq = 1;

function FakeWindow(opts) {
  this.opts = { ...opts };
  this.calls = [];
  this.destroyed = false;
  this.loaded = '';
  this._events = {};
  this.webContents = {
    id: wcSeq++,
    _events: {},
    on(name, fn) { (this._events[name] || (this._events[name] = [])).push(fn); },
    once(name, fn) { this.on(name, fn); },
    send() {},
    setWindowOpenHandler(fn) { this.openHandler = fn; },
  };
  made.push(this);
}
FakeWindow.prototype.isDestroyed = function isDestroyed() { return this.destroyed; };
FakeWindow.prototype.focus = function focus() { this.calls.push('focus'); };
FakeWindow.prototype.show = function show() { this.calls.push('show'); };
FakeWindow.prototype.showInactive = function showInactive() { this.calls.push('showInactive'); };
FakeWindow.prototype.blur = function blur() { this.calls.push('blur'); };
FakeWindow.prototype.setIgnoreMouseEvents = function setIgnoreMouseEvents(ignore, options) {
  this.calls.push(['setIgnoreMouseEvents', !!ignore, options || null]);
  this.ignoreMouse = !!ignore;
};
FakeWindow.prototype.setFocusable = function setFocusable(value) {
  this.calls.push(['setFocusable', !!value]);
  this.opts.focusable = !!value;
};
FakeWindow.prototype.setBounds = function setBounds(bounds) {
  this.calls.push(['setBounds', bounds]);
  this.bounds = bounds;
};
FakeWindow.prototype.setSize = function setSize(width, height) {
  this.calls.push(['setSize', width, height]);
};
FakeWindow.prototype.setAlwaysOnTop = function setAlwaysOnTop(flag, level) {
  this.calls.push(['setAlwaysOnTop', !!flag, level]);
};
FakeWindow.prototype.setSkipTaskbar = function setSkipTaskbar(flag) {
  this.calls.push(['setSkipTaskbar', !!flag]);
};
FakeWindow.prototype.setParent = function setParent(parent) {
  this.calls.push(['setParent', parent]);
};
FakeWindow.prototype.setWallpaper = function setWallpaper() {
  this.calls.push('setWallpaper');
};
FakeWindow.prototype.loadFile = function loadFile(file) { this.loaded = file; };
FakeWindow.prototype.on = function on(name, fn) {
  (this._events[name] || (this._events[name] = [])).push(fn);
};
FakeWindow.prototype.close = function close() {
  this.destroyed = true;
  for (const fn of this._events.closed || []) fn();
};

const mainSends = [];
initContext({
  app: { getPath: () => '/tmp/lanyue-desktop-stage' },
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send(channel, payload) { mainSends.push([channel, payload]); },
    },
  }),
});

ipcWindow.setWindowPort({
  BrowserWindow: FakeWindow,
  screen: { getPrimaryDisplay: () => ({ workArea: WORK }) },
});
ipcWindow.register();

function callNames(win) {
  return win.calls.map((entry) => (Array.isArray(entry) ? entry[0] : entry));
}

test('舞台投桌面是独立透明窗：不改系统壁纸，也不挂进桌面宿主', () => {
  const spec = ipcWindow.desktopStageSpec(WORK);
  assert.equal(spec.independent, true);
  assert.equal(spec.transparent, true);
  assert.equal(spec.wallpaper, false);
  assert.equal(spec.hostInjection, false);
  assert.equal(spec.focusable, false);
  assert.equal(spec.clickThrough, true);
  assert.equal(spec.show, 'inactive');
  assert.deepEqual(spec.bounds, WORK);

  made.length = 0;
  const win = ipcWindow.createDesktopLyric('stage');
  assert.equal(made.length, 1, '舞台投射复用桌面歌词这一扇窗，不再开第二套叠层');
  assert.equal(win, made[0]);
  assert.equal(win.opts.transparent, true);
  assert.equal(win.opts.frame, false);
  assert.equal(win.opts.focusable, false);
  assert.equal(win.opts.show, false, '创建时先不显示，避免构造函数把焦点抢走');
  assert.equal(win.opts.type, undefined, '不用 type:desktop，那会贴进桌面宿主');
  assert.equal(win.opts.parent, undefined);
  assert.equal(path.basename(win.loaded), 'desktop-lyric.html');
  assert.deepEqual(win.bounds, WORK);

  const names = callNames(win);
  assert.ok(names.includes('showInactive'));
  assert.ok(!names.includes('focus'));
  assert.ok(!names.includes('show'));
  assert.ok(!names.includes('setParent'));
  assert.ok(!names.includes('setWallpaper'));

  const src = read('src/main/ipc/window.js');
  assert.doesNotMatch(src, /setWallpaper\s*\(/);
  assert.doesNotMatch(src, /SystemParametersInfo/);
  assert.doesNotMatch(src, /IDesktopWallpaper/);
  assert.doesNotMatch(src, /\.setParent\s*\(/);
  assert.doesNotMatch(src, /WorkerW|Progman|SHELLDLL_DefView/);
  assert.doesNotMatch(src, /type:\s*['"]desktop['"]/);
});

test('舞台窗点击穿透，锁定和悬停都不能把点击抢回来，也不抢焦点', () => {
  const { event } = require('./helpers/ipcTrust').install();
  const win = ipcWindow.createDesktopLyric('stage');
  const before = win.calls.length;
  ipcHandlers.get('desktop-lyric-lock')(event, true);
  ipcHandlers.get('desktop-lyric-lock')(event, false);
  ipcHandlers.get('desktop-lyric-set-ignore-mouse')(event, false);
  assert.equal(win.calls.length, before, '投射中控制条消息不能改穿透或焦点');
  assert.equal(win.ignoreMouse, true);
  assert.equal(win.opts.focusable, false);
  assert.ok(!callNames(win).includes('focus'));

  const ignore = win.calls.filter((entry) => Array.isArray(entry) && entry[0] === 'setIgnoreMouseEvents');
  assert.ok(ignore.length >= 1);
  assert.equal(ignore.at(-1)[1], true);
  assert.ok(!ignore.at(-1)[2] || ignore.at(-1)[2].forward !== true);
});

test('关掉投射会关掉这扇窗，并告诉主窗口不用再省着画', () => {
  const { event } = require('./helpers/ipcTrust').install();
  mainSends.length = 0;
  const win = ipcWindow.createDesktopLyric('stage');
  ipcHandlers.get('open-desktop-lyric')(event, 'off');
  assert.equal(win.destroyed, true);
  assert.ok(!callNames(win).includes('focus'));
  assert.deepEqual(mainSends.at(-1), ['sync-desktop-lyric', { closed: true }]);
});

test('打开通道只接受歌词 / 舞台 / 关闭，壁纸不是一种模式', () => {
  assert.deepEqual(normalizeArgs('open-desktop-lyric', []), { ok: true, args: ['lyric'] });
  assert.deepEqual(normalizeArgs('open-desktop-lyric', ['stage']), { ok: true, args: ['stage'] });
  assert.deepEqual(normalizeArgs('open-desktop-lyric', ['off']), { ok: true, args: ['off'] });
  assert.deepEqual(normalizeArgs('open-desktop-lyric', ['wallpaper']), { ok: true, args: ['lyric'] });
});

test('投射打开时主窗口不是第二份全价舞台', async () => {
  const { mainStageRenderPlan, stageFrameBudget, shouldPaintMainStage } = await import(
    '../src/renderer/app/core/lyricMotion.js'
  );
  const full = mainStageRenderPlan(false);
  const cheap = mainStageRenderPlan(true);
  assert.equal(full.fullCost, true);
  assert.equal(full.scale, 1);
  assert.equal(full.blurCover, true);
  assert.equal(full.sweep, true);
  assert.equal(cheap.fullCost, false);
  assert.ok(cheap.scale > 0 && cheap.scale < 1);
  assert.equal(cheap.blurCover, false);
  assert.equal(cheap.sweep, false);
  assert.ok(cheap.frameMs > full.frameMs);

  const on = stageFrameBudget(true);
  const off = stageFrameBudget(false);
  assert.equal(on.desktop.running, true);
  assert.equal(on.desktop.fullCost, true);
  assert.equal(on.main.fullCost, false);
  assert.ok(on.main.scale < on.desktop.scale);
  assert.equal(on.competingFullScenes, false);
  assert.equal(off.desktop.running, false);
  assert.equal(off.competingFullScenes, false);

  assert.equal(shouldPaintMainStage(0, 1, full), true);
  assert.equal(shouldPaintMainStage(-1, 0, cheap), true);
  assert.equal(shouldPaintMainStage(0, cheap.frameMs - 1, cheap), false);
  assert.equal(shouldPaintMainStage(0, cheap.frameMs, cheap), true);
});

test('主窗口舞台和全屏歌词在投射时走便宜档，桌面页仍是原来的歌词窗', () => {
  const disc = read('src/renderer/app/views/DiscoverView.vue');
  const pane = read('src/renderer/app/components/player/LyricsPane.vue');
  const desk = read('src/renderer/desktop-lyric.html');
  const bar = read('src/renderer/app/components/player/PlayerBar.vue');

  assert.match(disc, /mainStageRenderPlan/);
  assert.match(disc, /shouldPaintMainStage/);
  assert.match(disc, /cheap:\s*stagePlan\.tier === 'cheap'/);
  assert.match(disc, /:class="\{ bare: !player\.current\.cover \|\| coverGone \}"/);
  assert.match(disc, /\.wash\.cheap[\s\S]*filter:\s*none/);
  assert.match(disc, /scale\(\$\{stagePlan\.scale\}\)/);
  assert.doesNotMatch(disc, /var\(\s*--stage-scale/);
  assert.match(pane, /mainStageRenderPlan/);
  assert.match(pane, /shouldPaintMainStage/);
  assert.match(pane, /scale\(\$\{stagePlan\.value\.scale\}\)/);

  assert.match(desk, /stage-wall/);
  assert.match(desk, /id="stageCover"/);
  assert.match(desk, /stageTitle\.textContent/);
  assert.doesNotMatch(desk, /stageTitle\.innerHTML/);
  assert.match(desk, /function desktopTrackSignature/);
  assert.match(bar, /舞台投桌面/);
  assert.match(bar, /setDesktopStage/);
});
