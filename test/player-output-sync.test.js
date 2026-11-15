/**
 * Vue 播放器外发同步。
 * player.ts 是 TypeScript，node:test 默认不剥类型；行为断言在
 * player-output-sync.runner.js，这里只负责拉起并守住播放条上的接线。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('窗口打开的同步请求会强制推送带标题、封面和整份歌词的载荷', () => {
  const runner = path.join(__dirname, 'player-output-sync.runner.js');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', runner], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });
  assert.equal(r.status, 0, `${r.stdout || ''}\n${r.stderr || ''}`);
  assert.match(r.stdout, /player output sync runner ok/);
});

test('播放条：音量条约 140px 且不在 1080px 就藏起来，打开窗口后强制全量同步', () => {
  const src = read('src/renderer/app/components/player/PlayerBar.vue');
  assert.match(src, /width:\s*140px/);
  assert.match(src, /min-width:\s*140px/);
  assert.match(src, /height:\s*28px/);
  assert.match(src, /setVolume\(Number\(e\.target\.value\)\s*\/\s*100\)/);
  assert.match(src, /forceSyncOutputs\(\)/);
  const at1080 = src.slice(src.indexOf('@media (max-width: 1080px)'));
  const until820 = at1080.slice(0, at1080.indexOf('@media (max-width: 820px)'));
  assert.doesNotMatch(until820, /\.vol input\s*\{\s*display:\s*none/);
  assert.match(src, /@media \(max-width:\s*820px\)[\s\S]*\.vol input\s*\{\s*display:\s*none/);
});
