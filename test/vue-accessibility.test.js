const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const APP = ['src', 'renderer', 'app'];

test('search history controls use keyboard-activatable clicks and cannot submit the form', () => {
  const src = read(...APP, 'views', 'SearchView.vue');
  assert.match(src, /<button[^>]*type="submit"[^>]*>搜索<\/button>/);
  assert.match(src, /class="ly-btn ly-btn-sm ly-btn-ghost" type="button" @click="clearSearchHistory"/);
  assert.match(src, /class="hbtn" type="button" @click="pickHistory\(h\)"/);
  assert.match(src, /class="hdel" type="button" aria-label="移除" @click="removeSearchHistoryItem\(h\)"/);
  assert.doesNotMatch(src, /@mousedown\.prevent="(?:pickHistory|removeHistoryItem)/);
  assert.match(src, /@focusout="hideHistorySoon"/);
});

test('all teleported modal surfaces use the shared focus and background isolation behavior', () => {
  const helper = read(...APP, 'composables', 'useModalAccessibility.ts');
  assert.match(helper, /app\.inert\s*=\s*true/);
  assert.match(helper, /querySelectorAll<HTMLElement>/);
  assert.match(helper, /Escape/);
  assert.match(helper, /Tab/);
  assert.match(helper, /opener\.focus\(\)/);
  assert.match(helper, /style\.zIndex/);

  for (const file of [
    ['components', 'shell', 'DialogHost.vue'],
    ['components', 'shell', 'CommandPalette.vue'],
    ['components', 'player', 'PlayQueueDrawer.vue'],
    ['components', 'data', 'PlaylistPeek.vue'],
    ['views', 'NowPlayingView.vue'],
  ]) {
    const src = read(...APP, ...file);
    assert.match(src, /useModalAccessibility\(/, `${file.join('/')} must use the shared modal behavior`);
    assert.match(src, /aria-modal="true"/, `${file.join('/')} must retain modal semantics`);
  }
  assert.match(read(...APP, 'components', 'shell', 'AppShell.vue'), /settleDialog\(false\)/);
});

test('both playback progress controls expose a keyboard-operable slider value', () => {
  for (const file of [
    ['components', 'player', 'PlayerBar.vue'],
    ['views', 'NowPlayingView.vue'],
  ]) {
    const src = read(...APP, ...file);
    assert.match(src, /role="slider"[^>]*tabindex="0"/, `${file.join('/')} slider must be focusable`);
    assert.match(src, /:aria-valuenow=/, `${file.join('/')} slider must expose its current value`);
    assert.match(src, /:aria-valuetext=/, `${file.join('/')} slider must expose a readable time value`);
    assert.match(src, /@keydown="onScrubKeydown"/, `${file.join('/')} slider must support keyboard seeking`);
  }
});

test('song playback and queue actions have native keyboard semantics without nested activation', () => {
  const songs = read(...APP, 'components', 'data', 'SongTable.vue');
  assert.match(songs, /<button[^>]*class="cover-play"[^>]*type="button"[^>]*:aria-label=/);

  const queue = read(...APP, 'components', 'player', 'PlayQueueDrawer.vue');
  assert.match(queue, /<button[^>]*class="qplay"[^>]*type="button"[^>]*aria-label=/);
  assert.match(queue, /class="ly-icon-btn danger"[^>]*aria-label="移除"[^>]*@click="removeAt/);
  assert.doesNotMatch(queue, /class="qitem"[^>]*@click="playAt/);
});

test('selected settings and playlist deletion have accessible names and state', () => {
  const playlist = read(...APP, 'views', 'PlaylistView.vue');
  assert.match(playlist, /ly-btn-danger"[^>]*:aria-label="`删除歌单 \$\{activePlaylist\.name\}`"/);

  const settings = read(...APP, 'views', 'SettingsView.vue');
  assert.match(settings, /:aria-pressed="ui\.theme === 'light'"/);
  assert.match(settings, /:aria-pressed="ui\.theme === 'dark'"/);
  assert.match(settings, /:aria-pressed="ui\.lang === 'zh'"/);
  assert.match(settings, /:aria-pressed="ui\.lang === 'en'"/);
  assert.match(settings, /:aria-pressed="settings\.playQuality === 'standard'"/);
  assert.match(settings, /:aria-pressed="settings\.playQuality === 'hq'"/);
  assert.match(settings, /:aria-pressed="settings\.playQuality === 'lossless'"/);
});

test('disabled icon buttons stay visually disabled on hover and active states', () => {
  const css = read(...APP, 'styles', 'base.css');
  assert.match(css, /\.ly-icon-btn:disabled\s*\{[^}]*cursor:\s*not-allowed/s);
  assert.match(css, /\.ly-icon-btn:disabled:hover\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /\.ly-icon-btn:disabled:active\s*\{[^}]*transform:\s*none/s);
});
