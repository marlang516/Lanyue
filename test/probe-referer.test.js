/**
 * 换源预检必须带上 Referer。
 *
 * resolveTrackService 会把取流结果作为 probeUrl 的第二参传出，但
 * api/index.js 的生产接线曾经只收 url。缺 Referer 时部分 CDN 回 200 + text/*，
 * 而 isDecisivelyDeadProbe 把 text/* 当成死链，能播的候选被丢掉。
 * 403 仍是不定证据，这里不改那条判据。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { playReferer, probeHeaders } = require('../src/shared/playReferer.mjs');

test('playReferer：结果自带 referer 优先，否则按平台表，未知平台为空', () => {
  assert.strictEqual(playReferer('qq', { referer: 'https://cdn.example/' }), 'https://cdn.example/');
  assert.strictEqual(playReferer('qq', {}), 'https://y.qq.com/');
  assert.strictEqual(playReferer('netease', null), 'https://music.163.com/');
  assert.strictEqual(playReferer('bilibili', {}), 'https://www.bilibili.com/');
  assert.strictEqual(playReferer('kugou', {}), '');
});

test('probeHeaders：有 Referer 才放进头，没有就不造空头', () => {
  assert.deepStrictEqual(probeHeaders({ source: 'qq' }), { Referer: 'https://y.qq.com/' });
  assert.deepStrictEqual(probeHeaders({ source: 'kugou', referer: '' }), {});
  assert.deepStrictEqual(probeHeaders(null), {});
});

test('生产接线：probeUrl 把第二参交给 probeHeaders，再传给 testAudioLink', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/api/index.js'), 'utf8');
  assert.match(src, /probeUrl:\s*\(url,\s*result\)\s*=>/,
    '丢掉第二参就会让候选预检不带 Referer');
  assert.match(src, /probeHeaders\(result\)/);
  assert.match(src, /testAudioLink\(url,\s*\{[^}]*headers:\s*probeHeaders\(result\)/);
});
