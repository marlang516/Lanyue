/**
 * 搜索播放把 Vue 代理送过 IPC 时不得抛 DataCloneError。
 * player.ts / bridge.ts 是 TypeScript，node:test 默认不剥类型；
 * 断言写在 player-clone-ipc.runner.js。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('搜索播放：带 pay / _dupOf 的响应式歌曲仍能克隆并出声', () => {
  const runner = path.join(__dirname, 'player-clone-ipc.runner.js');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', runner], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });
  assert.equal(r.status, 0, `${r.stdout || ''}\n${r.stderr || ''}`);
  assert.match(r.stdout, /player clone ipc runner ok/);
});
