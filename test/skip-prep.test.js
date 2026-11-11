/**
 * 切歌预取：下一首/上一首的流地址必须在点击之前就开始解析。
 *
 * 生产播放器（stores/player.ts）点下一首才串行 getDownloadUrlSmart + proxyPlay，
 * 这两次往返就是「切歌要缓冲一下才出声」的应用侧延迟。本模块把可预测的邻居
 * 提前解析好；播放器拿已有结果开播，不再等一次新的取流。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkipPrep, neighborIndex, prepKey, PREP_RETRY_MS } from '../src/renderer/js/skipPrep.js';

function song(id, extra = {}) {
  return { id, source: 'netease', title: id, ...extra };
}

const queue = [song('a'), song('b'), song('c')];

test('邻居下标：顺序/列表循环可预测，随机和单曲不预取', () => {
  assert.equal(neighborIndex(3, 0, 'order', 1), 1);
  assert.equal(neighborIndex(3, 0, 'order', -1), null, '顺序模式队首没有上一首');
  assert.equal(neighborIndex(3, 2, 'order', 1), null, '顺序模式队尾没有下一首');
  assert.equal(neighborIndex(3, 2, 'list-loop', 1), 0);
  assert.equal(neighborIndex(3, 0, 'list-loop', -1), 2);
  assert.equal(neighborIndex(3, 1, 'single', 1), null);
  assert.equal(neighborIndex(3, 1, 'shuffle', 1), null);
  assert.equal(neighborIndex(1, 0, 'list-loop', 1), null, '只有一首时邻居还是自己');
  assert.equal(neighborIndex(3, -1, 'order', 1), null);
  assert.equal(neighborIndex(0, 0, 'order', 1), null);
});

test('预取键带音质；本地文件也有键，拖入行没有', () => {
  assert.equal(prepKey(song('A'), 'hq'), 'netease:a:hq', 'source 与 id 归一成小写/去空白');
  assert.equal(prepKey({ id: '1', source: 'qq', filePath: '/a.mp3' }, 'standard'), 'qq:1:standard');
  assert.equal(prepKey({ id: '1', source: 'drop' }, 'standard'), null);
  assert.equal(prepKey({ source: 'netease' }, 'standard'), null);
  assert.equal(prepKey(null, 'standard'), null);
});

test('arm 立刻解析下一首和上一首，不解析当前，join 不重复请求', async () => {
  const calls = [];
  const events = [];
  const prep = createSkipPrep({
    resolve: async (s) => {
      calls.push(s.id);
      events.push('resolve:' + s.id);
      return { fileUrl: 'stream://' + s.id };
    },
    onReady: ({ key }) => events.push('ready:' + key),
  });
  prep.arm({ queue, index: 1, mode: 'order', quality: 'standard' });
  assert.deepEqual(calls.slice().sort(), ['a', 'c'], '当前这首不该再取一次流');

  const hit = await prep.join(queue[2], 'standard');
  events.push('join');
  assert.equal(hit.fileUrl, 'stream://c');
  assert.ok(events.indexOf('ready:netease:c:standard') < events.indexOf('join'),
    '元素必须在 join 返回前挂上 URL，否则播放器会再开一条冷连接');
  assert.equal(calls.filter((id) => id === 'c').length, 1);

  const again = await prep.join(queue[2], 'standard');
  assert.equal(again.fileUrl, 'stream://c');
  assert.equal(calls.filter((id) => id === 'c').length, 1, '已经解析过的邻居不能再打一次平台');
});

test('点击发生在解析完成前：共用同一次 in-flight，不另起请求', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const prep = createSkipPrep({
    resolve: async (s) => {
      calls += 1;
      await gate;
      return { fileUrl: 'stream://' + s.id };
    },
  });
  prep.arm({ queue, index: 0, mode: 'order', quality: 'standard' });
  const pending = prep.join(queue[1], 'standard');
  assert.equal(calls, 1);
  assert.equal(prep.isInflight(queue[1], 'standard'), true);
  release();
  const hit = await pending;
  assert.equal(hit.fileUrl, 'stream://b');
  assert.equal(calls, 1);
});

test('join 在 arm 之前返回 null，不挂起', async () => {
  const prep = createSkipPrep({
    resolve: async () => ({ fileUrl: 'stream://x' }),
  });
  assert.equal(await prep.join(queue[1], 'standard'), null);
});

test('切到下一首后丢掉不再相邻的缓存，并用 holdKey 保住正在接手的那首', async () => {
  const dropped = [];
  const calls = [];
  const prep = createSkipPrep({
    resolve: async (s) => {
      calls.push(s.id);
      return { fileUrl: 'stream://' + s.id };
    },
    onDrop: (key) => dropped.push(key),
  });
  prep.arm({ queue, index: 0, mode: 'order', quality: 'standard' });
  await prep.join(queue[1], 'standard');
  assert.deepEqual(calls, ['b']);

  dropped.length = 0;
  prep.arm({
    queue, index: 1, mode: 'order', quality: 'standard',
    holdKey: prepKey(queue[1], 'standard'),
  });
  await prep.join(queue[2], 'standard');
  assert.equal(dropped.includes(prepKey(queue[1], 'standard')), false, '正在播放/接手的歌不能被拆掉');
  assert.ok(calls.includes('a') && calls.includes('c'));

  prep.arm({ queue, index: 1, mode: 'order', quality: 'standard' });
  assert.ok(dropped.includes(prepKey(queue[1], 'standard')), '松手后当前歌不再占预取位');
});

test('已经缓冲好的邻居不再解析；失败冷却期内不重试', async () => {
  let now = 1_000;
  const calls = [];
  const prep = createSkipPrep({
    now: () => now,
    resolve: async (s) => {
      calls.push(s.id);
      if (s.id === 'c') return null;
      return { fileUrl: 'stream://' + s.id };
    },
    skipNote: true,
  });
  prep.arm({
    queue,
    index: 1,
    mode: 'order',
    quality: 'standard',
    skipResolve: (s) => s.id === 'a',
  });
  await prep.join(queue[2], 'standard');
  assert.deepEqual(calls, ['c'], 'a 已有缓冲，不该再取流');
  assert.equal(await prep.join(queue[2], 'standard'), null);

  calls.length = 0;
  prep.arm({ queue, index: 1, mode: 'order', quality: 'standard', skipResolve: (s) => s.id === 'a' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, [], '失败后立刻再 arm 不得打风暴');

  now += PREP_RETRY_MS;
  prep.arm({ queue, index: 1, mode: 'order', quality: 'standard', skipResolve: (s) => s.id === 'a' });
  await prep.join(queue[2], 'standard');
  assert.deepEqual(calls, ['c'], '冷却结束后允许再试一次');
});

test('invalidate 之后迟到的解析不得 onReady', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = [];
  const prep = createSkipPrep({
    resolve: async (s) => {
      await gate;
      return { fileUrl: 'stream://' + s.id };
    },
    onReady: ({ key }) => ready.push(key),
  });
  prep.arm({ queue, index: 0, mode: 'order', quality: 'standard' });
  prep.invalidate();
  release();
  await prep.join(queue[1], 'standard');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(ready, []);
  assert.equal(prep.readyCount(), 0);
});

test('随机模式不预取；换音质是另一条键', async () => {
  const calls = [];
  const prep = createSkipPrep({
    resolve: async (s, quality) => {
      calls.push(quality + ':' + s.id);
      return { fileUrl: `stream://${s.id}?q=${quality}` };
    },
  });
  prep.arm({ queue, index: 1, mode: 'shuffle', quality: 'standard' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, []);

  prep.arm({ queue, index: 0, mode: 'order', quality: 'standard' });
  await prep.join(queue[1], 'standard');
  prep.arm({ queue, index: 0, mode: 'order', quality: 'hq' });
  const hit = await prep.join(queue[1], 'hq');
  assert.equal(hit.fileUrl, 'stream://b?q=hq');
  assert.ok(calls.includes('standard:b') && calls.includes('hq:b'));
});
