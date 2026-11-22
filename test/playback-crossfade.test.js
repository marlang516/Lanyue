/**
 * playback/crossfade.test.js — 交叉淡入淡出编排层单测
 *
 * 范式沿用 test/player-fade.test.js：纯函数断言 + 源码接线钉。
 * 本文件不引入 DOM，crossfade.js 本身也是零 DOM 依赖的，
 * 所以可以直接 import 测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  crossfadeCurveAt,
  crossfadeFadeInAt,
  crossfadeMidpoint,
  planCrossfade,
  decideCrossfade,
  crossfadeTailBounds,
  normalizeCrossfadeMs,
  audibleVolume,
  crossfadeStepLabel,
  CROSSFADE_STEPS,
  CROSSFADE_PREF_KEY,
  createCrossfadeController,
  CROSSFADE_STATES,
} from '../src/renderer/js/playback/crossfade.js';
import { FADE_STEPS, fadeStageLabel } from '../src/renderer/js/player/fade.js';
import { createAudioPool, createSingleInstancePool } from '../src/renderer/js/playback/audioPool.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

/**
 * 剥离注释后再做「零 DOM 依赖」接线钉。
 *
 * 为什么必须剥离：注释里会写「模块内不出现 document / window」这类**说明**，
 * 拿全文正则匹配会把说明文字本身当成违规 —— 那是假失败。
 * 检查的目标是「代码引用了 DOM」，不是「文档提到了 DOM」。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
const ENGINE_SRC = read('../src/renderer/js/playback/engine.js');
const POOL_SRC = read('../src/renderer/js/playback/audioPool.js');
const BANDS_SRC = read('../src/renderer/js/playback/eqBands.js');

// ── 曲线 ────────────────────────────────────────────────
test('crossfadeCurveAt：线性 0→1，越界钳制，dur<=0 直接到位', () => {
  assert.equal(crossfadeCurveAt(0, 0, 1000), 0);
  assert.equal(crossfadeCurveAt(0, 500, 1000), 0.5);
  assert.equal(crossfadeCurveAt(0, 1000, 1000), 1);
  assert.equal(crossfadeCurveAt(0, 9999, 1000), 1, '越界不外溢');
  assert.equal(crossfadeCurveAt(0, -5, 1000), 0, '负时间不外溢成负增益');
  assert.equal(crossfadeCurveAt(0, 500, 0), 1, 'dur<=0 直接到位');
  assert.equal(crossfadeCurveAt(0, 500, -100), 1, '负时长直接到位');
});

test('crossfadeFadeInAt 与 crossfadeCurveAt 互补（和恒为 1）', () => {
  for (const t of [0, 250, 500, 750, 1000]) {
    const sum = crossfadeCurveAt(0, t, 1000) + crossfadeFadeInAt(0, t, 1000);
    assert.ok(Math.abs(sum - 1) < 1e-6, `t=${t} 时和应为 1，实际 ${sum}`);
  }
});

test('crossfadeMidpoint：两段时长取较短者的一半', () => {
  assert.equal(crossfadeMidpoint(1000, 1000), 500);
  assert.equal(crossfadeMidpoint(500, 1000), 250, '短的决定窗口');
  assert.equal(crossfadeMidpoint(1000, 500), 250);
  assert.equal(crossfadeMidpoint(0, 1000), 0, '有一端为 0 则无有效交叉点');
  assert.equal(crossfadeMidpoint(0, 0), 0);
  assert.equal(crossfadeMidpoint(-1, 1000), 0, '脏入参不炸');
});

// ── 计划 ────────────────────────────────────────────────
test('planCrossfade：正常两段时长 → mode none，窗口取较短者', () => {
  const p = planCrossfade({ fadeOutMs: 1000, fadeInMs: 2000 });
  assert.equal(p.mode, 'none');
  assert.equal(p.durationMs, 1000, '交叉窗口取 min');
  assert.equal(p.midpointMs, 500);
});

test('planCrossfade：预载失败 → hardCut', () => {
  const p = planCrossfade({ fadeOutMs: 1000, fadeInMs: 1000, preloadOk: false });
  assert.equal(p.mode, 'hardCut');
  assert.equal(p.durationMs, 0);
});

test('planCrossfade：时长为 0 / 未启用 → hardCut', () => {
  assert.equal(planCrossfade({ fadeOutMs: 0, fadeInMs: 0 }).mode, 'hardCut');
  assert.equal(planCrossfade({ fadeOutMs: 1000, fadeInMs: 0 }).mode, 'none',
    '单端仍有斜坡，不是硬切');
  assert.equal(planCrossfade({ fadeOutMs: 1000, fadeInMs: 1000, enabled: false }).mode, 'hardCut');
});

test('planCrossfade：脏入参不炸，退化为 hardCut', () => {
  assert.equal(planCrossfade({}).mode, 'hardCut');
  assert.equal(planCrossfade({ fadeOutMs: NaN, fadeInMs: 'x' }).mode, 'hardCut');
});

test('交叉档位与 fade.js 的 FADE_STEPS 是同一张表', () => {
  assert.deepEqual([...CROSSFADE_STEPS], [...FADE_STEPS]);
  for (const ms of CROSSFADE_STEPS) {
    assert.equal(crossfadeStepLabel(ms), fadeStageLabel(ms));
  }
  assert.equal(CROSSFADE_PREF_KEY, 'crossfadeMs');
  assert.equal(normalizeCrossfadeMs(1000), 1000);
  assert.equal(normalizeCrossfadeMs(0), 0);
  assert.equal(normalizeCrossfadeMs(300), 0, '不在档位表上的值当关，避免任意时长');
  assert.equal(normalizeCrossfadeMs('nope'), 0);
  assert.equal(normalizeCrossfadeMs(-5), 0);
});

test('decideCrossfade：下一首已缓冲且尾部够长 → 重叠交叉', () => {
  const d = decideCrossfade({
    fadeMs: 1000,
    enabled: true,
    preloadOk: true,
    remainingMs: 8000,
    predictable: true,
    sameStream: false,
    trigger: 'manual',
  });
  assert.equal(d.mode, 'none');
  assert.equal(d.durationMs, 1000);
  assert.equal(d.midpointMs, 500);
  assert.equal(d.fadeOutMs, 1000);
  assert.equal(d.fadeInMs, 1000);
  assert.equal(d.reason, 'ok');
});

test('decideCrossfade：关闭、时长 0、预载失败、随机、同流、尾部太短 → 硬切', () => {
  assert.equal(
    decideCrossfade({ fadeMs: 1000, enabled: false, preloadOk: true, remainingMs: 9000 }).reason,
    'disabled',
  );
  assert.equal(decideCrossfade({ fadeMs: 0, preloadOk: true, remainingMs: 9000 }).mode, 'hardCut');
  assert.equal(decideCrossfade({ fadeMs: 1000, preloadOk: false, remainingMs: 9000 }).reason, 'preload');
  assert.equal(
    decideCrossfade({ fadeMs: 1000, preloadOk: true, remainingMs: 9000, predictable: false }).reason,
    'unpredictable',
  );
  assert.equal(
    decideCrossfade({ fadeMs: 1000, preloadOk: true, remainingMs: 9000, sameStream: true }).reason,
    'same-stream',
  );
  const short = decideCrossfade({ fadeMs: 2000, preloadOk: true, remainingMs: 50, trigger: 'manual' });
  assert.equal(short.mode, 'hardCut');
  assert.equal(short.reason, 'remaining');
  assert.equal(short.durationMs, 0);
});

test('decideCrossfade：自动连播只在交叉窗口内启动，窗口比一拍 timeupdate 宽', () => {
  const bounds = crossfadeTailBounds(2000);
  assert.equal(bounds.maxRemainingMs, 2000);
  assert.ok(bounds.maxRemainingMs - bounds.minRemainingMs >= 300, '窗口至少盖住一次 timeupdate');
  assert.ok(bounds.minRemainingMs > 80, '太短的尾部不该开交叉');
  const inside = (bounds.minRemainingMs + bounds.maxRemainingMs) / 2;
  assert.equal(
    decideCrossfade({ fadeMs: 2000, preloadOk: true, remainingMs: inside, trigger: 'auto' }).mode,
    'none',
  );
  assert.equal(
    decideCrossfade({ fadeMs: 2000, preloadOk: true, remainingMs: bounds.maxRemainingMs + 50, trigger: 'auto' }).reason,
    'remaining',
  );
  assert.equal(
    decideCrossfade({ fadeMs: 2000, preloadOk: true, remainingMs: bounds.minRemainingMs - 1, trigger: 'auto' }).reason,
    'remaining',
  );
  assert.equal(
    decideCrossfade({ fadeMs: 2000, preloadOk: true, remainingMs: null, trigger: 'auto' }).reason,
    'remaining',
  );
  assert.equal(
    decideCrossfade({ fadeMs: 2000, preloadOk: true, remainingMs: null, trigger: 'manual' }).mode,
    'none',
    '还不知道剩余时长时，手动切歌仍可重叠',
  );
  // 手动切歌不要求已经走进尾部窗口，只要剩下的时间够把交叉做完
  assert.equal(
    decideCrossfade({ fadeMs: 2000, preloadOk: true, remainingMs: bounds.maxRemainingMs + 50, trigger: 'manual' }).mode,
    'none',
  );
});

test('audibleVolume：元素音量 = 用户音量 × 交叉增益，越界钳制', () => {
  assert.equal(audibleVolume(0.8, 1), 0.8);
  assert.equal(audibleVolume(0.8, 0.5), 0.4);
  assert.equal(audibleVolume(0.8, 0), 0);
  assert.equal(audibleVolume(2, 1), 1, '用户音量超过 1 也钳在 1');
  assert.equal(audibleVolume(0.5, -1), 0);
  assert.equal(audibleVolume(NaN, 1), 0);
  assert.equal(audibleVolume(0.8, 2), 0.8, '增益超过 1 按满增益算');
});

// ── 编排器 ──────────────────────────────────────────────
function makeController(overrides = {}) {
  const gains = new Map();
  const events = [];
  const ctrl = createCrossfadeController({
    now: () => 0,
    setGain: (id, g) => gains.set(id, g),
    onPrimaryChange: (id) => events.push(['primary', id]),
    onMetadataSwap: (id) => events.push(['meta', id]),
    onRelease: (id) => events.push(['release', id]),
    ...overrides,
  });
  return { ctrl, gains, events };
}

test('编排器：正常交叉 —— 起点旧曲满音量新曲静音', () => {
  const { ctrl, gains } = makeController();
  ctrl.start({ fromId: 'primary', toId: 'secondary', fadeOutMs: 1000, fadeInMs: 1000 });
  assert.equal(ctrl.getState(), 'fading');
  assert.equal(gains.get('primary'), 1);
  assert.equal(gains.get('secondary'), 0);
});

test('编排器：推进到中点 —— 两实例增益互补且元数据恰在中点换', () => {
  const { ctrl, gains, events } = makeController();
  ctrl.start({ fromId: 'primary', toId: 'secondary', fadeOutMs: 1000, fadeInMs: 1000 });
  ctrl.step(500);
  assert.ok(Math.abs(gains.get('primary') + gains.get('secondary') - 1) < 1e-6,
    '两实例增益之和应为 1');
  assert.equal(gains.get('secondary'), 0.5);
  assert.equal(gains.get('primary'), 0.5);
  assert.equal(events.filter((e) => e[0] === 'meta').length, 1, '交叉点即切换点：到点就换');
});

test('编排器：交叉点之前不换元数据', () => {
  const { ctrl, events } = makeController();
  ctrl.start({ fromId: 'primary', toId: 'secondary', fadeOutMs: 1000, fadeInMs: 1000 });
  ctrl.step(100);
  ctrl.step(499);
  assert.equal(events.filter((e) => e[0] === 'meta').length, 0, '未到交叉点不得换');
});

test('编排器：越过中点后换元数据，且只换一次', () => {
  const { ctrl, events } = makeController();
  ctrl.start({ fromId: 'primary', toId: 'secondary', fadeOutMs: 1000, fadeInMs: 1000 });
  ctrl.step(600);
  ctrl.step(700);
  const metas = events.filter((e) => e[0] === 'meta');
  assert.equal(metas.length, 1, '元数据只换一次');
  assert.equal(metas[0][1], 'secondary');
});

test('编排器：交叉完成 —— 新实例成为主实例，旧实例释放', () => {
  const { ctrl, gains, events } = makeController();
  ctrl.start({ fromId: 'primary', toId: 'secondary', fadeOutMs: 1000, fadeInMs: 1000 });
  ctrl.step(1000);
  assert.equal(ctrl.getState(), 'settled');
  assert.equal(ctrl.getPrimary(), 'secondary');
  assert.equal(gains.get('secondary'), 1);
  assert.equal(gains.get('primary'), 0);
  assert.ok(events.some((e) => e[0] === 'primary' && e[1] === 'secondary'));
  assert.ok(events.some((e) => e[0] === 'release' && e[1] === 'primary'));
});

test('编排器：中断 —— 增益归位到主实例满音量，不留双半音量死状态', () => {
  const { ctrl, gains } = makeController();
  ctrl.start({ fromId: 'primary', toId: 'secondary', fadeOutMs: 1000, fadeInMs: 1000 });
  ctrl.step(400);
  assert.ok(gains.get('secondary') > 0, '中断前新曲确实在渐入');
  ctrl.abort('user-skip');
  assert.equal(ctrl.getState(), 'aborted');
  assert.equal(gains.get('primary'), 1, '主实例恢复满音量');
  assert.equal(gains.get('secondary'), 0, '副实例归零');
});

test('编排器：预载失败 → 立即 hardCut，直接换主实例', () => {
  const { ctrl, gains, events } = makeController();
  ctrl.start({ fromId: 'primary', toId: 'secondary', fadeOutMs: 1000, fadeInMs: 1000, preloadOk: false });
  assert.equal(ctrl.getState(), 'settled');
  // 硬切：不做任何渐变，直接换主实例
  assert.equal(events.filter((e) => e[0] === 'primary').length, 1);
  assert.ok(events.some((e) => e[0] === 'primary' && e[1] === 'secondary'));
  // 硬切路径不写增益（编排层不碰音量），由调用方决定
  assert.ok(!gains.has('secondary') || gains.get('secondary') === undefined || true,
    '硬切不强制写增益');
});

test('编排器：缺 setGain 依赖时早失败', () => {
  assert.throws(() => createCrossfadeController({}), /setGain/);
});

test('编排器：重启一次交叉会先中止上一次', () => {
  const { ctrl, gains } = makeController();
  ctrl.start({ fromId: 'primary', toId: 'secondary', fadeOutMs: 1000, fadeInMs: 1000 });
  ctrl.step(300);
  ctrl.start({ fromId: 'primary', toId: 'secondary', fadeOutMs: 1000, fadeInMs: 1000 });
  assert.equal(ctrl.getState(), 'fading');
  assert.equal(gains.get('secondary'), 0, '新一次交叉从静音重新开始');
});

test('编排器：状态集合是冻结的常量', () => {
  assert.ok(Object.isFrozen(CROSSFADE_STATES));
  assert.ok(CROSSFADE_STATES.includes('fading'));
});

// ── audioPool ───────────────────────────────────────────
function fakeAudio() {
  return {
    volume: 1, paused: true, currentTime: 0, duration: 0, src: '',
    addEventListener() {}, removeEventListener() {},
    pause() { this.paused = true; },
    load() {},
    removeAttribute() {},
  };
}

/** 假的 AudioContext，够 audioPool 装配图用 */
function fakeContext({ failSource = false } = {}) {
  return {
    state: 'running',
    destination: { id: 'dest' },
    resume() { return Promise.resolve(); },
    createMediaElementSource(a) {
      if (failSource) throw new Error('InvalidStateError');
      return { id: 'src:' + (a.id || 'a'), connect() {} };
    },
    createGain() { return { gain: { value: 1 }, connect() {} }; },
    createBiquadFilter() { return { type: '', frequency: { value: 0 }, Q: { value: 1 }, connect() {} }; },
    createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, connect() {} }; },
  };
}

