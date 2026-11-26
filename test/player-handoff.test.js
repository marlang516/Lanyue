/**
 * 生产播放器（Vue）单源交接。
 * player.ts 是 TypeScript，断言在带类型剥离的 player-handoff.runner.js。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('交接：隐藏预热、只留一路出声，关掉后重叠交叉仍在', () => {
  const runner = path.join(__dirname, 'player-handoff.runner.js');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', runner], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });
  assert.equal(r.status, 0, `${r.stdout || ''}\n${r.stderr || ''}`);
  assert.match(r.stdout, /player handoff runner ok/);
});
