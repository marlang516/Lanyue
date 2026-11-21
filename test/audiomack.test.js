/**
 * Audiomack 音源：离线契约。
 *
 * 搜索 / 取流的真实网络由手工实测覆盖（见 PR 说明）。这里钉住：
 *   - 公开 OAuth 1.0 签名（固定 nonce / 时间戳的向量）
 *   - 搜索条目映射（秒 → 毫秒、只留歌曲、空歌手回退上传者）
 *   - 取流失败不得交出 URL（无 signedUrl、预检失败、空 id）
 *   - 链接识别只认 /{artist}/song/{slug}
 */

const test = require('node:test');
const assert = require('node:assert');
const audiomack = require('../src/api/platforms/audiomack');

const {
  mapItem,
  mapSearchPayload,
  oauthSign,
  decidePlay,
  SEARCH_PAGE_SIZE,
} = audiomack._internal;

const VECTOR_NONCE = 'FIXEDNONCEFIXEDNONCEFIXEDNONCE12';
const VECTOR_TS = '1700000000';
const VECTOR_SIGNATURE = 'szDyn1ehndwgk0VDik4bPO0RDFU=';

test('oauthSign: 固定 nonce 与时间戳得到公开接口的签名向量', () => {
  const url = oauthSign('GET', 'https://api.audiomack.com/v1/livesearch', {
    q: 'Skepta',
    show: 'songs',
    sort: 'popular',
    limit: '20',
    page: '1',
  }, { nonce: VECTOR_NONCE, timestamp: VECTOR_TS });
  const parsed = new URL(url);
  assert.strictEqual(parsed.origin + parsed.pathname, 'https://api.audiomack.com/v1/livesearch');
  assert.strictEqual(parsed.searchParams.get('oauth_consumer_key'), 'audiomack-web');
  assert.strictEqual(parsed.searchParams.get('oauth_signature_method'), 'HMAC-SHA1');
  assert.strictEqual(parsed.searchParams.get('oauth_nonce'), VECTOR_NONCE);
  assert.strictEqual(parsed.searchParams.get('oauth_timestamp'), VECTOR_TS);
  assert.strictEqual(parsed.searchParams.get('oauth_signature'), VECTOR_SIGNATURE);
  assert.strictEqual(parsed.searchParams.get('show'), 'songs');
  assert.strictEqual(parsed.searchParams.get('limit'), '20');
});

test('oauthSign: 中文关键词留在查询值里，不进签名密钥', () => {
  const url = oauthSign('GET', 'https://api.audiomack.com/v1/livesearch', {
    q: '晴天', show: 'songs', limit: '20', page: '1',
  }, { nonce: VECTOR_NONCE, timestamp: VECTOR_TS });
  const parsed = new URL(url);
  assert.strictEqual(parsed.searchParams.get('q'), '晴天');
  assert.ok(!parsed.search.includes('bd8a07e9'), '消费者密钥不得出现在 URL');
});

test('mapItem: 时长按秒折成毫秒，歌手用署名而不是 featuring', () => {
  const song = mapItem({
    id: 5321130,
    type: 'song',
    title: 'BAD ENERGY STAY FAR (FREESTYLE)',
    artist: 'YOUNG PARIS',
    album: '',
    duration: '152',
    featuring: 'wizkid, skepta',
    image: 'https://i.audiomack.com/afrobeats-1/af04163a3b.webp',
    uploader: { name: 'SOME CHANNEL', url_slug: 'young-paris' },
  });
  assert.strictEqual(song.id, '5321130');
  assert.strictEqual(song.title, 'BAD ENERGY STAY FAR (FREESTYLE)');
  assert.strictEqual(song.artist, 'YOUNG PARIS');
  assert.strictEqual(song.album, '');
  assert.strictEqual(song.duration, 152000);
  assert.strictEqual(song.cover, 'https://i.audiomack.com/afrobeats-1/af04163a3b.webp');
  assert.strictEqual(song.source, 'audiomack');
});

test('mapItem: 空歌手回退到上传者显示名，封面回退 image_base', () => {
  const song = mapItem({
    id: 15137903,
    type: 'song',
    title: 'Obsessed With You',
    artist: '',
    album: 'Wild West',
    duration: 109,
    image_base: 'https://i.audiomack.com/centralcee/cover.webp',
    uploader: { name: 'Central Cee' },
  });
  assert.strictEqual(song.artist, 'Central Cee');
  assert.strictEqual(song.album, 'Wild West');
  assert.strictEqual(song.duration, 109000);
  assert.strictEqual(song.cover, 'https://i.audiomack.com/centralcee/cover.webp');
});

