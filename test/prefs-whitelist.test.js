/**
 * prefs 白名单漂移守护
 *
 * set-pref 有键白名单（src/main/ipc/prefs.js，H9 防任意键注入），但白名单是手写的：
 * 渲染层新增一个偏好键却忘了登记时，写入会被主进程静默拒绝（只打一行 warn），
 * 表现就是「这个设置重启就失效」。 勘探一次就抓出 9 个这类键
 * （fadeInMs / perSourceConcurrency / maxAttempts / autoLyric / autoCover …）。
 * 本测试把「渲染层会写的键」扫出来跟白名单对账，从此这类漂移当场变红。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ALLOWED_PREF_KEYS } = require('../src/main/ipc/prefs');

const RENDERER = path.join(__dirname, '../src/renderer');
// 设置视图已拆成多文件：GENERAL_PREFS 登记表住在 views/settings/general.js；
// 统一从聚合助手取「整视图」源码，避免测试焊死在某一个物理文件上。
const { readSettingsView } = require('./helpers/settingsViewSource.js');

/** 主进程内部维护、不经 set-pref 的键（与 quality.test.js 同口径） */
const MAIN_INTERNAL_KEYS = new Set(['userPlaylists', 'activeDownloadTemplate']);

function walkRendererSources(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkRendererSources(p, out);
    else if (/\.(js|ts|vue)$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** 渲染层实际会读写 prefs 的键：字面量访问 + 设置页 GENERAL_PREFS 登记表。 */
function rendererAccessedPrefKeys() {
  const keys = new Set();
  for (const file of walkRendererSources(RENDERER)) {
    const src = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const m of src.matchAll(/api\.setPref\(\s*'([A-Za-z0-9_]+)'/g)) keys.add(m[1]);
    for (const m of src.matchAll(/\bsetPref\(\s*'([A-Za-z0-9_]+)'/g)) keys.add(m[1]);
    for (const m of src.matchAll(/\bgetPref\(\s*'([A-Za-z0-9_]+)'/g)) keys.add(m[1]);
  }
  const block = readSettingsView().match(/const GENERAL_PREFS = \{[\s\S]*?\n\};/);
  assert.ok(block, '未找到设置页 GENERAL_PREFS 登记表（改名或挪走时请同步本测试）');
  for (const m of block[0].matchAll(/key:\s*'([A-Za-z0-9_]+)'/g)) keys.add(m[1]);
  return keys;
}

test('渲染层读写的每个 pref 键都在 set-pref 白名单里（否则读不到或写入后重启失效）', () => {
  const missing = [...rendererAccessedPrefKeys()]
    .filter((k) => !ALLOWED_PREF_KEYS.has(k) && !MAIN_INTERNAL_KEYS.has(k))
    .sort();
  assert.deepEqual(missing, [], '这些键未进 prefs 白名单: ' + missing.join(', '));
});

test('7f134d4 补录的 9 个键已在白名单（曾经静默被拒的设置项）', () => {
  for (const k of [
    'fadeInMs', 'fadeOutMs', 'perSourceConcurrency', 'maxAttempts',
    'autoLyric', 'autoCover', 'dismissedSongs', 'lyricsVisible', 'lyricOverrides',
  ]) {
    assert.ok(ALLOWED_PREF_KEYS.has(k), `${k} 未进 ALLOWED_PREF_KEYS`);
  }
});
