/**
 * 全屏歌词交接：行号、间奏静息、seek / 连唱落点、播放头外推。
 *
 * 判定在 lyricMotion.js（纯函数，注入 now），LyricsPane 只负责把
 * 结果贴到 class / 滚动上。这里同时钉住视图没有把字重动画进布局，
 * 以及交接时长和 --dur-2 还是同一拍。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

// lyrics.ts 的无后缀 import（./bridge）在 node --test 里解析不到，复用播放器时序那条钩子。
register(pathToFileURL(path.join(__dirname, 'esm-ts-resolve.mjs')).href, {
  parentURL: pathToFileURL(__filename).href,
});

const ROOT = path.join(__dirname, '..');
const PANE = fs.readFileSync(
  path.join(ROOT, 'src/renderer/app/components/player/LyricsPane.vue'), 'utf8',
);
const TOKENS = fs.readFileSync(
  path.join(ROOT, 'src/renderer/app/styles/tokens.css'), 'utf8',
);
const LYRICS_TS = fs.readFileSync(
  path.join(ROOT, 'src/renderer/app/stores/lyrics.ts'), 'utf8',
);
const PLAYER_TS = fs.readFileSync(
  path.join(ROOT, 'src/renderer/app/stores/player.ts'), 'utf8',
);

async function fresh() {
  return import('../src/renderer/app/core/lyricMotion.js?tc=' + Math.random());
}

/** 句距 3s，中间夹一段 16s 间奏。 */
function verse() {
  return [0, 3, 6, 9, 12, 28, 31].map((t, i) => ({ t, text: 'l' + i }));
}

test('activeLineIndex：空、未到第一句、贴边、同刻多行取最后一行', async () => {
  const { activeLineIndex } = await fresh();
  const lines = [{ t: 1, text: 'a' }, { t: 2, text: 'b' }, { t: 2, text: 'c' }, { t: 5, text: 'd' }];
  assert.strictEqual(activeLineIndex(null, 3), -1);
  assert.strictEqual(activeLineIndex([], 3), -1);
  assert.strictEqual(activeLineIndex(lines, 0), -1);
  assert.strictEqual(activeLineIndex(lines, 1), 0);
  assert.strictEqual(activeLineIndex(lines, 2), 2, '同一时刻取最后一行，避免高亮停在空行');
  assert.strictEqual(activeLineIndex(lines, 4.999), 2);
  assert.strictEqual(activeLineIndex(lines, 5), 3);
  assert.strictEqual(activeLineIndex(lines, 99), 3);
  assert.strictEqual(activeLineIndex(lines, Number.NaN), -1, 'NaN 比较全假，与搬迁前的二分一致');
});

test('resolveLyricFrame：前奏不高亮，打开中间直接落点，相邻句才交接', async () => {
  const { resolveLyricFrame } = await fresh();
  const items = verse();
  const none = resolveLyricFrame([], 10, null, 0);
  assert.deepStrictEqual(none, { index: -1, role: 'none', motion: 'none', scroll: 'hold' });

  const prelude = resolveLyricFrame([{ t: 12, text: 'a' }], 3, null, 0);
  assert.strictEqual(prelude.role, 'prelude');
  assert.strictEqual(prelude.index, -1);
  assert.strictEqual(prelude.motion, 'none');

  const opened = resolveLyricFrame(items, 7, null, 0);
  assert.strictEqual(opened.index, 2);
  assert.strictEqual(opened.role, 'active');
  assert.strictEqual(opened.motion, 'snap', '第一次观察不从第 0 行播到当前行');
  assert.strictEqual(opened.scroll, 'auto');

  const next = resolveLyricFrame(items, 9, { index: opened.index, at: 0 }, 400);
  assert.strictEqual(next.index, 3);
  assert.strictEqual(next.motion, 'handoff');
  assert.strictEqual(next.scroll, 'smooth');

  const back = resolveLyricFrame(items, 6, { index: 3, at: 0 }, 400);
  assert.strictEqual(back.index, 2);
  assert.strictEqual(back.motion, 'handoff', '回退一句同样交接，而不是硬切');
});

