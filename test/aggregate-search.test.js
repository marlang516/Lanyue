/**
 * 全部平台搜索的分页与截断。
 *
 * 2026-11 实测「周杰伦」：酷狗 total=480 且每页 30，酷我 TOTAL=3600 且每页 30，
 * QQ 每页 30，咪咕 totalCount=401 且每页 20，5sing totalCount=5047 且每页 10。
 * 旧实现把 page 写死成 1，再按 aggregateLimit（网易/QQ 10、其余 5）slice，
 * 已经取回的歌在进 UI 之前被丢掉，翻页也拿不回下一页。
 *
 * 本文件钉纯函数口径，不触网。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  planAggregateSearch,
  clipAggregateSongs,
  aggregateHasMore,
} = require('../src/api/services/aggregateSearch');

function songs(source, n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${source}-${i}`,
    title: '晴天',
    artist: '周杰伦',
    source,
  }));
}

test('请求的页码会传给每个源；非法页码落回第 1 页', () => {
  const plugins = [
    { id: 'netease', _policies: { aggregateLimit: 30 } },
    { id: 'kugou', _policies: { aggregateLimit: 30 } },
  ];
  assert.strictEqual(planAggregateSearch(plugins, 2).page, 2);
  assert.strictEqual(planAggregateSearch(plugins, '3').page, 3);
  assert.strictEqual(planAggregateSearch(plugins, 0).page, 1);
  assert.strictEqual(planAggregateSearch(plugins, -4).page, 1);
  assert.strictEqual(planAggregateSearch(plugins, 'foo').page, 1);
  assert.strictEqual(planAggregateSearch(plugins).page, 1);
});

test('周杰伦：一页已经取回的歌按该源页大小保留，不再削成 5/10 条预览', () => {
  // 酷狗这一页实际返回 30 首。旧 aggregateLimit=5 会丢掉 25 首。
  const page = songs('kugou', 30);
  assert.strictEqual(clipAggregateSongs(page, 30).length, 30);
  assert.strictEqual(clipAggregateSongs(page, 5).length, 5);

  const plugins = [
    { id: 'netease', _policies: { aggregateLimit: 30 } },
    { id: 'qq', _policies: { aggregateLimit: 30 } },
    { id: 'bilibili', _policies: { aggregateLimit: 20 } },
    { id: 'kugou', _policies: { aggregateLimit: 30 } },
    { id: 'kuwo', _policies: { aggregateLimit: 30 } },
    { id: 'migu', _policies: { aggregateLimit: 20 } },
    { id: 'fivesing', _policies: { aggregateLimit: 10 } },
    { id: 'soda', _policies: { aggregateLimit: 20 } },
    { id: 'user:extra', _policies: { aggregateLimit: 0 } },
  ];
  const plan = planAggregateSearch(plugins, 1);
  const groups = plan.slots.map((slot) => ({
    source: slot.id,
    limit: slot.limit,
    songs: clipAggregateSongs(songs(slot.id, slot.limit > 0 ? slot.limit : 30), slot.limit),
  }));
  const kept = groups.reduce((n, g) => n + g.songs.length, 0);
  // 8 个内置源的一整页：30+30+20+30+30+20+10+20。用户源 limit=0 不参与。
  assert.strictEqual(kept, 190);
  assert.strictEqual(groups.find((g) => g.source === 'user:extra').songs.length, 0);
  assert.strictEqual(aggregateHasMore(groups), true);
});

test('searchMusic 把计划页码传给每个源，不再把全部平台写死成第 1 页', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/api/index.js'), 'utf8');
  assert.match(src, /planAggregateSearch\(allPlugins,\s*page\)/);
  // M1：聚合走 searchRaw（不吞错），页码仍须透传 plan.page
  assert.match(src, /gateway\.searchRaw\(id,\s*keyword,\s*plan\.page\)/);
  assert.match(src, /clipAggregateSongs\(r\.value,\s*slot\.limit\)/);
  assert.doesNotMatch(src, /gateway\.searchRaw\(id,\s*keyword,\s*1\)/);
});

test('没人返回满页时没有下一页；limit<=0 即使带着歌也不算满页', () => {
  assert.strictEqual(aggregateHasMore([
    { songs: songs('netease', 12), limit: 30 },
    { songs: songs('fivesing', 3), limit: 10 },
  ]), false);
  assert.strictEqual(aggregateHasMore([
    { songs: songs('kugou', 30), limit: 30 },
  ]), true);
  assert.strictEqual(aggregateHasMore([
    { songs: songs('user', 30), limit: 0 },
  ]), false);
  assert.strictEqual(clipAggregateSongs(songs('user', 8), 0).length, 0);
  assert.strictEqual(clipAggregateSongs(null, 30).length, 0);
});