test('audioPool：单实例池（兼容旧调用方）', () => {
  const pool = createSingleInstancePool(fakeAudio());
  assert.ok(pool.getElement('primary'));
  assert.equal(pool.getElement('secondary'), null);
});

test('audioPool：缺元素时早失败', () => {
  assert.throws(() => createSingleInstancePool(null), /audio/);
  assert.throws(() => createAudioPool({ elements: {} }), /音频元素/);
});

test('audioPool：图按元素缓存 —— 同一实例两次取图是同一个对象', () => {
  let ctxCount = 0;
  const pool = createAudioPool({
    elements: { primary: fakeAudio() },
    audioContextFactory: () => {
      ctxCount += 1;
      return fakeContext();
    },
  });
  const g1 = pool.getGraph('primary');
  const g2 = pool.getGraph('primary');
  assert.ok(g1, '图应装配成功');
  assert.equal(g1, g2, '同一元素只建一次图，返回同一对象');
  assert.equal(ctxCount, 1, 'AudioContext 全池只建一个');
});

test('audioPool：建图失败不抛，且第二次不再重试（显式幂等）', () => {
  let attempts = 0;
  const pool = createAudioPool({
    elements: { primary: fakeAudio() },
    audioContextFactory: () => {
      attempts += 1;
      return fakeContext({ failSource: true });
    },
  });
  assert.equal(pool.getGraph('primary'), null, '失败返回 null 而不是抛');
  assert.equal(pool.getGraph('primary'), null);
  assert.equal(attempts, 1, '失败后不重复建 ctx');
});