test('resolveLyricFrame：长空档静息，慢歌的正常句距不静息', async () => {
  const { resolveLyricFrame } = await fresh();
  const items = verse();
  const sung = resolveLyricFrame(items, 12.4, { index: 4, at: 0 }, 1000);
  assert.strictEqual(sung.index, 4);
  assert.strictEqual(sung.role, 'active', '刚进入长空档仍保持强调');
  assert.strictEqual(sung.motion, 'none');
  assert.strictEqual(sung.scroll, 'hold', '静息过程不重新滚动');

  const rest = resolveLyricFrame(items, 16, { index: 4, at: 0 }, 5000);
  assert.strictEqual(rest.index, 4);
  assert.strictEqual(rest.role, 'rest');
  assert.strictEqual(rest.motion, 'none');

  const after = resolveLyricFrame(items, 28, { index: 4, at: 0 }, 9000);
  assert.strictEqual(after.index, 5);
  assert.strictEqual(after.role, 'active', '间奏结束下一句重新强调');
  assert.strictEqual(after.motion, 'handoff');

  const ballad = [0, 8, 16, 24, 32].map((t) => ({ t, text: 'b' }));
  const slow = resolveLyricFrame(ballad, 15, { index: 1, at: 0 }, 5000);
  assert.strictEqual(slow.index, 1);
  assert.strictEqual(slow.role, 'active', '整首句距都长时不把演唱当间奏');

  const noDur = [{ t: 0, text: 'only' }];
  const tail = resolveLyricFrame(noDur, 20, { index: 0, at: 0 }, 5000);
  assert.strictEqual(tail.role, 'active', '不知道曲长时末句不提前熄灭');
  const outro = resolveLyricFrame(noDur, 20, { index: 0, at: 0 }, 5000, { duration: 40 });
  assert.strictEqual(outro.role, 'rest', '已知尾奏够长才静息');
});

test('resolveLyricFrame：seek、连唱、减弱动效都直接落点', async () => {
  const { resolveLyricFrame, LYRIC_RAPID_MS } = await fresh();
  const items = verse();
  const jumped = resolveLyricFrame(items, 31, { index: 1, at: 0 }, 5000);
  assert.strictEqual(jumped.index, 6);
  assert.strictEqual(jumped.motion, 'snap');
  assert.strictEqual(jumped.scroll, 'auto');

  const rapid = resolveLyricFrame(items, 6, { index: 1, at: 1000 }, 1000 + LYRIC_RAPID_MS - 1);
  assert.strictEqual(rapid.motion, 'snap', '上一句交接还没完就换行，取消动画以免落后拍点');
  const paced = resolveLyricFrame(items, 6, { index: 1, at: 1000 }, 1000 + LYRIC_RAPID_MS);
  assert.strictEqual(paced.motion, 'handoff');

  const reduced = resolveLyricFrame(items, 6, { index: 1, at: 0 }, 5000, { reducedMotion: true });
  assert.strictEqual(reduced.motion, 'snap');
  assert.strictEqual(reduced.scroll, 'auto');

  const toIntro = resolveLyricFrame(items, -1, { index: 3, at: 0 }, 5000);
  assert.strictEqual(toIntro.role, 'prelude');
  assert.strictEqual(toIntro.motion, 'snap');
  assert.strictEqual(toIntro.scroll, 'auto');
});

test('lineClasses：当前行、相邻行、前奏第一句互斥，交接只打在强调行', async () => {
  const { lineClasses, linePhase } = await fresh();
  const on = { index: 3, role: 'active', motion: 'handoff' };
  assert.deepStrictEqual(lineClasses(3, on), {
    on: true, rest: false, past: false, near: false, handoff: true,
  });
  assert.strictEqual(linePhase(2, on), 'near');
  assert.strictEqual(linePhase(4, on), 'near');
  assert.strictEqual(linePhase(0, on), 'past');
  assert.strictEqual(linePhase(6, on), 'far');
  assert.strictEqual(lineClasses(3, on).on && lineClasses(2, on).on, false);

  const rest = lineClasses(3, { index: 3, role: 'rest', motion: 'none' });
  assert.strictEqual(rest.rest, true);
  assert.strictEqual(rest.on, false);
  assert.strictEqual(rest.handoff, false, '静息不播入场');

  const intro = lineClasses(0, { index: -1, role: 'prelude', motion: 'none' });
  assert.strictEqual(intro.near, true);
  assert.strictEqual(intro.on, false);
  assert.deepStrictEqual(lineClasses(2, { index: -1, role: 'none' }), {
    on: false, rest: false, past: false, near: false, handoff: false,
  });
});

