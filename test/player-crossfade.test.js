/**
 * 生产播放器（Vue）无缝交叉。
 * player.ts 是 TypeScript，断言在带类型剥离的 player-crossfade.runner.js。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('交叉：缓冲好的邻歌重叠淡入淡出，中途收掉，不够条件时硬切', () => {
  const runner = path.join(__dirname, 'player-crossfade.runner.js');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', runner], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });
  assert.equal(r.status, 0, `${r.stdout || ''}\n${r.stderr || ''}`);
  assert.match(r.stdout, /player crossfade runner ok/);
});
