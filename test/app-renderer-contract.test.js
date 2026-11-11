/**
 * 新渲染层（Vue 3 · T3）静态门禁
 *
 * 与旧层 renderer-audit 同一套路：渲染层顶层碰 document，node:test 无法真跑，
 * 所以把「结构上不许破」的几条钉成源码断言：
 *   1. IPC 只许经 core/bridge.ts（否则 mock / 错误归一 / 契约白名单全部绕开）
 *   2. 入口 CSP 必须继续放行 lanyue-stream:（漏了=所有在线歌静默播不出）
 *   3. 导航 id 与 App.vue 的视图映射一一对应（漏一个=点进去是空页）
 *   4. CSS 令牌引用必须已定义（漏定义=整条声明静默失效）
 *   5. 主进程默认入口必须指向新渲染层
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app');

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const FILES = walk(APP);
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

test('新渲染层：IPC 调用只许经 core/bridge.ts', () => {
  const offenders = [];
  for (const f of FILES) {
    if (!/\.(js|ts|vue)$/.test(f)) continue;
    if (rel(f).endsWith('core/bridge.ts')) continue;
    const src = read(f);
    if (/window\.musicAPI/.test(src) || /window\.ipcRenderer/.test(src)) offenders.push(rel(f));
  }
  assert.deepStrictEqual(offenders, [], `以下文件绕过了 bridge：\n${offenders.join('\n')}`);
});

test('新渲染层入口：CSP 放行 lanyue-stream 且无内联脚本', () => {
  const html = read(path.join(APP, 'index.html'));
  assert.match(html, /media-src[^;]*lanyue-stream:/, 'CSP media-src 必须含 lanyue-stream:');
  assert.match(html, /script-src 'self'(?!\s+'unsafe-inline')/, '入口不应允许内联脚本');
});

test('新渲染层：导航 id 与 App.vue 视图映射一一对应', () => {
  const ui = read(path.join(APP, 'stores', 'ui.ts'));
  const app = read(path.join(APP, 'App.vue'));
  const ids = [...ui.matchAll(/\{\s*id:\s*'([^']+)',\s*label:/g)].map((m) => m[1]);
  assert.ok(ids.length >= 6, `导航项过少：${ids.length}`);
  for (const id of ids) {
    assert.ok(app.includes(`ui.view === '${id}'`), `App.vue 缺少视图映射：${id}`);
  }
});

test('新渲染层：CSS 令牌引用全部已定义', () => {
  const defs = new Set();
  for (const f of [path.join(APP, 'styles', 'tokens.css'), path.join(APP, 'styles', 'base.css')]) {
    for (const m of read(f).matchAll(/(--[a-z0-9-]+)\s*:/gi)) defs.add(m[1]);
  }
  const missing = new Map();
  for (const f of FILES) {
    if (!/\.(css|vue|js|ts)$/.test(f)) continue;
    const src = read(f);
    for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      if (!defs.has(m[1])) {
        if (!missing.has(m[1])) missing.set(m[1], new Set());
        missing.get(m[1]).add(rel(f));
      }
    }
  }
  const detail = [...missing].map(([k, s]) => `${k} ← ${[...s].join(', ')}`);
  assert.deepStrictEqual(detail, [], `未定义的令牌：\n${detail.join('\n')}`);
});

test('新渲染层：主视图文件齐全', () => {
  const views = [
    'DiscoverView', 'SearchView', 'LibraryView', 'DownloadView', 'RecentView',
    'PlaylistView', 'SettingsView', 'NowPlayingView',
  ];
  for (const v of views) {
    assert.ok(fs.existsSync(path.join(APP, 'views', `${v}.vue`)), `缺少视图：${v}.vue`);
  }
});

test('主进程默认入口指向新渲染层（LY_RENDERER_DIR 白名单回退，越界回退默认）', () => {
  const main = read(path.join(ROOT, 'src', 'main', 'createWindow.js'));

  // M2-T5：入口解析已迁至 createWindow.js。结构断言（行为实测在 main-hardening.test.js 的沙箱用例里）。
  assert.match(main, /const DIST_ROOT =/, 'createWindow.js 必须有 DIST_ROOT（打包后 __dirname 上一级）');
  assert.match(main, /RENDERER_DIR_WHITELIST/, 'createWindow.js 必须有穷举白名单（dist/renderer + dist/renderer-legacy）');
  assert.match(main, /renderer-legacy/, '白名单必须含 dist/renderer-legacy（旧层显式回退）');
  assert.match(main, /function isStrictlyInside/, 'createWindow.js 必须有 isStrictlyInside 包含性判定');
  assert.match(main, /function resolveRendererEntry/, 'createWindow.js 必须有 resolveRendererEntry 入口解析函数');
  assert.match(main, /realpathSync/, 'resolveRendererEntry 必须做 realpath 防 symlink 逃逸');
  assert.match(main, /const rendererEntry = resolveRendererEntry\(/, 'createWindow 必须经 resolveRendererEntry 取入口');
  assert.doesNotMatch(main, /loadFile\(\s*process\.env\.LY_RENDERER_DIR/, '不得把未校验的环境变量直接交给 loadFile');
});

test('新渲染层：播放引擎只允许 stores/player.ts 持有 audio', () => {
  const offenders = [];
  for (const f of FILES) {
    if (!/\.(js|ts|vue)$/.test(f)) continue;
    if (rel(f).endsWith('stores/player.ts')) continue;
    if (/new Audio\(/.test(read(f))) offenders.push(rel(f));
  }
  assert.deepStrictEqual(offenders, [], `audio 元素必须唯一：\n${offenders.join('\n')}`);
});