test('projectPlayhead：样本之间外推、封顶、seek 与缓冲都回到真实进度', async () => {
  const {
    projectPlayhead, PLAYHEAD_LEAD_CAP_SEC, PLAYHEAD_STALL_MS, PLAYHEAD_SEEK_SLACK_SEC,
  } = await fresh();

  const paused = projectPlayhead({ progress: 10, at: 0, rate: 1 }, 10.1, 500, 1, false);
  assert.strictEqual(paused.seconds, 10.1);
  assert.strictEqual(paused.seeked, false);

  const anchor = { progress: 10, at: 1000, rate: 1 };
  const mid = projectPlayhead(anchor, 10, 1200, 1, true);
  assert.ok(Math.abs(mid.seconds - 10.2) < 1e-9, '200ms 外推 0.2s');
  assert.strictEqual(mid.seeked, false);
  assert.strictEqual(mid.anchor, anchor, '样本没动时不更换锚点');

  const capped = projectPlayhead(anchor, 10, 1000 + 2000, 1, true);
  assert.ok(capped.seconds <= anchor.progress + PLAYHEAD_LEAD_CAP_SEC + 1e-9);

  const sampled = projectPlayhead(anchor, 10.25, 1250, 1, true);
  assert.strictEqual(sampled.seconds, 10.25, '新样本可信时显示样本，不显示外推');
  assert.notStrictEqual(sampled.anchor, anchor);
  assert.strictEqual(sampled.seeked, false);

  const sought = projectPlayhead(anchor, 40, 1300, 1, true);
  assert.strictEqual(sought.seconds, 40);
  assert.strictEqual(sought.seeked, true);
  assert.ok(40 - (anchor.progress + 0.3) > PLAYHEAD_SEEK_SLACK_SEC);

  const stalled = projectPlayhead(anchor, 10, 1000 + PLAYHEAD_STALL_MS + 5, 1, true);
  assert.strictEqual(stalled.seconds, 10, '缓冲时停在最后一次真实进度');
  assert.strictEqual(stalled.anchor, anchor);

  const rated = projectPlayhead(anchor, 10, 1100, 1.5, true);
  assert.strictEqual(rated.seconds, 10);
  assert.strictEqual(rated.anchor.rate, 1.5);
  assert.strictEqual(rated.seeked, false);

  const bad = projectPlayhead(null, Number.NaN, 0, 0, true);
  assert.strictEqual(bad.seconds, 0);
  assert.strictEqual(bad.anchor.rate, 1);
});

test('几百行歌词重复求帧仍便宜，不靠每帧重排', async () => {
  const { resolveLyricFrame } = await fresh();
  const items = Array.from({ length: 400 }, (_, i) => ({ t: i * 2.4, text: 'x' + i }));
  const t0 = Date.now();
  let prev = null;
  for (let i = 0; i < 2000; i++) {
    const frame = resolveLyricFrame(items, (i % 400) * 2.4, prev, i * 400, {});
    prev = { index: frame.index, at: i * 400 };
  }
  assert.ok(Date.now() - t0 < 500, `2000 帧耗时 ${Date.now() - t0}ms`);
});

test('接线：全屏歌词走这份判定，桌面同步不另写二分，逐字只在活动句上弹', () => {
  assert.match(LYRICS_TS, /export \{ activeLineIndex \} from '\.\.\/core\/lyricMotion\.js'/);
  assert.match(LYRICS_TS, /linesFromLyricResult\(raw\)/);
  assert.match(LYRICS_TS, /words: \[\]/, '桌面歌词继续交空的 words，不把逐字时间送过去');
  assert.match(PLAYER_TS, /activeLineIndex/);
  assert.doesNotMatch(PLAYER_TS, /while \(lo <= hi\)/, '播放器里不能再复制一份行号二分');
  assert.match(PANE, /resolveLyricFrame/);
  assert.match(PANE, /projectPlayhead/);
  assert.match(PANE, /resolveWordStates/);
  assert.match(PANE, /displayWords/);
  assert.match(PANE, /projected\.seeked/);
  assert.match(PANE, /frame\.role === 'active'/);
  assert.match(PANE, /visualSnap \|\| reduced/);
  assert.match(PANE, /visibilityState/);
  assert.match(PANE, /prefers-reduced-motion: reduce/);
  assert.match(PANE, /aria-current/);
  assert.match(PANE, /暂无歌词/);
  assert.match(PANE, /seekWord/);
  assert.doesNotMatch(PANE, /splitToWords/);

  const style = PANE.slice(PANE.lastIndexOf('<style'));
  const activeBlock = style.match(/\.word\.active\s*\{[^}]*\}/);
  assert.ok(activeBlock, '缺少 .word.active');
  assert.doesNotMatch(activeBlock[0], /font-weight/, '逐字弹入不改字重');
  assert.match(style, /@keyframes word-bounce/);
  assert.match(style, /\.word\.unreached\s*\{[^}]*opacity:\s*0/);
  assert.match(style, /\.word\.sung\s*\{[^}]*opacity:\s*\.72/);
  assert.match(style, /\.stage\.snap \.word\.active[\s\S]*?animation:\s*none/);
  assert.match(style, /var\(\s*--dur-2\s*\)/);
  assert.match(style, /var\(\s*--ease-emph\s*\)/);
  assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}/, '歌词样式不写死色值，随浅色/深色令牌走');
  assert.match(TOKENS, /--dur-2:\s*\.32s/);
  assert.match(
    fs.readFileSync(path.join(ROOT, 'src/renderer/app/core/lyricMotion.js'), 'utf8'),
    /LYRIC_HANDOFF_MS = 320/,
  );
});

