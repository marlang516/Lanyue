/**
 * 心动模式算法核（src/utils/heartbeatEngine.js）
 *
 * 算法核是纯函数 + 注入网关：这里用假网关把「种子提取 / 打分 / 去重 /
 * 排除 / 失败隔离 / 空种子回落」全部跑一遍，不依赖 electron 与网络。
 */

const test = require('node:test');
const assert = require('node:assert');
const engine = require('../src/utils/heartbeatEngine');

const song = (id, source, artist, extra = {}) => ({ id, source, title: `T-${id}`, artist, album: '', ...extra });

/** 首页推荐结构（与 api/recommendations.js#getHomeRecommendations 同源） */
function homeWith({ neteaseHot = [], qqTop = [], kugouHot = [], kugouTop500 = [] } = {}) {
  return {
    netease: { hot: neteaseHot },
    qq: { topList: qqTop },
    kugou: { hot: kugouHot, top500: kugouTop500 },
  };
}

test('songKey：source:id，缺任一项为空串', () => {
  assert.strictEqual(engine.songKey({ id: 1, source: 'netease' }), '1:netease');
  assert.strictEqual(engine.songKey({ id: 0, source: 'qq' }), '0:qq', 'id=0 也是合法 id');
  assert.strictEqual(engine.songKey({ id: null, source: 'qq' }), '');
  assert.strictEqual(engine.songKey({ id: 1 }), '');
  assert.strictEqual(engine.songKey(null), '');
});

test('extractSeedArtists：当前歌手 5 分、红心 1.5 分、去重且上限 20', () => {
  const favorites = [
    song('f1', 'netease', '林俊杰'),
    song('f2', 'qq', '周杰伦'),      // 与当前歌手重复，不重复计权
    song('f3', 'qq', '林俊杰'),      // 同一歌手重复，只计一次
    ...Array.from({ length: 40 }, (_, i) => song(`x${i}`, 'netease', `歌手${i}`)),
  ];
  const seed = engine.extractSeedArtists(song('c1', 'qq', '周杰伦'), favorites);
  assert.strictEqual(seed.current, '周杰伦');
  assert.strictEqual(seed.currentSource, 'qq');
  assert.strictEqual(seed.weights.get('周杰伦'), 5);
  assert.strictEqual(seed.weights.get('林俊杰'), 1.5);
  assert.strictEqual(seed.favorites.length, engine.MAX_SEED_ARTISTS, '红心歌手去重后仍受 20 上限约束');
});

test('extractSeedArtists：空入参安全返回空种子', () => {
  const seed = engine.extractSeedArtists(null, []);
  assert.strictEqual(seed.current, '');
  assert.strictEqual(seed.currentSource, '');
  assert.strictEqual(seed.weights.size, 0);
});

test('scoreSong：全等 5 分、合作曲 2 分、榜单 +2、同源 ×1.2', () => {
  const seed = engine.extractSeedArtists(song('c1', 'qq', '周杰伦'), [song('f1', 'netease', '林俊杰')]);
  assert.strictEqual(engine.scoreSong(song('a', 'netease', '周杰伦'), seed, { onTopList: false }), 5);
  assert.strictEqual(engine.scoreSong(song('b', 'netease', '周杰伦 / 费玉清'), seed, { onTopList: false }), 2);
  assert.strictEqual(engine.scoreSong(song('c', 'netease', '林俊杰'), seed, { onTopList: false }), 1.5);
  assert.strictEqual(engine.scoreSong(song('d', 'netease', '周杰伦'), seed, { onTopList: true }), 7);
  assert.strictEqual(engine.scoreSong(song('e', 'netease', '陌生人'), seed, { onTopList: true }), 2, '无关歌手只拿榜单分');
  assert.strictEqual(engine.scoreSong(song('f', 'qq', '周杰伦'), seed, { onTopList: false }), 6, '同源 ×1.2');
  assert.strictEqual(engine.scoreSong(song('g', 'qq', '周杰伦'), seed, { onTopList: true }), 8.4, '同源 ×1.2 与榜单加分成叠加');
  assert.strictEqual(engine.scoreSong(song('h', 'qq', '陌生人'), seed, { onTopList: true }), 2, '无关歌曲不被同源放大');
  assert.strictEqual(engine.scoreSong({ id: 9, source: 'qq' }, seed, { onTopList: true }), 0, '缺歌手不参与');
});

