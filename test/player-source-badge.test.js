/**
 * 播放条源徽章：当前在播的源、一键换源参数、失败原因人话。
 *
 * 不新写源解析。徽章只读取流结果上的 source；换源参数交给已有的
 * resolveTrack（avoidSource + 健康度重排）；失败文案走 sourceError。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  playingSourceId,
  humanPlayFailure,
  switchSourceOptions,
  awaitWithin,
  SWITCH_TIMEOUT_ERROR,
} from '../src/renderer/js/playerSourceBadge.js';
import { sourceErrorText } from '../src/renderer/js/sourceError.js';
import { createPlayableResolver } from '../src/renderer/js/playback/wire.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');
const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));

test('徽章显示这次实际在播的源，而不是曲目条目上的原源', () => {
  const song = { id: '1', source: 'netease', title: '晴天', artist: '周杰伦' };
  assert.equal(playingSourceId(song, { source: 'migu', url: 'https://cdn/a' }), 'migu');
  assert.equal(playingSourceId(song, { source: 'Kuwo' }), 'kuwo');
  assert.equal(playingSourceId(song, { source: 'qq', fromAltMemory: true }), 'qq');
  assert.equal(playingSourceId({ source: 'audiomack', id: 'am' }, null), 'audiomack');
  assert.equal(playingSourceId(song, null), 'netease');
  assert.equal(playingSourceId(null, null), '');
});

test('本地文件和本地回退的徽章是 local，在线换源结果优先于 filePath', () => {
  const local = { id: '1', source: 'netease', filePath: 'D:/a.mp3', title: '晴天' };
  assert.equal(playingSourceId(local, { fileUrl: 'file:///D:/a.mp3', source: 'local' }), 'local');
  assert.equal(playingSourceId(local, { degradedLocal: true, source: 'local', fileUrl: 'file:///x' }), 'local');
  assert.equal(
    playingSourceId(local, { source: 'soda', fileUrl: 'lanyue-stream://1' }),
    'soda',
    '手动换走本地文件后，徽章应跟着新的在线源',
  );
});

test('换源或取流失败时给人话，不把内部错误码原样丢上播放条', () => {
  assert.equal(
    humanPlayFailure({ code: 'VIP_REQUIRED', error: 'VIP_REQUIRED' }, 'netease'),
    zh['toast.vipRequired'],
  );
  assert.equal(
    humanPlayFailure({ code: 'VIP_REQUIRED', error: '没有音源' }, 'soda'),
    zh['toast.srcVipSoda'],
  );
  assert.equal(
    humanPlayFailure({ code: 'COPYRIGHT_RESTRICTED' }, 'qq'),
    zh['toast.srcCopyright'],
  );
  assert.equal(
    humanPlayFailure({ code: 'NO_AUDIO_STREAM' }, 'kugou'),
    zh['toast.srcNoStream'],
  );
  assert.equal(
    humanPlayFailure({ code: 'CDN_EMPTY' }, 'kuwo'),
    zh['toast.srcCdnEmpty'],
  );
  assert.equal(humanPlayFailure({ error: '无版权' }, 'bilibili'), '无版权');
  assert.equal(
    humanPlayFailure({ error: '没有其他可用音源', code: 'INTERNAL_ERROR' }, 'netease'),
    '没有其他可用音源',
  );
  assert.equal(humanPlayFailure({ error: 'ECONNRESET' }, 'fivesing'), zh['toast.noSource']);
  assert.equal(humanPlayFailure(null, 'migu'), zh['toast.noSource']);
  const vip = humanPlayFailure({ code: 'VIP_REQUIRED' }, 'audiomack');
  assert.equal(vip, zh['toast.vipRequired']);
  assert.doesNotMatch(vip, /^[A-Z0-9_]+$/);
});

test('失败人话与 sourceError 的句子一致', () => {
  const t = (key) => zh[key] || key;
  const cases = [
    ['VIP_REQUIRED', 'netease'],
    ['VIP_REQUIRED', 'soda'],
    ['NO_AUDIO_STREAM', 'kugou'],
    ['NO_AUDIO_STREAM', 'soda'],
    ['CDN_EMPTY', 'kuwo'],
    ['UNAVAILABLE', 'migu'],
    ['COPYRIGHT_RESTRICTED', 'qq'],
    ['LOGIN_REQUIRED', 'bilibili'],
    ['COOKIE_INVALID', 'fivesing'],
    ['AUTH_EXPIRED', 'audiomack'],
  ];
  for (const [code, source] of cases) {
    assert.equal(
      humanPlayFailure({ code, error: code }, source),
      sourceErrorText(t, { code }, source),
      `${source} ${code}`,
    );
  }
});

test('换源超过期限就交回人话，不等那次卡住的取流', async () => {
  assert.equal(SWITCH_TIMEOUT_ERROR, zh['toast.noSource']);
  const hung = new Promise(() => {});
  const started = Date.now();
  const late = awaitWithin(hung, 30, { error: SWITCH_TIMEOUT_ERROR });
  const result = await late;
  assert.equal(result.error, zh['toast.noSource']);
  assert.ok(Date.now() - started < 500);
  const fast = await awaitWithin(Promise.resolve({ fileUrl: 'lanyue-stream://1', source: 'kuwo' }), 200, {
    error: SWITCH_TIMEOUT_ERROR,
  });
  assert.equal(fast.source, 'kuwo');
  assert.equal(
    humanPlayFailure({ error: SWITCH_TIMEOUT_ERROR, code: 'INTERNAL_ERROR' }, 'netease'),
    zh['toast.noSource'],
  );
});

test('一键换源只生成现有取流选项，不自己挑平台', () => {
  assert.deepEqual(switchSourceOptions('NetEase'), {
    allowToggleSource: true,
    avoidSource: 'netease',
  });
  assert.deepEqual(switchSourceOptions('migu'), {
    allowToggleSource: true,
    avoidSource: 'migu',
  });
  assert.equal(switchSourceOptions(''), null);
  assert.equal(switchSourceOptions('not a source'), null);
  assert.equal(switchSourceOptions(null), null);
});

test('取流器带回实际源，并把错误码收成人话；换源时把 avoidSource 交给智能取流', async () => {
  const calls = [];
  const resolve = createPlayableResolver({
    async invoke(method, ...args) {
      calls.push({ method, args });
      if (method === 'getDownloadUrlSmart') {
        const song = args[0];
        if (song && song.id === 'bad') return { code: 'UNAVAILABLE', error: 'UNAVAILABLE' };
        if (args[2] && args[2].avoidSource === 'netease') {
          return {
            url: 'https://cdn.example/kuwo.mp3',
            source: 'kuwo',
            id: 'k1',
            matchedSong: { source: 'kuwo', id: 'k1', title: '晴天' },
            matchedFrom: 'netease',
          };
        }
        return { url: 'https://cdn.example/1.mp3', source: song.source, id: song.id };
      }
      if (method === 'proxyPlay') return { fileUrl: 'lanyue-stream://1' };
      throw new Error('unexpected ' + method);
    },
  });

  const local = await resolve({ id: '1', source: 'netease', filePath: 'D:/a.mp3' }, 'hq');
  assert.equal(local.fileUrl, 'file://D:/a.mp3');
  assert.equal(local.source, 'local');
  assert.equal(calls.length, 0);

  const online = await resolve({ id: '1', source: 'migu', title: '晴天' }, 'standard');
  assert.equal(online.fileUrl, 'lanyue-stream://1');
  assert.equal(online.source, 'migu');

  const failed = await resolve({ id: 'bad', source: 'qq', title: '晴天' }, 'standard');
  assert.equal(failed.error, zh['toast.srcUnavailable']);
  assert.doesNotMatch(String(failed.error), /UNAVAILABLE/);

  calls.length = 0;
  const switched = await resolve(
    { id: '1', source: 'netease', title: '晴天', filePath: 'D:/a.mp3' },
    'standard',
    { allowToggleSource: true, avoidSource: 'netease' },
  );
  assert.equal(calls[0].method, 'getDownloadUrlSmart');
  assert.equal(calls[0].args[2].avoidSource, 'netease');
  assert.equal(switched.source, 'kuwo');
  assert.equal(switched.matchedSong.source, 'kuwo');
});

test('播放条用现有徽章位显示在播源，并有一键换源', () => {
  const bar = read('src/renderer/app/components/player/PlayerBar.vue');
  assert.match(bar, /switchPlaySource/);
  assert.match(bar, /player\.playSource/);
  assert.match(bar, /platformName\(/);
  assert.match(bar, /class="ly-tag src-badge"/);
  assert.match(bar, /type="button"/);
  assert.match(bar, /:aria-label="sourceTitle"/);
  assert.match(bar, /@click="onSwitchSource"/);
  const format = read('src/renderer/app/core/format.ts');
  for (const pair of [
    ['netease', '网易云'],
    ['qq', 'QQ 音乐'],
    ['bilibili', 'B 站'],
    ['kugou', '酷狗'],
    ['kuwo', '酷我'],
    ['migu', '咪咕'],
    ['soda', '汽水'],
    ['fivesing', '5sing'],
    ['audiomack', 'Audiomack'],
  ]) {
    assert.match(format, new RegExp(`${pair[0]}:\\s*'${pair[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
});

test('播放中换源走智能取流，失败时播放条留下人话且不把内部码当文案', () => {
  const runner = path.join(here, 'player-source-badge.runner.js');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', runner], {
    encoding: 'utf8',
    cwd: path.join(here, '..'),
  });
  assert.equal(r.status, 0, `${r.stdout || ''}\n${r.stderr || ''}`);
  assert.match(r.stdout, /player source badge runner ok/);
});
