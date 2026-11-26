/**
 * 单源交接：audioPool 隐藏预热 + 只让一路出声，并与现有交叉并列可选。
 *
 * 取流与预热必须经 playback/wire.js。生产播放器不再自己调
 * getDownloadUrlSmart / proxyPlay，也不再自己发明第二套静音预热。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createAudioPool } from '../src/renderer/js/playback/audioPool.js';
import {
  HANDOFF_LEAD_MS,
  HANDOFF_PREF_KEY,
  decideCrossfade,
  decideTrackTransition,
} from '../src/renderer/js/playback/crossfade.js';
import { createPlayableResolver } from '../src/renderer/js/playback/wire.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function fakeEl(id) {
  return {
    id,
    src: '',
    volume: 1,
    muted: false,
    paused: true,
    error: null,
    preload: '',
    currentTime: 0,
    duration: 180,
    playCount: 0,
    pause() { this.paused = true; },
    play() {
      this.paused = false;
      this.playCount += 1;
      return Promise.resolve();
    },
    load() {},
  };
}

function poolOf(...els) {
  const elements = {};
  const gains = new Map();
  for (const el of els) elements[el.id] = el;
  const calls = [];
  const pool = createAudioPool({
    elements,
    applyOutput(el, gain) {
      gains.set(el, gain);
      el.volume = gain;
      calls.push({
        id: el.id,
        gain,
        muted: el.muted,
        audible: els.filter((item) => item.muted !== true && (gains.get(item) || 0) > 0).map((item) => item.id),
      });
    },
  });
  return { pool, calls, gains };
}

test('隐藏预热：备用元素拉过流，但全程不可闻', async () => {
  const primary = fakeEl('primary');
  const secondary = fakeEl('secondary');
  primary.volume = 0.8;
  primary.muted = false;
  const { pool, calls } = poolOf(primary, secondary);

  const started = pool.hiddenWarmup('secondary', 'lanyue-stream://next');
  assert.equal(started.ok, true);
  assert.equal(started.audible, false);
  assert.equal(secondary.src, 'lanyue-stream://next');
  assert.equal(secondary.muted, true);
  assert.equal(secondary.volume, 0);
  assert.equal(primary.muted, false, '正在听的那路不被预热改掉');

  await Promise.resolve();
  assert.equal(secondary.playCount, 1, '要点一下 play 浏览器才会真的缓冲');
  assert.equal(secondary.paused, true, '缓冲留下来，备用元素不再出声');
  assert.equal(secondary.muted, true);
  assert.equal(secondary.volume, 0);
  assert.equal(pool.isAudible('secondary'), false);
  assert.ok(calls.every((c) => c.id !== 'primary'), '预热不能去改正在听的增益');
  assert.ok(calls.every((c) => c.audible.length === 0), '预热的增益写入不能让任何槽变成可闻');
});

test('单源交接：先关掉出去的那路，再只打开进来的那路', async () => {
  const from = fakeEl('from');
  const to = fakeEl('to');
  from.src = 'lanyue-stream://a';
  from.paused = false;
  from.muted = false;
  from.volume = 0.8;
  const { pool, calls } = poolOf(from, to);
  pool.hiddenWarmup('to', 'lanyue-stream://b');
  await Promise.resolve();

  const before = calls.length;
  const result = pool.handoff('from', 'to', {
    prepare(el) {
      assert.equal(el.muted, true, '进来的歌在打开前仍是静音');
      assert.equal(from.muted, true, '打开前出去的歌已经静音');
      el.currentTime = 0;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'handoff');
  assert.deepEqual(result.audibleIds, ['to']);
  assert.equal(pool.isAudible('from'), false);
  assert.equal(pool.isAudible('to'), true);
  assert.equal(from.paused, true);
  assert.equal(to.paused, false);
  assert.equal(to.volume, 1);
  assert.equal(from.volume, 0);
  assert.equal(from.muted, true);
  assert.equal(to.muted, false);

  const opened = calls.slice(before).find((c) => c.gain > 0);
  assert.ok(opened, '交接要把进来的一路打开');
  assert.deepEqual(opened.audible, ['to']);
  assert.ok(calls.slice(before, calls.indexOf(opened)).every((c) => c.gain === 0),
    '打开进来的一路之前，其它路必须已经是 0');
});

test('未预热不能交接，正在听的那路保持原样', () => {
  const from = fakeEl('from');
  const to = fakeEl('to');
  from.src = 'lanyue-stream://a';
  from.paused = false;
  from.muted = false;
  from.volume = 0.8;
  const { pool } = poolOf(from, to);
  const result = pool.handoff('from', 'to');
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'hardCut');
  assert.equal(result.reason, 'preload');
  assert.equal(from.paused, false);
  assert.equal(from.muted, false);
  assert.equal(from.volume, 0.8);
  assert.equal(to.playCount, 0);
});

test('交接与交叉并列：关交接时仍是重叠，开交接时不再叠两路', () => {
  const ready = {
    fadeMs: 1000,
    preloadOk: true,
    remainingMs: 8000,
    predictable: true,
    sameStream: false,
    trigger: 'manual',
  };
  const overlap = decideTrackTransition({ ...ready, handoff: false });
  assert.equal(overlap.mode, 'none');
  assert.equal(overlap.reason, 'ok');
  assert.deepEqual(overlap, decideCrossfade({ ...ready, enabled: true }));

  const hand = decideTrackTransition({ ...ready, handoff: true, fadeMs: 0 });
  assert.equal(hand.mode, 'handoff');
  assert.equal(hand.reason, 'ok');
  assert.equal(hand.leadMs, HANDOFF_LEAD_MS);
  assert.notEqual(hand.mode, 'none');
});

test('随机、未预热、剩余时间不够：交接也硬切', () => {
  assert.equal(
    decideTrackTransition({
      handoff: true, fadeMs: 0, preloadOk: true, remainingMs: 8000, predictable: false,
    }).reason,
    'unpredictable',
  );
  assert.equal(
    decideTrackTransition({
      handoff: true, fadeMs: 1000, preloadOk: false, remainingMs: 8000, predictable: true,
    }).reason,
    'preload',
  );
  const short = decideTrackTransition({
    handoff: true, fadeMs: 2000, preloadOk: true, remainingMs: 50, predictable: true, trigger: 'manual',
  });
  assert.equal(short.mode, 'hardCut');
  assert.equal(short.reason, 'remaining');
  const early = decideTrackTransition({
    handoff: true, fadeMs: 0, preloadOk: true, remainingMs: 5000, predictable: true, trigger: 'auto',
  });
  assert.equal(early.mode, 'hardCut');
  assert.equal(early.reason, 'remaining');
});

test('取流器经 wire：本地文件不打网，在线歌走取流再代理', async () => {
  const calls = [];
  const resolve = createPlayableResolver({
    async invoke(method, ...args) {
      calls.push({ method, args });
      if (method === 'getDownloadUrlSmart') {
        return { url: 'https://cdn.example/1.mp3', source: 'netease', id: 1 };
      }
      if (method === 'proxyPlay') return { fileUrl: 'lanyue-stream://1' };
      throw new Error('unexpected ' + method);
    },
  });
  const local = await resolve({ id: 1, source: 'netease', filePath: 'D:/a#b.mp3' }, 'hq');
  assert.equal(local.fileUrl, 'file://D:/a%23b.mp3');
  assert.equal(calls.length, 0);

  const online = await resolve({ id: 1, source: 'netease' }, 'hq');
  assert.equal(online.fileUrl, 'lanyue-stream://1');
  assert.equal(calls[0].method, 'getDownloadUrlSmart');
  assert.equal(calls[1].method, 'proxyPlay');
  assert.equal(calls[1].args[1], 'https://music.163.com/');
  assert.equal(calls[1].args[2].quality, 'hq');
});

test('生产播放器经 wire 接管取流和预热，不绕开它', () => {
  const src = stripComments(read('../src/renderer/app/stores/player.ts'));
  assert.match(src, /from ['"]\.\.\/\.\.\/js\/playback\/wire\.js['"]/);
  assert.match(src, /createPlayableResolver\(/);
  assert.match(src, /createAudibleSlots\(/);
  assert.match(src, /hiddenWarmup\(/);
  assert.match(src, /handoff\(/);
  assert.doesNotMatch(src, /getDownloadUrlSmart/);
  assert.doesNotMatch(src, /proxyPlay/);
  assert.doesNotMatch(src, /playback\/engine/);
  assert.doesNotMatch(src, /crossfadeTo\(/);
  assert.match(src, /decideCrossfade\(/, '重叠交叉仍走原来的决策');
  const writes = src.match(/(?<!player)\.volume\s*=/g) || [];
  assert.equal(writes.length, 1, '音量写手仍然只有一处');
});

test('设置页保留无缝交叉档位，单源交接是旁边的另一项', () => {
  const view = read('../src/renderer/app/views/SettingsView.vue');
  assert.match(view, /无缝交叉/);
  assert.match(view, /CROSSFADE_STEPS/);
  assert.match(view, /changeCrossfade/);
  assert.match(view, /单源交接/);
  assert.match(view, /changeHandoff/);
  assert.equal(HANDOFF_PREF_KEY, 'singleSourceHandoff');
  const prefs = read('../src/main/ipc/prefs.js');
  assert.match(prefs, /'singleSourceHandoff'/);
  assert.match(prefs, /'crossfadeMs'/);
});
