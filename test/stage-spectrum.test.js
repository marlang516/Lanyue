/**
 * 舞台频谱氛围：叠在现有播放舞台、全屏歌词和舞台投桌面上的一层淡频谱。
 *
 * 默认关。关掉、暂停、停播都不画。打开且正在出声时，只读播放槽上
 * 已经接好的 analyser，不另建捕获。这一层不接指针。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('关掉或没在播时，舞台、全屏和桌面都不出频谱', async () => {
  const { spectrumAtmospherePlan } = await import(
    '../src/renderer/app/core/spectrumAtmosphere.js'
  );
  for (const surface of ['main', 'fullscreen', 'desktop']) {
    const off = spectrumAtmospherePlan({
      enabled: false,
      playing: true,
      projecting: true,
      surface,
    });
    assert.equal(off.visible, false, surface);
    assert.equal(off.tier, 'off', surface);
    assert.equal(off.blocksPointer, false, surface);
    const paused = spectrumAtmospherePlan({
      enabled: true,
      playing: false,
      projecting: true,
      surface,
    });
    assert.equal(paused.visible, false, `${surface} paused`);
    assert.equal(paused.animate, false, `${surface} paused`);
  }
});

test('正在出声时舞台出现淡频谱，不挡住歌词和指针', async () => {
  const { spectrumAtmospherePlan, SPECTRUM_ALPHA_CAP } = await import(
    '../src/renderer/app/core/spectrumAtmosphere.js'
  );
  const plan = spectrumAtmospherePlan({
    enabled: true,
    playing: true,
    projecting: false,
    surface: 'main',
  });
  assert.equal(plan.visible, true);
  assert.equal(plan.tier, 'full');
  assert.ok(plan.count > 0);
  assert.equal(plan.blocksPointer, false);
  assert.equal(plan.obstructsLyrics, false);
  assert.ok(SPECTRUM_ALPHA_CAP <= 0.2);

  const disc = read('src/renderer/app/views/DiscoverView.vue');
  const layer = read('src/renderer/app/components/player/SpectrumAtmosphereLayer.vue');
  const playing = disc.slice(
    disc.indexOf('class="stage ly-card"'),
    disc.indexOf('class="stage ly-card idle"'),
  );
  assert.match(playing, /SpectrumAtmosphereLayer/);
  assert.match(playing, /v-if="player\.spectrumAtmosphere"/);
  assert.match(playing, /surface="main"/);
  const layerAt = playing.indexOf('SpectrumAtmosphereLayer');
  const lyricsAt = playing.indexOf('class="lyrics"');
  assert.ok(layerAt >= 0 && lyricsAt > layerAt, '频谱画在歌词之前');
  assert.match(layer, /pointer-events:\s*none/);
  assert.match(layer, /z-index:\s*0/);
  assert.match(layer, /aria-hidden="true"/);
  assert.match(layer, /data-spectrum-atmosphere/);
  assert.doesNotMatch(layer, /stepLyricPerformance/);
  assert.doesNotMatch(layer, /retainLyricTrack/);
});

test('全屏歌词页叠同一层，歌词和控制条仍在上面', async () => {
  const { spectrumAtmospherePlan } = await import(
    '../src/renderer/app/core/spectrumAtmosphere.js'
  );
  const plan = spectrumAtmospherePlan({
    enabled: true,
    playing: true,
    projecting: false,
    surface: 'fullscreen',
  });
  assert.equal(plan.visible, true);
  assert.equal(plan.blocksPointer, false);
  assert.equal(plan.obstructsLyrics, false);

  const now = read('src/renderer/app/views/NowPlayingView.vue');
  const pane = read('src/renderer/app/components/player/LyricsPane.vue');
  assert.match(now, /SpectrumAtmosphereLayer/);
  assert.match(now, /v-if="player\.spectrumAtmosphere"/);
  assert.match(now, /surface="fullscreen"/);
  assert.doesNotMatch(pane, /SpectrumAtmosphereLayer|spectrumAtmosphere|data-spectrum-atmosphere/);
  const layerAt = now.indexOf('SpectrumAtmosphereLayer');
  const lyricsAt = now.indexOf('<LyricsPane');
  const controlsAt = now.indexOf('class="ctr ly-card"');
  assert.ok(layerAt >= 0 && lyricsAt > layerAt && controlsAt > layerAt);
});

test('舞台投桌面沿用现有窗：不改壁纸，关闭钮仍可点，频谱不接指针', async () => {
  const { spectrumAtmospherePlan, shouldPaintSpectrum } = await import(
    '../src/renderer/app/core/spectrumAtmosphere.js'
  );
  const { STAGE_FULL_FRAME_MS, STAGE_PROJECTED_FRAME_MS } = await import(
    '../src/renderer/app/core/lyricMotion.js'
  );
  const desk = spectrumAtmospherePlan({
    enabled: true,
    playing: true,
    projecting: true,
    surface: 'desktop',
  });
  const main = spectrumAtmospherePlan({
    enabled: true,
    playing: true,
    projecting: true,
    surface: 'main',
  });
  assert.equal(desk.visible, true);
  assert.equal(desk.tier, 'full');
  assert.equal(desk.blocksPointer, false);
  assert.equal(desk.frameMs, STAGE_FULL_FRAME_MS);
  assert.equal(main.tier, 'cheap');
  assert.equal(main.frameMs, STAGE_PROJECTED_FRAME_MS);
  assert.equal(spectrumAtmospherePlan({
    enabled: true, playing: true, projecting: false, surface: 'desktop',
  }).visible, false);
  assert.equal(shouldPaintSpectrum(-1, 0, main), true);
  assert.equal(shouldPaintSpectrum(0, main.frameMs - 1, main), false);
  assert.equal(shouldPaintSpectrum(0, main.frameMs, main), true);

  const html = read('src/renderer/desktop-lyric.html');
  const win = read('src/main/ipc/window.js');
  assert.match(html, /id="stageSpectrum"/);
  assert.match(html, /pointer-events:\s*none/);
  assert.match(html, /id="stageClose"/);
  assert.match(html, /aria-label="关闭舞台投桌面"/);
  assert.match(html, /desktop-stage-hit/);
  assert.match(html, /pointer-events:\s*auto/);
  assert.doesNotMatch(html, /setWallpaper|SystemParametersInfo|IDesktopWallpaper/);
  assert.doesNotMatch(html, /new BrowserWindow|window\.open\s*\(/);
  assert.doesNotMatch(win, /desktop-spectrum\.html/);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/renderer/desktop-spectrum.html')), false);

  const handlerAt = html.indexOf("window.miniAPI.on('desktop-lyric-data'");
  assert.ok(handlerAt > 0);
  const handler = html.slice(handlerAt, handlerAt + 1800);
  const sampleAt = handler.indexOf('isSpectrumSample');
  const clockAt = handler.indexOf('armStageClock');
  assert.ok(sampleAt > -1 && clockAt > sampleAt, '频谱抽样先返回，不能重置桌面歌词时钟');
  const earlyEnd = handler.indexOf('return;', sampleAt);
  const early = handler.slice(sampleAt, earlyEnd);
  assert.doesNotMatch(early, /lyrics\s*=/);
  assert.doesNotMatch(early, /lyricSig\s*=/);
  assert.doesNotMatch(early, /innerHTML/);
});

test('频谱抽样不改已经建好的歌词轨', async () => {
  const motion = await import('../src/renderer/app/core/lyricMotion.js');
  const atmosphere = await import('../src/renderer/app/core/spectrumAtmosphere.js');
  const items = [
    { t: 0, text: '甲' },
    { t: 4, text: '乙' },
  ];
  const clock = () => 0;
  const first = motion.stepLyricPerformance({
    sourceKey: 'stage-spectrum-track',
    playing: true,
    items,
    duration: 8,
    nowMs: 0,
    budgetMs: 1000,
    clock,
  });
  const kept = atmosphere.foldSpectrumFrame(
    { enabled: true, projecting: true, playing: true, bands: [0.2] },
    { spectrum: [0.1, 0.4] },
  );
  assert.equal(kept.playing, true);
  assert.equal(kept.projecting, true);
  assert.deepEqual(kept.bands, [0.1, 0.4]);
  assert.equal(kept.plan.visible, true);
  assert.equal(kept.plan.blocksPointer, false);
  const paused = atmosphere.foldSpectrumFrame(kept, {
    playing: false,
    spectrumAtmosphere: true,
    stage: true,
  });
  assert.equal(paused.plan.visible, false);
  const again = motion.stepLyricPerformance({
    sourceKey: 'stage-spectrum-track',
    playing: true,
    items,
    duration: 8,
    nowMs: 0,
    budgetMs: 1000,
    clock,
  });
  assert.equal(again.track, first.track);
  assert.equal(again.track.lines[0].text, '甲');
  assert.equal(again.track.lines[1].text, '乙');
});

test('字节收成很淡的柱，静音是 0，画上去不盖住中段歌词', async () => {
  const {
    shapeBands,
    followBands,
    mixFrequencyChunks,
    paintSpectrumAtmosphere,
    SPECTRUM_ALPHA_CAP,
  } = await import('../src/renderer/app/core/spectrumAtmosphere.js');
  assert.deepEqual(shapeBands(new Uint8Array(128), 8), new Array(8).fill(0));
  assert.deepEqual(shapeBands(null, 4), [0, 0, 0, 0]);
  const loud = shapeBands(new Uint8Array(128).fill(255), 4);
  assert.equal(loud.length, 4);
  assert.ok(loud.every((v) => v > 0 && v < 1), `满幅也不该画满，实得 ${loud.join(',')}`);
  const quiet = new Uint8Array(128);
  quiet.fill(255, 0, 32);
  const tilted = shapeBands(quiet, 4);
  assert.ok(tilted[0] > tilted[3], '前段更响时第一柱更高');

  const into = new Uint8Array(4);
  assert.equal(mixFrequencyChunks([
    { bytes: [0, 100, 0, 0], weight: 1 },
    { bytes: [0, 0, 50, 0], weight: 1 },
  ], into), true);
  assert.deepEqual(Array.from(into), [0, 50, 25, 0]);
  assert.equal(mixFrequencyChunks([], into), false);

  const followed = followBands([0, 0], [1, 0], 0.5);
  assert.ok(followed[0] > 0 && followed[0] < 1);
  assert.equal(followed[1], 0);

  const fills = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    clearRect() {},
    fillRect(x, y, w, h) {
      fills.push({ alpha: this.globalAlpha, fillStyle: this.fillStyle, x, y, w, h });
    },
  };
  const painted = paintSpectrumAtmosphere(ctx, [1, 0, 0.4], 200, 100);
  assert.ok(painted > 0);
  assert.ok(fills.length > 0);
  for (const fill of fills) {
    assert.ok(fill.alpha <= SPECTRUM_ALPHA_CAP, `透明度 ${fill.alpha} 超过上限`);
    assert.equal(fill.fillStyle, 'rgb(255, 248, 236)');
    assert.ok(fill.y >= 100 * 0.6, '频谱只落在下沿，不铺进歌词中段');
  }
  fills.length = 0;
  assert.equal(paintSpectrumAtmosphere(ctx, [0, 0, 0], 200, 100), 0);
  assert.equal(fills.length, 0);
});

test('偏好默认关，设置里的开关写进同一套播放设置', () => {
  const player = read('src/renderer/app/stores/player.ts');
  const settings = read('src/renderer/app/views/SettingsView.vue');
  const settingsStore = read('src/renderer/app/stores/settings.ts');
  const prefs = read('src/main/ipc/prefs.js');
  const src = read('src/renderer/app/core/spectrumAtmosphere.js');
  assert.match(player, /spectrumAtmosphere:\s*false/);
  assert.match(player, /SPECTRUM_ATMOSPHERE_PREF_KEY/);
  assert.match(player, /setSpectrumAtmosphere/);
  assert.match(settingsStore, /changeSpectrumAtmosphere/);
  assert.match(settingsStore, /setSpectrumAtmosphere/);
  const playback = settings.slice(
    settings.indexOf("settings.tab === 'playback'"),
    settings.indexOf("settings.tab === 'download'"),
  );
  const dustAt = playback.indexOf('封面微尘');
  const spectrumAt = playback.indexOf('舞台频谱');
  const speedAt = playback.indexOf('播放速度');
  assert.ok(dustAt > 0 && spectrumAt > dustAt && speedAt > spectrumAt, '开关挨着封面微尘');
  assert.match(playback, /changeSpectrumAtmosphere\(false\)/);
  assert.match(playback, /changeSpectrumAtmosphere\(true\)/);
  assert.match(prefs, /'spectrumAtmosphere'/);
  assert.match(src, /'spectrumAtmosphere'/);
});

test('只读现有播放槽的 analyser，不另开捕获', async () => {
  const { createAudibleSlots } = await import('../src/renderer/js/playback/wire.js');
  const atmosphere = read('src/renderer/app/core/spectrumAtmosphere.js');
  const player = read('src/renderer/app/stores/player.ts');
  const layer = read('src/renderer/app/components/player/SpectrumAtmosphereLayer.vue');
  assert.doesNotMatch(atmosphere, /createAnalyser|createMediaElementSource|AudioContext|WASAPI|getDisplayMedia|loopback|computeBars/);
  assert.doesNotMatch(player, /createAnalyser|WASAPI|getDisplayMedia|loopback/);
  assert.doesNotMatch(layer, /createAnalyser|WASAPI|getDisplayMedia|loopback/);
  assert.match(player, /copyFrequency/);
  assert.match(layer, /copySoundingFrequency/);

  let analysers = 0;
  let reads = 0;
  const el = {
    id: 'live',
    volume: 1,
    muted: false,
    src: 'stream://live',
    pause() {},
    load() {},
    removeAttribute() {},
  };
  const slots = createAudibleSlots({
    audioContextFactory() {
      return {
        state: 'running',
        destination: { id: 'dest' },
        resume() { return Promise.resolve(); },
        createMediaElementSource() { return { connect() {} }; },
        createGain() { return { gain: { value: 1 }, connect() {} }; },
        createBiquadFilter() {
          return { type: '', frequency: { value: 0 }, Q: { value: 1 }, connect() {} };
        },
        createAnalyser() {
          analysers += 1;
          return {
            fftSize: 256,
            frequencyBinCount: 128,
            smoothingTimeConstant: 0,
            connect() {},
            getByteFrequencyData(target) {
              reads += 1;
              target.fill(200);
            },
          };
        },
      };
    },
  });
  const buf = new Uint8Array(128);
  assert.equal(slots.copyFrequency('live', buf), false);
  assert.equal(slots.attach('live', el), true);
  assert.equal(slots.copyFrequency('live', buf), true);
  assert.equal(slots.copyFrequency('live', buf), true);
  assert.equal(analysers, 1, '同一元素只建图里已有的那一个 analyser');
  assert.equal(reads, 2);
  assert.equal(buf[0], 200);
  assert.equal(buf[127], 200);
});

test('打包进桌面页的是同一套频谱，不另开窗口', () => {
  const { runPostbuild } = require('../scripts/postbuild');
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-spectrum-dist-'));
  const dist = path.join(appRoot, 'dist');
  try {
    runPostbuild({ root: ROOT, dist });
    const html = fs.readFileSync(path.join(dist, 'renderer', 'desktop-lyric.html'), 'utf8');
    assert.match(html, /function spectrumAtmospherePlan/);
    assert.match(html, /__spectrumAtmosphereApi/);
    assert.match(html, /id="stageSpectrum"/);
    assert.doesNotMatch(html, /^export /m);
    assert.equal(fs.existsSync(path.join(dist, 'renderer', 'desktop-spectrum.html')), false);
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
