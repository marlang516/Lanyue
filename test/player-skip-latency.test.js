/**
 * 生产播放器（Vue）切歌时序。
 * player.ts 是 TypeScript，node:test 默认不剥类型；这里拉起带类型剥离的子进程，
 * 断言写在 player-skip-latency.runner.js。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('切歌：下一首在点击前就开始取流，命中预热的元素立刻出声', () => {
  const runner = path.join(__dirname, 'player-skip-latency.runner.js');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', runner], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });
  assert.equal(r.status, 0, `${r.stdout || ''}\n${r.stderr || ''}`);
  assert.match(r.stdout, /player skip latency runner ok/);
});
