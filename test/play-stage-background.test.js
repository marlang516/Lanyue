/**
 * 发现页右侧播放舞台：当前歌曲封面做半透明背景。
 *
 * 1.1.5 起舞台不再放硬封面块，歌名贴在上沿、大号歌词是主体。
 * 封面仍要能认出是这首歌，同时半透明，歌词和标题保持可读。
 * 没有封面、封面加载失败、或根本没在播放时，沿用极光空底。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src/renderer/app/views/DiscoverView.vue'),
  'utf8',
);

function styleText(src) {
  const start = src.lastIndexOf('<style');
  const open = src.indexOf('>', start);
  const end = src.indexOf('</style>', open);
  assert.ok(start >= 0 && open > start && end > open, 'DiscoverView 应有一段样式');
  return src.slice(open + 1, end);
}

function ruleBody(css, selector) {
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf('{', i);
    if (brace < 0) break;
    const sel = css.slice(i, brace);
    let depth = 1;
    let j = brace + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    const selectors = sel.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) return css.slice(brace + 1, j - 1);
    i = j;
  }
  return '';
}

const CSS = styleText(SRC);
const WASH = ruleBody(CSS, '.wash');
const VEIL = ruleBody(CSS, '.veil');

test('正在播放时，舞台背景是当前歌曲封面，且半透明、仍能认出封面', () => {
  const playing = SRC.slice(
    SRC.indexOf('class="stage ly-card"'),
    SRC.indexOf('class="stage ly-card idle"'),
  );
  assert.match(playing, /class="wash"/);
  assert.match(playing, /:src="player\.current\.cover"/);
  assert.equal((playing.match(/<img\b/g) || []).length, 1, '舞台里只留一张铺底封面，不再加硬封面块');
  assert.doesNotMatch(playing, /class="(?:art|disc|cover)"/);

  assert.match(playing, /<b>\{\{ player\.current\.title \}\}<\/b>/);
  assert.match(playing, /player\.current\.artist \|\| '未知歌手'/);
  assert.match(playing, /class="meta"/);
  assert.match(playing, /class="lyrics"/);
  assert.match(playing, /lyricLines\.cur \? 'cur' : 'gap'/);

  const opacity = WASH.match(/opacity:\s*(0?\.\d+|\d+(?:\.\d+)?)/);
  assert.ok(opacity, '.wash 需要半透明，不能铺满不透明的封面');
  const alpha = Number(opacity[1]);
  assert.ok(alpha >= 0.5 && alpha <= 0.68, `封面透明度 ${alpha} 要么太实，要么淡到看不见`);

  const blur = WASH.match(/blur\(\s*(\d+(?:\.\d+)?)px\s*\)/);
  assert.ok(blur, '封面仍要轻微柔化，避免变回一块硬封面');
  const radius = Number(blur[1]);
  assert.ok(radius >= 4 && radius <= 14, `模糊 ${radius}px 会把封面洗成色块，或锐得像硬图`);

  const stops = [...VEIL.matchAll(
    /color-mix\(\s*in srgb,\s*var\(\s*--bg\s*\)\s+(\d+)%[^)]*\)\s+(\d+)%/g,
  )];
  assert.ok(stops.length >= 3, '播放中的罩层仍用主题色渐变，保证歌词可读');
  const middle = stops.filter((m) => {
    const at = Number(m[2]);
    return at >= 15 && at <= 85;
  });
  assert.ok(middle.length >= 1, '歌词所在的中段需要罩层');
  for (const m of middle) {
    const mix = Number(m[1]);
    assert.ok(mix >= 16 && mix <= 28, `中段罩层 ${mix}% 会把封面盖住或让歌词失去依托`);
  }
});

test('没有封面、封面坏了、或没在播放时，舞台退回极光空底；切歌会换上新封面', () => {
  assert.match(SRC, /:class="\{ bare: !player\.current\.cover \|\| coverGone \}"/);
  assert.match(SRC, /v-if="player\.current\.cover && !coverGone"/);
  const drop = SRC.slice(SRC.indexOf('function dropBrokenImg'), SRC.indexOf('function openStage'));
  assert.match(drop, /function dropBrokenImg\(\): void \{\s*coverGone\.value = true;\s*\}/);
  assert.doesNotMatch(drop, /\.remove\(\)/, '失败的封面交给 v-if 卸掉，手动摘节点会让极光空底的 class 补不上');
  assert.match(
    SRC,
    /watch\(\(\) => player\.current\?\.cover,\s*\(\) => \{\s*coverGone\.value = false;\s*\}\)/,
  );

  const idle = SRC.slice(SRC.indexOf('class="stage ly-card idle"'), SRC.indexOf('</aside>'));
  assert.match(idle, /未在播放/);
  assert.doesNotMatch(idle, /class="wash"/);

  const bare = ruleBody(CSS, '.stage.bare .veil');
  assert.match(bare, /var\(\s*--blob-1\s*\)/);
  assert.match(bare, /var\(\s*--blob-2\s*\)/);
  assert.doesNotMatch(bare, /url\(/);
});
