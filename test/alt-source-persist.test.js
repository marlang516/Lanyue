/**
 * 换源记忆必须在写上的那一刻就能落盘。
 *
 * 播放队列的保存只订阅 playQueue / playIdx / loopMode / shuffle 的 setState。
 * 原地 song._altSource = … 不发通知，退出前若没有下一次队列变更，
 * play-queue.json 里没有这段记忆，下次仍先打已经失败的源。
 * 会话快照 _slimSessionSong 同样把这个字段裁掉了。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  assignAltSource,
  applyAltSourceToQueue,
  clearAltSourceInQueue,
  slimAltSource,
} = require('../src/shared/altSource');

test('assignAltSource：写成 {source, id} 字符串，坏输入不动原对象', () => {
  const song = { id: '1', source: 'netease' };
  assert.strictEqual(assignAltSource(song, { source: 'qq', id: 9 }), true);
  assert.deepStrictEqual(song._altSource, { source: 'qq', id: '9' });
  assert.strictEqual(assignAltSource(song, {}), false);
  assert.strictEqual(assignAltSource(null, { source: 'qq', id: '1' }), false);
});

test('applyAltSourceToQueue：歌在队列里（或队列里有同一首的另一份对象）才需要立刻 flush', () => {
  const song = { id: '1', source: 'netease', title: '晴天' };
  const queue = [song];
  assert.strictEqual(applyAltSourceToQueue(queue, song, { source: 'qq', id: '9' }), true);
  assert.deepStrictEqual(song._altSource, { source: 'qq', id: '9' });

  const copy = { id: '1', source: 'netease' };
  const held = { id: '1', source: 'netease' };
  assert.strictEqual(applyAltSourceToQueue([held], copy, { source: 'kugou', id: 'k' }), true);
  assert.deepStrictEqual(held._altSource, { source: 'kugou', id: 'k' });
  assert.deepStrictEqual(copy._altSource, { source: 'kugou', id: 'k' });

  const outsider = { id: '2', source: 'qq' };
  assert.strictEqual(applyAltSourceToQueue(queue, outsider, { source: 'kuwo', id: 'w' }), false);
  assert.deepStrictEqual(outsider._altSource, { source: 'kuwo', id: 'w' });
});

test('clearAltSourceInQueue：清掉记忆且队列里有这首歌时要求 flush', () => {
  const song = { id: '1', source: 'netease', _altSource: { source: 'qq', id: '9' } };
  assert.strictEqual(clearAltSourceInQueue([song], song), true);
  assert.strictEqual(song._altSource, undefined);
  const lone = { id: '3', source: 'qq', _altSource: { source: 'kuwo', id: '1' } };
  assert.strictEqual(clearAltSourceInQueue([], lone), false);
  assert.strictEqual(lone._altSource, undefined);
});

test('slimAltSource：只留 source 与 id，没有记忆时不造空对象', () => {
  assert.deepStrictEqual(slimAltSource({ _altSource: { source: 'qq', id: 9, cover: 'nope' } }), {
    source: 'qq', id: '9',
  });
  assert.strictEqual(slimAltSource({}), undefined);
  assert.strictEqual(slimAltSource({ _altSource: { source: '', id: '1' } }), undefined);
});

test('接线：播放入口用 rememberAltSource，会话瘦身保留 _altSource', () => {
  const root = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const player = read('src/renderer/js/player.js');
  assert.match(player, /rememberAltSource\(/);
  assert.match(player, /_altSource: slimAltSource\(s\)/);
  for (const rel of [
    'src/renderer/js/app.js',
    'src/renderer/js/views/home.js',
    'src/renderer/js/views/playlist/playback.js',
    'src/renderer/js/views/search.js',
  ]) {
    assert.match(read(rel), /rememberAltSource\(/, `${rel} 仍在原地写 _altSource`);
  }
  const audio = read('src/renderer/js/audio-events.js');
  assert.match(audio, /forgetAltSource\(/);
  assert.doesNotMatch(audio, /delete cur\._altSource/);
});
