/**
 * avoidSource：播放条一键换源交给现有 resolve()。
 *
 * 不新写匹配。跳过用户正在听的那一个源，其余仍走
 * 本源 / 候选 / rankByHealth / 最多试 3 个。
 * 未传或脏值时与今天逐字一致。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResolveTrackService } = require('../src/api/services/resolveTrackService');

function makeHealth(rankFn) {
  const calls = [];
  return {
    calls,
    recordResult: (s, ok) => calls.push([s, !!ok]),
    rankByHealth: rankFn || ((a) => a),
  };
}

const ok = (extra = {}) => ({ url: 'https://cdn/x.mp3', ext: 'mp3', ...extra });
const fail = (code = 'VIP_REQUIRED') => ({ error: '没有音源', code });

function makeGetUrl(map) {
  const calls = [];
  const fn = async (id, source) => {
    calls.push([source, String(id)]);
    const key = `${source}:${id}`;
    if (!(key in map)) return { error: `未知数据源: ${source}`, code: 'UNKNOWN_SOURCE' };
    return map[key];
  };
  fn.calls = calls;
  return fn;
}

const SONG = { id: '1', source: 'netease', title: '晴天', artist: '周杰伦', duration: 269000 };

function build(map, opts = {}) {
  const health = opts.health || makeHealth();
  const findCalls = [];
  const getUrl = opts.getUrl || makeGetUrl(map);
  const findCandidates = opts.findCandidates || (async () => {
    findCalls.push(true);
    return opts.candidates || [];
  });
  const svc = createResolveTrackService({
    getUrl,
    searchFn: async () => [],
    hasCookie: () => false,
    findCandidates,
    sourceHealth: health,
    fallbackEnabled: opts.fallbackEnabled,
    switchDeadlineMs: opts.switchDeadlineMs,
  });
  return { svc, health, getUrl, findCalls };
}

test('avoidSource 未传：本源成功时不搜候选（零回归）', async () => {
  const { svc, getUrl, findCalls } = build({ 'netease:1': ok() });
  const r = await svc.resolve(SONG, 'standard');
  assert.equal(r.url, 'https://cdn/x.mp3');
  assert.deepEqual(getUrl.calls, [['netease', '1']]);
  assert.equal(findCalls.length, 0);
});

test('一键离开当前源：不重试本源，按健康度先试别的源', async () => {
  const ranked = [];
  const health = makeHealth((items) => {
    ranked.push(items.map((it) => it.source));
    return [...items].reverse();
  });
  const candidates = [
    { id: 'k1', source: 'kuwo', title: '晴天', artist: '周杰伦' },
    { id: 'q1', source: 'qq', title: '晴天', artist: '周杰伦' },
  ];
  const { svc, getUrl } = build({
    'qq:q1': ok(),
    'kuwo:k1': ok(),
  }, { health, candidates });
  const r = await svc.resolve(SONG, 'standard', { allowToggleSource: true, avoidSource: 'netease' });
  assert.equal(r.source, 'qq', 'rankByHealth 把原序反转后应先试 qq');
  assert.deepEqual(ranked[0], ['kuwo', 'qq']);
  assert.deepEqual(getUrl.calls, [['qq', 'q1']]);
  assert.equal(r.matchedSong.source, 'qq');
  assert.equal(health.calls.some((row) => row[0] === 'netease'), false, '被跳过的源不记失败');
});

test('正在听的是记忆源时，换源跳过它并回试本源', async () => {
  const song = { ...SONG, _altSource: { source: 'kuwo', id: 'k9' } };
  const { svc, getUrl } = build({
    'netease:1': ok({ source: 'netease' }),
    'kuwo:k9': ok({ source: 'kuwo' }),
  });
  const r = await svc.resolve(song, 'standard', { avoidSource: 'Kuwo' });
  assert.equal(r.source, 'netease');
  assert.deepEqual(getUrl.calls, [['netease', '1']]);
});

test('离开本源后，候选里正在听的源也被跳过', async () => {
  const song = { ...SONG, _altSource: { source: 'kuwo', id: 'k9' } };
  const { svc, getUrl } = build({
    'netease:1': fail('COPYRIGHT_RESTRICTED'),
    'kuwo:k2': ok(),
    'migu:m1': ok(),
  }, {
    candidates: [
      { id: 'k2', source: 'kuwo', title: '晴天', artist: '周杰伦' },
      { id: 'm1', source: 'migu', title: '晴天', artist: '周杰伦' },
    ],
  });
  const r = await svc.resolve(song, 'standard', { allowToggleSource: true, avoidSource: 'kuwo' });
  assert.equal(getUrl.calls[0][0], 'netease');
  assert.equal(getUrl.calls.some((row) => row[0] === 'kuwo'), false);
  assert.equal(r.source, 'migu');
});

test('没有其他可用源时返回人话，而不是空码', async () => {
  const { svc } = build({ 'kuwo:k1': fail('CDN_EMPTY') }, {
    candidates: [{ id: 'k1', source: 'kuwo', title: '晴天', artist: '周杰伦' }],
  });
  const r = await svc.resolve(SONG, 'standard', { allowToggleSource: true, avoidSource: 'netease' });
  assert.ok(!r.url);
  assert.match(String(r.error), /没有其他可用音源|没有音源|音源/);
  assert.notEqual(r.error, 'VIP_REQUIRED');
});

test('候选自己的失败码保留给文案层，不另造一套码', async () => {
  const { svc } = build({
    'qq:q1': fail('COPYRIGHT_RESTRICTED'),
  }, {
    candidates: [{ id: 'q1', source: 'qq', title: '晴天', artist: '周杰伦' }],
  });
  const r = await svc.resolve(SONG, 'standard', { allowToggleSource: true, avoidSource: 'netease' });
  assert.equal(r.code, 'COPYRIGHT_RESTRICTED');
  assert.equal(r.error, '没有音源');
});

test('avoidSource 脏值按未传处理', async () => {
  const { svc, getUrl, findCalls } = build({ 'netease:1': ok({ source: 'netease' }) });
  const r = await svc.resolve(SONG, 'standard', { avoidSource: 1 });
  assert.equal(r.source, 'netease');
  assert.deepEqual(getUrl.calls, [['netease', '1']]);
  assert.equal(findCalls.length, 0);
});

test('一键换源时候选取流卡住，到点返回人话而不是一直挂着', async () => {
  const { svc } = build({}, {
    switchDeadlineMs: 40,
    candidates: [{ id: 'q1', source: 'qq', title: '晴天', artist: '周杰伦' }],
    getUrl: () => new Promise(() => {}),
  });
  const started = Date.now();
  const r = await Promise.race([
    svc.resolve(SONG, 'standard', { allowToggleSource: true, avoidSource: 'netease' }),
    new Promise((resolve) => setTimeout(() => resolve({ error: 'TEST_STILL_PENDING' }), 200)),
  ]);
  assert.ok(Date.now() - started < 200, '不能把整段候选查找挂到测试兜底');
  assert.equal(r.error, '暂无法获取音源，请稍后重试');
  assert.ok(!r.url);
});

test('截止时间内候选取流成功，仍然换到那个源', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const getUrl = async (id, source) => {
    await gate;
    return ok({ source });
  };
  const { svc } = build({}, {
    switchDeadlineMs: 400,
    candidates: [{ id: 'q1', source: 'qq', title: '晴天', artist: '周杰伦' }],
    getUrl,
  });
  const pending = svc.resolve(SONG, 'standard', { allowToggleSource: true, avoidSource: 'netease' });
  setTimeout(release, 30);
  const r = await pending;
  assert.equal(r.source, 'qq');
  assert.ok(r.url);
});

test('总开关关闭且没有显式 allowToggle 时，avoidSource 不擅自搜候选', async () => {
  const { svc, findCalls } = build({ 'netease:1': fail() }, {
    fallbackEnabled: () => false,
    candidates: [{ id: 'q1', source: 'qq', title: '晴天', artist: '周杰伦' }],
  });
  const r = await svc.resolve(SONG, 'standard', { avoidSource: 'netease' });
  assert.equal(findCalls.length, 0);
  assert.ok(!r.url);
  assert.match(String(r.error), /没有其他可用音源/);
});
