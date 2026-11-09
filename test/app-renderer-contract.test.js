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
  const main = read(path.join(ROOT, 'src', 'main', 'index.js'));

  // 从 index.js 抽出入口解析实现，在沙箱里真跑一遍 —— 断言的是「解析结果」，
  // 不是「源码里出现过 renderer 字样」（旧断言只匹配裸 path.join，已被 DIST_ROOT
  // 白名单解析取代，继续钉字符串就会把安全校验当成回归误报）。
  const declarations = [
    [/const DIST_ROOT = [^\n]*\n/, 'DIST_ROOT'],
    [/const RENDERER_DIR_WHITELIST = Object\.freeze\(\[[\s\S]*?\]\);\n/, 'RENDERER_DIR_WHITELIST'],
    [/function isStrictlyInside\([\s\S]*?\n\}\n/, 'isStrictlyInside'],
    [/function resolveRendererEntry\(\) \{[\s\S]*?\n\}\n/, 'resolveRendererEntry'],
  ].map(([re, label]) => {
    const m = re.exec(main);
    assert.ok(m, `index.js 缺少 ${label}（入口解析实现被改动了？）`);
    return m[0];
  }).join('\n');

  const DIST_MAIN = path.join(ROOT, 'dist', 'main');
  const DEFAULT_ENTRY = path.join(ROOT, 'dist', 'renderer', 'index.html');

  /** 用给定 LY_RENDERER_DIR 跑一次真实解析；fs 打桩，避免依赖 dist 是否已构建 */
  const resolveWith = (dir) => {
    const warnings = [];
    const sandbox = {
      path,
      fs: {
        realpathSync: (p) => p,
        statSync: () => ({ isFile: () => true }),
      },
      logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
      process: { env: dir === undefined ? {} : { LY_RENDERER_DIR: dir } },
      __dirname: DIST_MAIN,
    };
    const resolver = vm.runInNewContext(`${declarations}\nresolveRendererEntry`, sandbox);
    return { entry: resolver(), warnings };
  };

  // 1. 未设置环境变量：必须解析到新层 dist/renderer/index.html
  const byDefault = resolveWith(undefined);
  assert.strictEqual(byDefault.entry, DEFAULT_ENTRY,
    '默认入口必须是 dist/renderer/index.html（新层）');
  assert.deepStrictEqual(byDefault.warnings, [], '默认入口不应产生告警');

  // 2. 白名单：renderer 与 renderer-legacy 都是合法目标（旧层显式回退可用）
  for (const name of ['renderer', 'renderer-legacy']) {
    const dir = path.join(ROOT, 'dist', name);
    const r = resolveWith(dir);
    assert.strictEqual(r.entry, path.join(dir, 'index.html'),
      `${name} 必须在允许列表内，且加载其 index.html`);
    assert.deepStrictEqual(r.warnings, [], `${name} 是合法入口，不应告警`);
  }

  // 3. 越界值：dist 之外、以及 dist 根自身，都必须回退默认并告警（不阻断启动）
  for (const bad of [path.join(ROOT, 'src', 'renderer', 'app'), path.join(ROOT, 'dist')]) {
    const r = resolveWith(bad);
    assert.strictEqual(r.entry, DEFAULT_ENTRY, `越界值 ${bad} 必须回退默认入口`);
    assert.strictEqual(r.warnings.length, 1, '越界回退必须 logger.warn 一次');
    assert.match(r.warnings[0], /回退默认入口/, '告警必须说明回退到默认入口');
  }

  // 4. 接线兜底：createWindow 必须经校验函数取入口；解析器本体必须做包含性判定
  assert.match(main, /const rendererEntry = resolveRendererEntry\(\)/,
    'createWindow 必须经 resolveRendererEntry 取入口，不得直接读 env');
  assert.match(declarations, /isStrictlyInside\(DIST_ROOT, dir\)/,
    '必须对 DIST_ROOT 做包含性判定（白名单之外一律回退）');
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