test('resolveWordStates：未到、提前进入、唱完，时长缺失时用下一词', async () => {
  const { resolveWordStates, WORD_LEAD_SEC, WORD_UNTIMED_SEC } = await fresh();
  const words = [
    { t: 1, dur: 0.5, text: '你' },
    { t: 1.5, dur: 0.5, text: '好' },
  ];
  assert.deepStrictEqual(resolveWordStates([], 1), { index: -1, states: [] });
  assert.deepStrictEqual(resolveWordStates(words, 1 - WORD_LEAD_SEC - 0.01).states, ['unreached', 'unreached']);

  const lead = resolveWordStates(words, 1 - WORD_LEAD_SEC);
  assert.strictEqual(lead.states[0], 'active', '到点前 WORD_LEAD_SEC 进入在唱');
  assert.strictEqual(lead.states[1], 'unreached');
  assert.strictEqual(lead.index, 0);

  const mid = resolveWordStates(words, 1.2);
  assert.deepStrictEqual(mid.states, ['active', 'unreached']);

  const overlap = resolveWordStates(words, 1.5 - WORD_LEAD_SEC);
  assert.strictEqual(overlap.states[0], 'active');
  assert.strictEqual(overlap.states[1], 'active', '下一词提前进入时上一词还没唱完');
  assert.strictEqual(overlap.index, 1, '在唱的下标取最后一个');

  const done = resolveWordStates(words, 2.1);
  assert.deepStrictEqual(done.states, ['sung', 'sung']);
  assert.strictEqual(done.index, -1);

  const open = [
    { t: 1, dur: 0, text: '你' },
    { t: 1.8, dur: 0.2, text: '好' },
  ];
  assert.strictEqual(resolveWordStates(open, 1.2).states[0], 'active', '没给时长就唱到下一词起点');
  assert.strictEqual(resolveWordStates(open, 1.8).states[0], 'sung');
  assert.strictEqual(resolveWordStates(open, 1.8).states[1], 'active');

  const only = [{ t: 1, dur: 0, text: '你' }];
  assert.strictEqual(resolveWordStates(only, 1.2).states[0], 'active');
  assert.strictEqual(resolveWordStates(only, 1 + WORD_UNTIMED_SEC).states[0], 'sung');
});

test('displayWords：有逐字时间就用，没有则整句一个词，不按字拆', async () => {
  const { displayWords } = await fresh();
  const timed = {
    t: 1,
    text: '你好',
    words: [{ t: 1, dur: 0.4, text: '你' }, { t: 1.4, dur: 0.4, text: '好' }],
  };
  assert.strictEqual(displayWords(timed, { t: 3 }, 10).length, 2);
  assert.strictEqual(displayWords(timed, { t: 3 }, 10)[0].text, '你');

  const plain = { t: 1, text: '你好世界' };
  const one = displayWords(plain, { t: 4 }, 99);
  assert.strictEqual(one.length, 1, '句级 LRC 不拆成四个字');
  assert.strictEqual(one[0].text, '你好世界');
  assert.strictEqual(one[0].t, 1);
  assert.strictEqual(one[0].dur, 3);
  assert.strictEqual(displayWords(plain, { t: 4 }, 99), one, '同一句同一终点不另造数组');

  const tail = displayWords({ t: 8, text: '尾' }, null, 10);
  assert.strictEqual(tail[0].dur, 2);
  const unknown = displayWords({ t: 8, text: '尾' }, null, undefined);
  assert.ok(unknown[0].dur > 0);
});

