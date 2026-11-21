/**
 * 发现页把歌单 / 歌手摘要收成可播放的歌曲列表。
 *
 * 纯函数在 discoverFeed.ts：截断、去重、标来源，歌单再带上 id 和平台。不触网。
 * 视图侧钉「不再走卡片网格、电台分区不出现、播放舞台还在，
 * 以及点歌仍播当前榜、带来源身份的歌能打开那一个完整歌单」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// discoverFeed.ts 写的是无后缀 import（./song），node --test 解析不到。
// 跟歌词时钟那条 runner 用同一只钩子，不改生产模块的引用写法。
register(new URL('./esm-ts-resolve.mjs', import.meta.url).href, {
  parentURL: import.meta.url,
});

const {
  DISCOVER_FEED_CAPS,
  collectDiscoverBundles,
  discoverPlaylistOf,
  expandDiscoverFeed,
  readDiscoverSources,
} = await import('../src/renderer/app/core/discoverFeed.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function song(id, source, title, extra = {}) {
  return { id, source, title, artist: '歌手', album: '专辑', ...extra };
}

test('歌单摘要展开后，歌曲带来源歌单名，并保持歌单顺序', () => {
  const raw = song('1', 'netease', '稻香');
  const songs = expandDiscoverFeed([
    {
      summary: { id: 'p1', name: '华语经典 100 首', source: 'netease' },
      songs: [raw, song('2', 'netease', '后来')],
    },
    {
      summary: { id: 'p2', name: '独立民谣', source: 'netease' },
      songs: [song('3', 'netease', '理想三旬')],
    },
  ]);

  assert.deepEqual(songs.map((s) => s.title), ['稻香', '后来', '理想三旬']);
  assert.deepEqual(songs.map((s) => s.from), ['华语经典 100 首', '华语经典 100 首', '独立民谣']);
  assert.equal(raw.from, undefined, '不要改调用方手里的原对象');
});

test('歌手摘要用歌手名做来源标签', () => {
  const songs = expandDiscoverFeed([
    {
      summary: { id: 'mid1', name: '周杰伦', source: 'qq' },
      songs: [song('a', 'qq', '晴天'), song('b', 'qq', '夜曲')],
    },
  ]);
  assert.deepEqual(songs.map((s) => [s.title, s.from]), [
    ['晴天', '周杰伦'],
    ['夜曲', '周杰伦'],
  ]);
});

test('按 id + source 去重，保留先出现的那一条和它的来源', () => {
  const songs = expandDiscoverFeed([
    {
      summary: { id: 'p1', name: '甲', source: 'qq' },
      songs: [song('1', 'qq', '晴天'), song(1, 'qq', '晴天重复'), song('1', 'netease', '同号不同源')],
    },
    {
      summary: { id: 'p2', name: '乙', source: 'qq' },
      songs: [song('1', 'qq', '晴天又出现'), song('2', 'qq', '七里香')],
    },
  ], { perSource: 10, total: 20, sources: 6 });

  assert.deepEqual(songs.map((s) => `${s.source}:${s.id}:${s.from}`), [
    'qq:1:甲',
    'netease:1:甲',
    'qq:2:乙',
  ]);
});

test('同一来源里的重复不占名额，后面的新歌还能进来', () => {
  const songs = expandDiscoverFeed([
    {
      summary: { id: 'p', name: '甲', source: 'qq' },
      songs: [
        song('1', 'qq', '晴天'),
        song('1', 'qq', '晴天'),
        null,
        { title: '没有 id' },
        song('2', 'qq', '夜曲'),
      ],
    },
  ], { perSource: 2, total: 20, sources: 6 });

  assert.deepEqual(songs.map((s) => s.title), ['晴天', '夜曲']);
});

test('每个来源、来源个数、总条数都有上限', () => {
  const bundles = Array.from({ length: 8 }, (_, g) => ({
    summary: { id: `p${g}`, name: `歌单${g}`, source: 'kugou' },
    songs: Array.from({ length: 8 }, (__, i) => song(`g${g}-${i}`, 'kugou', `歌${g}-${i}`)),
  }));

  const bySource = expandDiscoverFeed(bundles, { sources: 8, perSource: 2, total: 50 });
  assert.equal(bySource.length, 16);
  assert.deepEqual(bySource.map((s) => s.title).slice(0, 4), ['歌0-0', '歌0-1', '歌1-0', '歌1-1']);

  const byGroups = expandDiscoverFeed(bundles, { sources: 2, perSource: 8, total: 50 });
  assert.deepEqual(new Set(byGroups.map((s) => s.from)), new Set(['歌单0', '歌单1']));

  const byTotal = expandDiscoverFeed(bundles);
  assert.equal(DISCOVER_FEED_CAPS.total, 20);
  assert.equal(byTotal.length, 20);
  assert.equal(byTotal[19].title, '歌3-1');
  assert.equal(byTotal.some((s) => s.from === '歌单4'), false);
});

test('上限为 0 或输入不是数组时得到空列表', () => {
  const one = [{ summary: { id: 'p', name: '甲', source: 'qq' }, songs: [song('1', 'qq', '晴天')] }];
  assert.deepEqual(expandDiscoverFeed(one, { total: 0 }), []);
  assert.deepEqual(expandDiscoverFeed(one, { perSource: 0 }), []);
  assert.deepEqual(expandDiscoverFeed(one, { sources: 0 }), []);
  assert.deepEqual(expandDiscoverFeed(null), []);
  assert.deepEqual(expandDiscoverFeed([{ summary: { name: '甲' }, songs: 'nope' }]), []);
});

test('歌单展开带上这一个歌单的 id 和平台，不只留名称', () => {
  const raw = song('1', 'netease', '稻香', { fromPlaylist: { id: 'old', source: 'qq', name: '旧' } });
  const songs = expandDiscoverFeed([
    {
      summary: { id: ' p1 ', name: '  华语经典  ', source: ' netease ', kind: 'playlist' },
      songs: [raw, song('2', 'netease', '后来')],
    },
    {
      summary: { id: 'p2', name: '独立民谣', source: 'kugou', kind: 'playlist' },
      songs: [song('3', 'kugou', '理想三旬')],
    },
  ]);

  assert.deepEqual(songs.map((s) => discoverPlaylistOf(s)), [
    { id: 'p1', source: 'netease', name: '华语经典' },
    { id: 'p1', source: 'netease', name: '华语经典' },
    { id: 'p2', source: 'kugou', name: '独立民谣' },
  ]);
  assert.deepEqual(songs.map((s) => s.from), ['华语经典', '华语经典', '独立民谣']);
  assert.deepEqual(raw.fromPlaylist, { id: 'old', source: 'qq', name: '旧' }, '不要改调用方手里的原对象');
  assert.notEqual(songs[0], raw);
});

test('去重后歌单身份跟先出现的那一首，不跟后一个歌单', () => {
  const songs = expandDiscoverFeed([
    {
      summary: { id: 'p1', name: '甲', source: 'qq', kind: 'playlist' },
      songs: [song('1', 'qq', '晴天')],
    },
    {
      summary: { id: 'p2', name: '乙', source: 'qq', kind: 'playlist' },
      songs: [song('1', 'qq', '晴天又出现'), song('2', 'qq', '七里香')],
    },
  ]);
  assert.deepEqual(songs.map((s) => [s.title, discoverPlaylistOf(s)]), [
    ['晴天', { id: 'p1', source: 'qq', name: '甲' }],
    ['七里香', { id: 'p2', source: 'qq', name: '乙' }],
  ]);
});

test('歌手、未标成歌单、或缺 id / 平台时，不留下可打开的歌单身份', () => {
  const songs = expandDiscoverFeed([
    {
      summary: { id: 'mid', name: '周杰伦', source: 'qq', kind: 'singer' },
      songs: [song('a', 'qq', '晴天', { fromPlaylist: { id: 'fake', source: 'qq', name: '假歌单' } })],
    },
    {
      summary: { id: 'p', name: '只有名字', source: 'netease' },
      songs: [song('b', 'netease', '后来')],
    },
    {
      summary: { id: '  ', name: '空白 id', source: 'qq', kind: 'playlist' },
      songs: [song('c', 'qq', '夜曲')],
    },
    {
      summary: { id: 'p9', name: '没有平台', source: '  ', kind: 'playlist' },
      songs: [song('d', 'qq', '七里香')],
    },
  ]);
  assert.equal(songs[0].from, '周杰伦');
  assert.deepEqual(songs.map((s) => s.fromPlaylist), [undefined, undefined, undefined, undefined]);
  assert.deepEqual(songs.map((s) => discoverPlaylistOf(s)), [null, null, null, null]);
});

test('歌单没有名字时仍然留下 id 和平台，from 留空', () => {
  const songs = expandDiscoverFeed([
    {
      summary: { id: 'p9', name: '   ', source: 'kugou', kind: 'playlist' },
      songs: [song('1', 'kugou', '歌', { from: '假来源' })],
    },
  ]);
  assert.equal(songs[0].from, undefined);
  assert.deepEqual(discoverPlaylistOf(songs[0]), { id: 'p9', source: 'kugou', name: '' });
});

test('discoverPlaylistOf 拒绝只有名称、缺平台或坏形状', () => {
  assert.equal(discoverPlaylistOf(null), null);
  assert.equal(discoverPlaylistOf({ from: '华语经典' }), null);
  assert.equal(discoverPlaylistOf({ fromPlaylist: { name: '华语经典' } }), null);
  assert.equal(discoverPlaylistOf({ fromPlaylist: { id: 'p', source: '  ', name: '甲' } }), null);
  assert.equal(discoverPlaylistOf({ fromPlaylist: 'p1' }), null);
  assert.deepEqual(
    discoverPlaylistOf({ fromPlaylist: { id: 7, source: 'qq', name: '  甲  ' } }),
    { id: '7', source: 'qq', name: '甲' },
  );
});

test('来源名会去掉空白；没有名字就不标 from，歌曲自带的 from 也不沿用', () => {
  const songs = expandDiscoverFeed([
    {
      summary: { id: 'p1', name: '  华语经典  ', source: 'netease' },
      songs: [song('1', 'netease', '稻香', { from: '假来源' })],
    },
    {
      summary: { id: 'p2', name: '   ', source: 'netease' },
      songs: [song('2', 'netease', '后来', { from: '假来源' })],
    },
  ]);
  assert.equal(songs[0].from, '华语经典');
  assert.equal(songs[1].from, undefined);
});

test('歌曲缺 source 时用来源摘要上的平台，已有 source 不被覆盖', () => {
  const songs = expandDiscoverFeed([
    {
      summary: { id: 'p', name: '甲', source: 'netease' },
      songs: [
        { id: '1', title: '稻香', artist: '周杰伦' },
        song('2', 'qq', '晴天'),
      ],
    },
  ]);
  assert.equal(songs[0].source, 'netease');
  assert.equal(songs[0].title, '稻香');
  assert.equal(songs[1].source, 'qq');
});

test('readDiscoverSources 只留下有 id 的歌单或歌手，并套上来源个数上限', () => {
  const rows = [
    null,
    { name: '没有 id' },
    { id: '  ', name: '空白 id' },
    { id: 'p1', name: '歌单', title: '别用标题', source: 'qq', cover: 'c' },
    { mid: 'singerMid', name: '周杰伦', avatar: 'a' },
    { id: 42, title: '只有标题', platform: 'kugou' },
    { id: 'p2', name: '多出来的' },
  ];
  const refs = readDiscoverSources(rows, 3, 'qq');
  assert.deepEqual(refs, [
    { id: 'p1', name: '歌单', source: 'qq' },
    { id: 'singerMid', name: '周杰伦', source: 'qq' },
    { id: '42', name: '只有标题', source: 'kugou' },
  ]);
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, name: `名${i}`, source: 'qq' }));
  assert.equal(readDiscoverSources(many).length, DISCOVER_FEED_CAPS.sources);
  assert.equal(readDiscoverSources(many)[0].id, 's0');
  assert.deepEqual(readDiscoverSources('nope'), []);
  assert.deepEqual(readDiscoverSources(many, 0), []);
});

test('单个来源拉取失败时丢掉这一组，其它来源按原顺序保留', async () => {
  const seen = [];
  const bundles = await collectDiscoverBundles(
    [
      { id: 'a', name: '甲', source: 'qq' },
      { id: 'b', name: '乙', source: 'netease' },
    ],
    async (ref) => {
      seen.push(ref.id);
      if (ref.id === 'a') throw new Error('down');
      return [song('2', 'netease', '后来')];
    },
  );
  assert.deepEqual(seen, ['a', 'b']);
  const songs = expandDiscoverFeed(bundles);
  assert.deepEqual(songs.map((s) => s.title), ['后来']);
  assert.equal(songs[0].from, '乙');
});

test('发现页用榜单列表而不是歌单卡片，热门电台不出现，播放舞台仍在', () => {
  const view = read('src/renderer/app/views/DiscoverView.vue');
  const store = read('src/renderer/app/stores/discover.ts');
  assert.doesNotMatch(view, /PlaylistCard/);
  assert.match(view, /DiscoverRankList/);
  assert.match(view, /PlaylistPeek/);
  assert.match(view, /class="rank-skel"/);
  assert.doesNotMatch(view, /aspect-ratio:\s*1\s*\/\s*1/);
  assert.match(view, /playFromList\(st\.value\.data/);
  assert.doesNotMatch(store, /sec:\s*'qq\.radio'/);
  assert.match(store, /expand:\s*'playlist'/);
  assert.match(store, /expand:\s*'singer'/);
  assert.match(store, /getPlaylistSongs/);
  assert.match(store, /getSingerSongs/);
  assert.match(store, /expandDiscoverFeed/);
  assert.match(view, /未在播放/);
  assert.match(view, /class="wash"/);
  assert.match(view, /打开全屏歌词/);
});

test('点歌仍从当前榜播放，带来源身份的歌另开那一个完整歌单', () => {
  const view = read('src/renderer/app/views/DiscoverView.vue');
  const list = read('src/renderer/app/components/data/DiscoverRankList.vue');
  const peek = read('src/renderer/app/components/data/PlaylistPeek.vue');
  const store = read('src/renderer/app/stores/discover.ts');

  assert.match(view, /function onPlay[\s\S]*?playFromList\(st\.value\.data/);
  assert.match(view, /@play="onPlay"/);
  assert.match(view, /@open-playlist="openPlaylist"/);
  assert.match(view, /<PlaylistPeek :open="peek\.open"/);
  assert.doesNotMatch(view, /PlaylistCard/);
  assert.doesNotMatch(list, /playFromList|getPlaylistSongs|getSingerSongs/);

  assert.match(list, /discoverPlaylistOf/);
  assert.match(list, /v-if="firstPlaylist"/);
  assert.match(list, /v-if="playlistOf\(s\)"/);
  assert.match(list, /v-else-if="fromOf\(s\)"/);
  assert.match(list, /emit\('play'/);
  assert.match(list, /emit\('openPlaylist'/);
  // 播放按钮先闭合，来源按钮在它后面，两块点击面不叠在一起。
  assert.match(list, /class="hero-play"[\s\S]*?<\/button>[\s\S]*class="origin link"/);
  assert.match(list, /class="hit-play"[\s\S]*?<\/button>[\s\S]*class="src link"/);
  // pointer-events 不继承，装饰层的子元素也必须让开，否则点歌名播不了。
  assert.match(list, /\.hero-copy \* \{ pointer-events: none; \}/);
  assert.match(list, /\.origin\.link \* \{ pointer-events: auto; \}/);
  assert.match(list, /\.hit > :not\(\.hit-play\) \* \{ pointer-events: none; \}/);
  assert.match(list, /\.hit > \.src\.link \* \{ pointer-events: auto; \}/);

  assert.match(peek, /call\('getPlaylistSongs', source, id, 300\)/);
  assert.match(peek, /loadSeq/);
  assert.match(peek, />重试</);
  assert.match(peek, /aria-label="关闭"/);
  assert.match(peek, /@mousedown\.self="emit\('close'\)"/);

  assert.match(store, /\.map\(\(ref\) => \(\{ \.\.\.ref, kind: expand \}\)\)/);
  assert.match(store, /if \(!expand\) return normalizeSongs\(data\)/);
});
