/**
 * 封面微尘：叠在现有播放舞台、全屏歌词和舞台投桌面上的一层光点。
 *
 * 默认关。关掉时不画。打开后主窗口跟现有舞台画价走；
 * 投射开着时桌面那一份可以全价，主窗口仍是便宜档。
 * 这一层不接指针，也不拆已经建好的歌词轨。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('关掉时舞台、全屏和桌面都不出微尘', async () => {
  const { coverDustPlan, createCoverDust } = await import(
    '../src/renderer/app/core/coverParticles.js'
  );
  for (const surface of ['main', 'fullscreen', 'desktop']) {
    const plan = coverDustPlan({ enabled: false, projecting: true, surface });
    assert.equal(plan.visible, false, surface);
    assert.equal(plan.count, 0, surface);
    assert.equal(plan.tier, 'off', surface);
    assert.equal(createCoverDust(plan.count, 1).motes.length, 0, surface);
  }
});

test('打开后播放舞台出现微尘层，歌词和控件仍在它上面', async () => {
  const { coverDustPlan } = await import('../src/renderer/app/core/coverParticles.js');
  const plan = coverDustPlan({ enabled: true, projecting: false, surface: 'main' });
  assert.equal(plan.visible, true);
  assert.equal(plan.tier, 'full');
  assert.ok(plan.count > 0);
  assert.equal(plan.blocksPointer, false);
  assert.equal(plan.obstructsLyrics, false);

  const disc = read('src/renderer/app/views/DiscoverView.vue');
  const dust = read('src/renderer/app/components/player/CoverDustLayer.vue');
  const playing = disc.slice(
    disc.indexOf('class="stage ly-card"'),
    disc.indexOf('class="stage ly-card idle"'),
  );
  assert.match(playing, /CoverDustLayer/);
  assert.match(playing, /v-if="player\.coverParticles"/);
  assert.match(playing, /surface="main"/);
  assert.match(playing, /class="lyrics"/);
  const dustAt = playing.indexOf('CoverDustLayer');
  const lyricsAt = playing.indexOf('class="lyrics"');
  assert.ok(dustAt >= 0 && lyricsAt > dustAt, '微尘画在歌词之前，不能把歌词包进自己');
  assert.match(dust, /pointer-events:\s*none/);
  assert.match(dust, /z-index:\s*0/);
  assert.match(dust, /data-cover-dust/);
  assert.doesNotMatch(dust, /stepLyricPerformance/);
  assert.doesNotMatch(dust, /retainLyricTrack/);

  const stageBody = disc.slice(disc.indexOf('.stage-body'), disc.indexOf('.meta'));
  assert.match(stageBody, /z-index:\s*1/);
});

test('全屏歌词页同样叠这一层，控制条不被挡住', async () => {
  const { coverDustPlan } = await import('../src/renderer/app/core/coverParticles.js');
  const plan = coverDustPlan({ enabled: true, projecting: false, surface: 'fullscreen' });
  assert.equal(plan.visible, true);
  assert.equal(plan.blocksPointer, false);
  assert.equal(plan.obstructsLyrics, false);

  const now = read('src/renderer/app/views/NowPlayingView.vue');
  const pane = read('src/renderer/app/components/player/LyricsPane.vue');
  assert.match(now, /CoverDustLayer/);
  assert.match(now, /v-if="player\.coverParticles"/);
  assert.match(now, /surface="fullscreen"/);
  assert.match(now, /<LyricsPane \/>/);
  assert.doesNotMatch(pane, /CoverDustLayer|coverParticles|data-cover-dust/);
  const dustAt = now.indexOf('CoverDustLayer');
  const lyricsAt = now.indexOf('<LyricsPane');
  const controlsAt = now.indexOf('class="ctr ly-card"');
  assert.ok(dustAt >= 0 && lyricsAt > dustAt && controlsAt > dustAt);
  assert.match(now, /\.hd[\s\S]*z-index:\s*1/);
  assert.match(now, /\.ctr[\s\S]*z-index:\s*1/);
});

test('舞台投桌面且开关打开时，微尘进现有桌面窗；主窗口改便宜档', async () => {
  const {
    coverDustPlan,
    shouldPaintCoverDust,
  } = await import('../src/renderer/app/core/coverParticles.js');
  const { stageFrameBudget, STAGE_FULL_FRAME_MS, STAGE_PROJECTED_FRAME_MS } = await import(
    '../src/renderer/app/core/lyricMotion.js'
  );

  const desk = coverDustPlan({ enabled: true, projecting: true, surface: 'desktop' });
  const main = coverDustPlan({ enabled: true, projecting: true, surface: 'main' });
  const full = coverDustPlan({ enabled: true, projecting: true, surface: 'fullscreen' });
  assert.equal(desk.visible, true);
  assert.equal(desk.tier, 'full');
  assert.equal(desk.frameMs, STAGE_FULL_FRAME_MS);
  assert.equal(main.visible, true);
  assert.equal(main.tier, 'cheap');
  assert.equal(main.frameMs, STAGE_PROJECTED_FRAME_MS);
  assert.equal(full.tier, 'cheap');
  assert.ok(main.count > 0 && main.count < desk.count);
  assert.ok(main.frameMs > desk.frameMs);
  assert.equal(coverDustPlan({ enabled: true, projecting: false, surface: 'desktop' }).visible, false);
  assert.equal(coverDustPlan({ enabled: false, projecting: true, surface: 'desktop' }).visible, false);

  const budget = stageFrameBudget(true);
  assert.equal(budget.desktop.fullCost, true);
  assert.equal(budget.main.fullCost, false);
  assert.equal(budget.competingFullScenes, false);
  assert.equal(shouldPaintCoverDust(-1, 0, main), true);
  assert.equal(shouldPaintCoverDust(0, main.frameMs - 1, main), false);
  assert.equal(shouldPaintCoverDust(0, main.frameMs, main), true);
  assert.equal(shouldPaintCoverDust(0, 1, desk), true);

  const html = read('src/renderer/desktop-lyric.html');
  const win = read('src/main/ipc/window.js');
  assert.match(html, /id="coverDust"/);
  assert.match(html, /id="stageCover"/);
  assert.match(html, /coverParticles/);
  assert.match(html, /pointer-events:\s*none/);
  assert.match(html, /function desktopTrackSignature/);
  assert.match(html, /sig !== lyricSig/);
  assert.match(html, /mountDesktopCoverDust|__coverDust/);
  assert.doesNotMatch(html, /new BrowserWindow|window\.open\s*\(/);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/renderer/desktop-cover.html')), false);
  assert.doesNotMatch(win, /desktop-cover\.html/);
  assert.match(read('src/renderer/app/stores/player.ts'), /coverParticles/);
});

test('打包进桌面页的是同一套微尘，不另开窗口', () => {
  const { runPostbuild } = require('../scripts/postbuild');
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-dust-dist-'));
  const dist = path.join(appRoot, 'dist');
  try {
    runPostbuild({ root: ROOT, dist });
    const html = fs.readFileSync(path.join(dist, 'renderer', 'desktop-lyric.html'), 'utf8');
    assert.match(html, /function coverDustPlan/);
    assert.match(html, /__coverDustApi/);
    assert.match(html, /id="coverDust"/);
    assert.doesNotMatch(html, /^export /m);
    assert.equal(fs.existsSync(path.join(dist, 'renderer', 'desktop-cover.html')), false);
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
    assert.ok(script, '桌面页应有一段内联脚本');
    const file = path.join(appRoot, 'desk.js');
    fs.writeFileSync(file, script[1]);
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('微尘步进不拆已经建好的歌词轨', async () => {
  const motion = await import('../src/renderer/app/core/lyricMotion.js');
  const dust = await import('../src/renderer/app/core/coverParticles.js');
  const items = [
    { t: 0, text: '甲' },
    { t: 4, text: '乙' },
  ];
  const clock = () => 0;
  const first = motion.stepLyricPerformance({
    sourceKey: 'cover-dust-track',
    playing: true,
    items,
    duration: 8,
    nowMs: 0,
    budgetMs: 1000,
    clock,
  });
  assert.equal(first.track.complete, true);
  const lines = first.track.lines;
  const revision = first.track.revision;
  const built = first.track.built;

  const plan = dust.coverDustPlan({ enabled: true, projecting: false, surface: 'fullscreen' });
  let field = dust.createCoverDust(plan.count, 7);
  for (let i = 0; i < 24; i++) {
    field = dust.stepCoverDust(field, i * 16, dust.coverRhythm({ playing: true, seconds: i / 8 }), 16);
  }
  dust.coverDustPlan({ enabled: false, projecting: true, surface: 'desktop' });
  dust.stepCoverDust(field, 400, 0, 16, false);

  const again = motion.stepLyricPerformance({
    sourceKey: 'cover-dust-track',
    playing: true,
    items,
    duration: 8,
    nowMs: 0,
    budgetMs: 1000,
    clock,
  });
  assert.equal(again.track, first.track);
  assert.equal(again.track.lines, lines);
  assert.equal(again.track.revision, revision);
  assert.equal(again.track.built, built);
  assert.equal(again.track.lines[0].text, '甲');
  assert.equal(again.track.lines[1].text, '乙');

  const kept = dust.foldDesktopLyricFrame(
    { lyrics: items, lyricSig: motion.desktopTrackSignature(items), curIdx: 1 },
    { stage: true, coverParticles: true, currentTime: 1.2, lyrics: items },
  );
  assert.equal(kept.rebuilt, false);
  assert.equal(kept.lyrics, items);
  assert.equal(kept.curIdx, 1);
  assert.equal(kept.cover.visible, true);

  const html = read('src/renderer/desktop-lyric.html');
  const publishAt = html.indexOf('function publishCoverDust');
  assert.ok(publishAt > 0, '桌面页用单独的函数接微尘，不塞进换轨分支');
  const nextFn = html.indexOf('\n    function ', publishAt + 10);
  const body = html.slice(publishAt, nextFn > publishAt ? nextFn : publishAt + 500);
  assert.doesNotMatch(body, /lyrics\s*=/);
  assert.doesNotMatch(body, /lyricSig\s*=/);
  assert.doesNotMatch(body, /innerHTML/);
});

test('光点跟着响度轻轻浮动，歌词带上更淡，也不做频谱', async () => {
  const {
    createCoverDust,
    stepCoverDust,
    coverRhythm,
    motePaintAlpha,
    rhythmFromBytes,
  } = await import('../src/renderer/app/core/coverParticles.js');
  const src = read('src/renderer/app/core/coverParticles.js');
  assert.doesNotMatch(src, /getByteFrequencyData|computeBars|spectrum|频谱氛围/);

  const quiet = coverRhythm({ playing: false, seconds: 3 });
  const moving = coverRhythm({ playing: true, seconds: 0.7 });
  assert.equal(quiet, 0);
  assert.ok(moving > quiet && moving <= 1);
  assert.equal(coverRhythm({ playing: false, level: 0.4 }), 0.4);
  assert.equal(rhythmFromBytes(new Uint8Array([0, 255])), 0.5);

  const rested = createCoverDust(6, 4);
  const lively = createCoverDust(6, 4);
  const y0 = rested.motes.map((m) => m.y);
  stepCoverDust(rested, 1000, 0, 80);
  stepCoverDust(lively, 1000, 1, 80);
  let restShift = 0;
  let liveShift = 0;
  for (let i = 0; i < y0.length; i++) {
    restShift += Math.abs(rested.motes[i].y - y0[i]);
    liveShift += Math.abs(lively.motes[i].y - y0[i]);
  }
  assert.ok(liveShift > restShift, '节奏越明显，微尘漂得越多一点');

  const edge = motePaintAlpha({ y: 0.08, alpha: 0.2 }, 0.2);
  const band = motePaintAlpha({ y: 0.5, alpha: 0.2 }, 0.2);
  assert.ok(band < edge);
  assert.ok(edge <= 0.3 && band <= 0.3);

  const player = read('src/renderer/app/stores/player.ts');
  const settings = read('src/renderer/app/views/SettingsView.vue');
  const prefs = read('src/main/ipc/prefs.js');
  assert.match(player, /coverParticles:\s*false/);
  assert.match(player, /COVER_PARTICLES_PREF_KEY/);
  assert.match(settings, /封面微尘/);
  assert.match(settings, /changeCoverParticles\(false\)/);
  assert.match(settings, /changeCoverParticles\(true\)/);
  assert.match(prefs, /'coverParticles'/);
  assert.match(src, /'coverParticles'/);
});
