/**
 * 生产播放器（Vue）切歌：交叉档位开着也立刻硬切。
 * player.ts 是 TypeScript，断言在带类型剥离的 player-crossfade.runner.js。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('切歌：交叉档位开着也立刻硬切；交叉途中再切落在正在进来的那首', () => {
  const runner = path.join(__dirname, 'player-crossfade.runner.js');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', runner], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });
  assert.equal(r.status, 0, `${r.stdout || ''}\n${r.stderr || ''}`);
  assert.match(r.stdout, /player crossfade runner ok/);
});