test('generate：排除当前歌/红心/队列，去重后按分数降序并带 score', async () => {
  const current = song('cur', 'qq', '周杰伦');
  const favorite = song('fav', 'netease', '林俊杰');
  const queueDup = song('qn', 'netease', '周杰伦');

  const gateway = {
    getHomeRecommendations: async () => homeWith({
      neteaseHot: [queueDup, song('n2', 'netease', '林俊杰'), favorite],
      qqTop: [current, song('q2', 'qq', '周杰伦')],
    }),
    searchSinger: async () => ({ singers: [] }),
    getSingerSongs: async () => [],
  };

  const out = await engine.generate({
    currentSong: current,
    favorites: [favorite],
    exclude: [queueDup],
    gateway,
  });

  const keys = out.map(engine.songKey);
  assert.deepStrictEqual(keys, ['q2:qq', 'n2:netease'], '当前歌/红心/队列里的歌全部排除，且按分数降序');
  assert.ok(out[0].score > out[1].score);
  assert.strictEqual(out[0]._onTopList, undefined, '内部标记得清掉');
});

test('generate：空种子回落热歌榜（榜单加分让它胜出）', async () => {
  const gateway = {
    getHomeRecommendations: async () => homeWith({
      neteaseHot: [song('h1', 'netease', '甲')],
      kugouTop500: [song('h2', 'kugou', '乙')],
    }),
    searchSinger: async () => ({ singers: [] }),
    getSingerSongs: async () => [],
  };
  const out = await engine.generate({ currentSong: null, favorites: [], gateway });
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((s) => s.score === 2), '无种子时全部候选同拿榜单分');
});

test('generate：单平台失败不阻塞其余候选', async () => {
  const gateway = {
    getHomeRecommendations: async () => { throw new Error('网易云超时'); },
    searchSinger: async (name) => {
      if (name === '周杰伦') return [{ mid: 'm1', source: 'qq' }];
      throw new Error('搜索歌手失败');
    },
    getSingerSongs: async (mid, limit, platform) => {
      if (platform === 'qq') return [song('s1', 'qq', '周杰伦')];
      throw new Error('歌手歌曲失败');
    },
  };
  const out = await engine.generate({
    currentSong: song('cur', 'qq', '周杰伦'),
    favorites: [song('f1', 'netease', '林俊杰')],
    gateway,
  });
  assert.deepStrictEqual(out.map(engine.songKey), ['s1:qq']);
});

test('generate：全部失败返回空数组，不抛错', async () => {
  const gateway = {
    getHomeRecommendations: async () => { throw new Error('x'); },
    searchSinger: async () => { throw new Error('y'); },
    getSingerSongs: async () => { throw new Error('z'); },
  };
  const out = await engine.generate({ currentSong: song('c', 'qq', '周杰伦'), gateway });
  assert.deepStrictEqual(out, []);
});

test('singerSongsFor：每个歌手最多解析 3 个平台，并用平台 mid 取歌', async () => {
  const calls = [];
  const gateway = {
    searchSinger: async () => ([
      { mid: 'm1', source: 'qq' },
      { mid: 'm2', source: 'netease' },
      { mid: 'm3', source: 'kugou' },
      { mid: 'm4', source: 'kuwo' },   // 超出 3 个，不应被请求
      { mid: '', source: 'migu' },     // 缺 mid，跳过
    ]),
    getSingerSongs: async (mid, limit, platform) => {
      calls.push(`${platform}:${mid}`);
      return [song(`${platform}-${mid}`, platform, '周杰伦')];
    },
  };
  const out = await engine.singerSongsFor(gateway, '周杰伦', 10);
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(calls.sort(), ['kugou:m3', 'netease:m2', 'qq:m1']);
  assert.strictEqual(out.length, 3);
});

test('generate：limit 超过上限按 30 截断、非法值回落默认', async () => {
  const many = Array.from({ length: 80 }, (_, i) => song(`m${i}`, 'netease', '甲'));
  const gateway = {
    getHomeRecommendations: async () => homeWith({ neteaseHot: many }),
    searchSinger: async () => ({ singers: [] }),
    getSingerSongs: async () => [],
  };
  assert.strictEqual((await engine.generate({ gateway, limit: 999 })).length, engine.FINAL_LIMIT);
  assert.strictEqual((await engine.generate({ gateway, limit: 'x' })).length, engine.FINAL_LIMIT);
});

test('generate：缺少 gateway 直接抛错（装配错误必须现形）', async () => {
  await assert.rejects(() => engine.generate({}), /缺少 gateway/);
});