test('mapItem: 缺时长、专辑或非歌曲类型时丢弃或归零', () => {
  assert.strictEqual(mapItem({ id: 1, type: 'song', title: 'x' }).duration, 0);
  assert.strictEqual(mapItem({ id: 1, type: 'song', title: 'x', duration: 'abc' }).duration, 0);
  assert.strictEqual(mapItem({ id: 1, type: 'album', title: 'An Album', artist: 'A' }), null);
  assert.strictEqual(mapItem({ type: 'song', title: 'no id' }), null);
  assert.strictEqual(mapItem({ id: 1, type: 'song', title: '   ' }), null);
  assert.strictEqual(mapItem(null), null);
});

test('mapItem: 标题里的标签与实体不进结果', () => {
  const song = mapItem({
    id: 3,
    type: 'song',
    title: '<em>晴天</em>',
    artist: 'A &amp; B',
    duration: '10',
  });
  assert.strictEqual(song.title, '晴天');
  assert.strictEqual(song.artist, 'A & B');
});

test('mapSearchPayload: 只保留歌曲，脏条目被滤掉', () => {
  const songs = mapSearchPayload({
    results: [
      { id: 1, type: 'song', title: 'One', artist: 'A', duration: '10' },
      { id: 2, type: 'album', title: 'Skip', artist: 'A' },
      { id: '', type: 'song', title: 'No Id' },
      null,
    ],
  });
  assert.deepStrictEqual(songs.map((s) => s.id), ['1']);
});

test('mapSearchPayload: 非对象或没有 results 时返回空数组', () => {
  assert.deepStrictEqual(mapSearchPayload(null), []);
  assert.deepStrictEqual(mapSearchPayload({}), []);
  assert.deepStrictEqual(mapSearchPayload({ results: {} }), []);
});

test('decidePlay: 预检通过才返回直链', () => {
  const ok = decidePlay(
    { signedUrl: 'https://music.audiomack.com/track.m4a?sig=1' },
    { ok: true, ext: 'm4a', sizeBytes: 3768968 },
  );
  assert.strictEqual(ok.url, 'https://music.audiomack.com/track.m4a?sig=1');
  assert.strictEqual(ok.ext, 'm4a');
  assert.strictEqual(ok.size, 3768968);
  assert.strictEqual(ok.via, 'official:music/play');
  assert.ok(!ok.error);
});

test('decidePlay: 没有 signedUrl 时明确失败，且不带 url', () => {
  const denied = decidePlay({ errorcode: 1005, message: 'Not authorized' }, { ok: false });
  assert.strictEqual(denied.code, 'UNAVAILABLE');
  assert.strictEqual(denied.fatal, true);
  assert.ok(denied.error.includes('Not authorized'));
  assert.ok(!('url' in denied));
});

test('decidePlay: 直链预检失败时不把断链交出去', () => {
  const dead = decidePlay(
    { signedUrl: 'https://music.audiomack.com/expired' },
    { ok: false, status: 403, reason: 'HTTP 403' },
  );
  assert.strictEqual(dead.code, 'CDN_EMPTY');
  assert.strictEqual(dead.fatal, true);
  assert.ok(!('url' in dead));
});

test('decidePlay: 非 https 直链视为不可播', () => {
  const bad = decidePlay({ signedUrl: 'http://music.audiomack.com/x' }, { ok: true });
  assert.strictEqual(bad.code, 'UNAVAILABLE');
  assert.ok(!('url' in bad));
});

test('search: 空关键词不请求网络', async () => {
  assert.deepStrictEqual(await audiomack.search('', 1), []);
  assert.deepStrictEqual(await audiomack.search(null, 1), []);
  assert.deepStrictEqual(await audiomack.search('   ', 1), []);
});

test('getUrl: 空 id 是参数错误，不请求网络', async () => {
  const r = await audiomack.getUrl('');
  assert.strictEqual(r.code, 'BAD_PARAMS');
  assert.strictEqual(r.fatal, true);
  assert.ok(!('url' in r));
});

test('链接识别: /artist/song/slug，不把专辑或别的站认进来', () => {
  const pat = audiomack.linkPatterns.find((p) => p.type === 'song');
  assert.ok(pat && typeof pat.extract === 'function');
  const hit = 'https://audiomack.com/young-paris/song/bad-energy-young-paris-tbr2?utm=1'
    .match(pat.re);
  assert.ok(hit);
  assert.strictEqual(pat.extract(hit), 'young-paris/bad-energy-young-paris-tbr2');
  const www = 'https://www.audiomack.com/en/centralcee/song/obsessed-with-you'.match(pat.re);
  assert.strictEqual(pat.extract(www), 'centralcee/obsessed-with-you');
  assert.strictEqual('https://audiomack.com/young-paris/album/some-album'.match(pat.re), null);
  assert.strictEqual('https://evil.audiomack.com.example/a/song/b'.match(pat.re), null);
});