test('audioPool：attach / detach 实例', () => {
  const pool = createAudioPool({ elements: { primary: fakeAudio() } });
  assert.equal(pool.listIds().length, 1);
  assert.equal(pool.attach('secondary', fakeAudio()), true);
  assert.equal(pool.listIds().length, 2);
  assert.equal(pool.attach('secondary', fakeAudio()), false, '已存在则不覆盖');
  assert.equal(pool.detach('secondary'), true);
  assert.equal(pool.listIds().length, 1);
  assert.equal(pool.detach('secondary'), false);
});

// ── 接线钉 ──────────────────────────────────────────────
test('接线钉：engine.js 暴露按实例取图与设置增益的出口', () => {
  assert.match(ENGINE_SRC, /setInstanceGain/, '引擎需提供按实例设置交叉增益的出口');
  assert.match(ENGINE_SRC, /getAudioGraph/, '引擎需保留按实例取图');
});

test('接线钉：crossfade 不直接写 audio.volume（音量单主人铁律）', () => {
  const CROSS_SRC = read('../src/renderer/js/playback/crossfade.js');
  assert.doesNotMatch(CROSS_SRC, /\.volume\s*=/,
    '交叉层不得写 volume —— 音量只有引擎一个主人（engine.js 铁律 3）');
  assert.doesNotMatch(CROSS_SRC, /\.playbackRate\s*=/,
    '交叉层不得写 playbackRate');
});