test('linesFromLyricResult / loadFor：酷狗与汽水保留逐字，纯 LRC 不造词', async () => {
  const { linesFromLyricResult, loadFor, lyrics, clearLyrics } = await import(
    '../src/renderer/app/stores/lyrics.ts'
  );
  const { sentencesToKaraoke, sentencesToLrc } = require('../src/api/platforms/soda.js')._internal;

  const kugou = linesFromLyricResult({
    lrc: '[00:02.25]词：周杰伦',
    karaoke: {
      meta: { ti: '晴天' },
      lines: [{
        startMs: 2250,
        durMs: 800,
        words: [
          { text: '词', startMs: 2250, durMs: 400 },
          { text: '：周杰伦', startMs: 2650, durMs: 400 },
        ],
      }],
    },
  });
  assert.strictEqual(kugou[0].t, 2.25);
  assert.strictEqual(kugou[0].text, '词：周杰伦');
  assert.strictEqual(kugou[0].words[0].t, 2.25);
  assert.strictEqual(kugou[0].words[0].dur, 0.4);
  assert.strictEqual(kugou[0].words[1].text, '：周杰伦');

  const sentences = [
    { startMs: 0, endMs: 5134, text: '作曲：哇欣', words: [{ text: '作曲：哇欣', startMs: 0, endMs: 5134 }] },
    { startMs: 10268, endMs: 15000, text: '作词：哇欣', words: [{ text: '作', startMs: 10268, endMs: 11000 }, { text: '词：哇欣', startMs: 11000, endMs: 15000 }] },
  ];
  const soda = linesFromLyricResult({
    lrc: sentencesToLrc(sentences),
    karaoke: sentencesToKaraoke(sentences),
  });
  assert.strictEqual(soda.length, 2);
  assert.strictEqual(soda[0].words.length, 1);
  assert.strictEqual(soda[0].words[0].dur, 5.134);
  assert.strictEqual(soda[1].words[1].t, 11);
  assert.strictEqual(soda[1].words[1].text, '词：哇欣');

  const plain = linesFromLyricResult('[00:01.00]你好世界\n[00:04.00]第二句');
  assert.strictEqual(plain.length, 2);
  assert.strictEqual(plain[0].text, '你好世界');
  assert.strictEqual(plain[0].words, undefined, '句级 LRC 不发明 words');
  assert.strictEqual(plain[1].t, 4);

  const prevWindow = global.window;
  global.window = { __LY_MOCK__: {} };
  try {
    global.window.__LY_MOCK__.getLyrics = async () => ({
      lrc: '[00:02.25]词：周杰伦',
      karaoke: {
        lines: [{
          startMs: 2250,
          durMs: 800,
          words: [{ text: '词', startMs: 2250, durMs: 400 }, { text: '：周杰伦', startMs: 2650, durMs: 400 }],
        }],
      },
    });
    await loadFor({ id: 'k1', source: 'kugou', title: '晴天' });
    assert.strictEqual(lyrics.items[0].words.length, 2);
    assert.strictEqual(lyrics.items[0].words[0].text, '词');

    global.window.__LY_MOCK__.getLyrics = async () => ({
      lrc: sentencesToLrc(sentences),
      karaoke: sentencesToKaraoke(sentences),
    });
    await loadFor({ id: 's1', source: 'soda', title: '汽' });
    assert.strictEqual(lyrics.items[0].words[0].text, '作曲：哇欣');
    assert.strictEqual(lyrics.error, '');

    global.window.__LY_MOCK__.getLyrics = async () => ({ lrc: '[00:01.00]你好世界' });
    await loadFor({ id: 'n1', source: 'netease', title: '海' });
    assert.strictEqual(lyrics.items[0].text, '你好世界');
    assert.strictEqual(lyrics.items[0].words, undefined);

    global.window.__LY_MOCK__.readLocalLrc = async () => ({ lrc: '[00:01.50]本地一句' });
    await loadFor({ id: 'loc', source: 'local', title: '本地', filePath: '/tmp/a.mp3' });
    assert.strictEqual(lyrics.items[0].text, '本地一句');
    assert.strictEqual(lyrics.items[0].words, undefined);
  } finally {
    clearLyrics();
    if (prevWindow === undefined) delete global.window;
    else global.window = prevWindow;
  }
});