test('manifest: 页大小、顺序、换源与发现页能力', () => {
  assert.strictEqual(audiomack.id, 'audiomack');
  assert.strictEqual(audiomack.name, 'Audiomack');
  assert.strictEqual(audiomack.policies.order, 90);
  assert.strictEqual(audiomack.policies.aggregateLimit, SEARCH_PAGE_SIZE);
  assert.strictEqual(SEARCH_PAGE_SIZE, 20);
  assert.strictEqual(audiomack.policies.fallbackSource, true);
  assert.strictEqual(audiomack.policies.probeable, true);
  assert.ok(audiomack.hosts.origins.includes('https://api.audiomack.com'));
  assert.ok(audiomack.hosts.origins.includes('https://music.audiomack.com'));
  for (const fn of ['getTopList', 'getRecommendPlaylists', 'getRanking', 'getCategoryPlaylists', 'getNewSongs']) {
    assert.strictEqual(audiomack[fn], undefined, `不应声明 ${fn}`);
  }
  assert.strictEqual(audiomack.getLyrics, undefined);
  assert.strictEqual(audiomack.verifyCookie, undefined);
});

test('search/getUrl: 用固定响应走完整映射与失败路径', async () => {
  const { mockRequest } = require('./helpers/platformStub');
  const calls = [];
  const bodies = {
    search: {
      results: [
        { id: 5321130, type: 'song', title: 'Energy', artist: 'Skepta', duration: '156' },
        { id: 9, type: 'album', title: 'Album', artist: 'Skepta' },
      ],
    },
    playOk: { signedUrl: 'https://music.audiomack.com/ok.m4a' },
    playDenied: { errorcode: 1005, message: 'Not authorized' },
    detail: { results: { id: 5321130, type: 'song', title: 'Energy', artist: 'Skepta', duration: '156' } },
  };
  let playMode = 'ok';
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/livesearch')) return bodies.search;
    if (String(url).includes('/music/song/')) return bodies.detail;
    if (String(url).includes('/music/play/')) {
      return playMode === 'denied' ? bodies.playDenied : bodies.playOk;
    }
    if (String(url).includes('/music/')) return bodies.detail;
    throw new Error('unexpected url');
  };
  impl.testAudioLink = async (url) => {
    calls.push('probe:' + url);
    if (String(url).includes('/ok.m4a')) return { ok: true, ext: 'm4a', sizeBytes: 1000 };
    return { ok: false, status: 403, reason: 'HTTP 403' };
  };
  const restore = mockRequest(impl);
  const platformPath = require.resolve('../src/api/platforms/audiomack');
  delete require.cache[platformPath];
  try {
    const fresh = require('../src/api/platforms/audiomack');
    const songs = await fresh.search('Skepta', 2);
    assert.deepStrictEqual(songs.map((s) => s.id), ['5321130']);
    assert.strictEqual(songs[0].duration, 156000);
    const searchUrl = calls.find((u) => u.includes('/livesearch'));
    assert.ok(searchUrl.includes('show=songs'), searchUrl);
    assert.ok(searchUrl.includes('limit=20'), searchUrl);
    assert.ok(searchUrl.includes('page=2'), searchUrl);
    assert.ok(searchUrl.startsWith('https://api.audiomack.com/v1/livesearch?'));

    calls.length = 0;
    const ok = await fresh.getUrl('5321130', 'lossless');
    assert.strictEqual(ok.url, 'https://music.audiomack.com/ok.m4a');
    assert.ok(calls.some((u) => u.includes('/music/play/5321130')));
    assert.ok(calls.some((u) => u.startsWith('probe:')));

    calls.length = 0;
    playMode = 'denied';
    const denied = await fresh.getUrl('11346339');
    assert.strictEqual(denied.code, 'UNAVAILABLE');
    assert.ok(!('url' in denied));
    assert.ok(!calls.some((u) => u.startsWith('probe:')), '没有直链时不应预检');

    calls.length = 0;
    playMode = 'ok';
    const fromLink = await fresh.getSongDetail('young-paris/bad-energy');
    assert.strictEqual(fromLink.id, '5321130');
    assert.strictEqual(fromLink.source, 'audiomack');
    assert.ok(calls.some((u) => u.includes('/music/song/young-paris/bad-energy')));
  } finally {
    restore();
    delete require.cache[platformPath];
  }
});