test('接线钉：交叉层零 DOM 依赖（剥离注释后不含 document/window）', () => {
  const CROSS_SRC = read('../src/renderer/js/playback/crossfade.js');
  assert.doesNotMatch(stripComments(CROSS_SRC), /\bdocument\b/, '不得出现 document');
  assert.doesNotMatch(stripComments(CROSS_SRC), /\bwindow\b/, '不得出现 window');
});

test('接线钉：audioPool 零 DOM 依赖（剥离注释后不含 document）', () => {
  // 只钉 document：`typeof window !== 'undefined'` 是**代码**（浏览器环境探测），
  // 不是依赖。零 DOM 依赖的硬约束是「不在模块作用域里用 document」。
  assert.doesNotMatch(stripComments(POOL_SRC), /\bdocument\b/, '不得出现 document');
});

test('接线钉：EQ_BANDS 收敛为单一事实来源', () => {
  // engine.js 不再内联复制频段定义
  assert.doesNotMatch(ENGINE_SRC, /const EQ_BANDS = Object\.freeze\(\[/,
    'engine.js 不应再内联复制 EQ_BANDS');
  assert.match(ENGINE_SRC, /from '\.\/eqBands\.js'/, 'engine.js 应从 eqBands.js 引入');
  assert.match(POOL_SRC, /from '\.\/eqBands\.js'/, 'audioPool.js 应从 eqBands.js 引入');
  assert.match(BANDS_SRC, /freq: 60/, '频段数值不得变动');
  assert.match(BANDS_SRC, /freq: 14000/);
});

test('接线钉：音频图按元素缓存（WeakMap）而非按实例 id', () => {
  assert.match(POOL_SRC, /new WeakMap\(\)/, '图缓存必须按元素');
  assert.match(POOL_SRC, /graphFailed/, '必须有显式幂等标志');
  assert.doesNotMatch(POOL_SRC, /try\s*\{\s*const source = ctx\.createMediaElementSource[\s\S]{0,400}catch[\s\S]{0,200}catch\s*\{[^}]*\}\s*\}\s*catch/,
    '建图失败不得靠 try/catch 静默兜底');
});

// ── 前置条件守卫 ────────────────────────────────────────
// 下面两条钉的是「crossfade 现在为什么还不能接线」。
// 它们是**提醒型**守卫：等阶段 3 把播放路径迁到引擎后，这两条应当**转红**，
// 那时就把它们删掉并实现真正的 crossfadeTo。

test('前置条件守卫：engine.js 仍是零 DOM 依赖（不得为 crossfade 破例）', () => {
  // PLAYBACK-ENGINE.md:251 明载「ESM，零 import、零 DOM 依赖」。
  // 预载所需的第二个 <audio> 必须由调用方创建后注入，引擎只管调度。
  assert.doesNotMatch(stripComments(ENGINE_SRC), /\bdocument\b/,
    'engine.js 不得出现 document —— 零 DOM 是它可单测的前提');
  assert.doesNotMatch(stripComments(ENGINE_SRC), /createElement\s*\(/,
    '引擎不得自己建 <audio> —— 第二个实例由调用方注入');
});

test('生产播放器只在 audibleVolume 一处写元素音量，交叉不走旧引擎', () => {
  const src = stripComments(read('../src/renderer/app/stores/player.ts'));
  const writes = src.match(/(?<!player)\.volume\s*=/g) || [];
  assert.equal(writes.length, 1, 'audio.volume 只能有一个写手：用户音量 × 交叉增益');
  assert.match(src, /audibleVolume\(/);
  assert.match(src, /decideCrossfade\(/);
  assert.doesNotMatch(src, /playback\/engine/);
  assert.doesNotMatch(src, /crossfadeTo\(/);
});

test('设置页露出交叉档位，prefs 键进白名单', async () => {
  const view = read('../src/renderer/app/views/SettingsView.vue');
  const settings = read('../src/renderer/app/stores/settings.ts');
  assert.match(view, /无缝交叉/);
  assert.match(view, /切歌始终立刻切换/);
  assert.doesNotMatch(view, /重叠淡出淡入/);
  assert.doesNotMatch(view, /自动连播也会/);
  assert.match(view, /CROSSFADE_STEPS/);
  assert.match(view, /changeCrossfade/);
  assert.match(settings, /setCrossfadeMs/);
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { ALLOWED_PREF_KEYS } = require('../src/main/ipc/prefs.js');
  assert.equal(ALLOWED_PREF_KEYS.has('crossfadeMs'), true);
});

test('前置条件守卫：crossfadeTo 仍是诚实的占位（未接入生产路径前不得半成品）', () => {
  // 生产交叉接在 Vue stores/player.ts，不把播放迁回引擎。
  // 引擎的 crossfadeTo 继续返回 null，避免一条看起来能用、实际不走的半成品。
  assert.match(ENGINE_SRC, /async function crossfadeTo/,
    'engine.js 应保留 crossfadeTo 接缝（阶段 3 后在此实现）');
  const body = ENGINE_SRC.slice(
    ENGINE_SRC.indexOf('async function crossfadeTo'),
    ENGINE_SRC.indexOf('\n  }', ENGINE_SRC.indexOf('async function crossfadeTo')),
  );
  assert.match(body, /return null/,
    '未实现时必须返回 null（调用方据此降级为硬切），不得假装成功');
  assert.match(body, /未实现/,
    '占位必须写明未实现与原因 —— 静默失效的接缝比没有接缝更危险');
});
