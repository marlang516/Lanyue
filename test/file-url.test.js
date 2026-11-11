/**
 * 本地播放的 file URL 必须把 # 和 ? 留在路径里。
 *
 * 直接拼接 file:// 时，URL 解析器把 # 当成片段、把 ? 当成查询。
 * Symphony #5.mp3 会被请求成 Symphony，文件不存在。空格和反斜杠
 * 解析器自己会归一，不是这条缺陷。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { fileUrlFromPath } = require('../src/shared/fileUrl.mjs');

function pathOf(url) {
  const u = new URL(url);
  assert.equal(u.hash, '', url);
  assert.equal(u.search, '', url);
  return decodeURIComponent(u.pathname);
}

test('fileUrlFromPath：# 留在路径里，不再变成片段', () => {
  const url = fileUrlFromPath('/home/a/Symphony #5.mp3');
  assert.equal(pathOf(url), '/home/a/Symphony #5.mp3');
  assert.equal(pathOf(fileUrlFromPath('C:/Music/Symphony #5.mp3')), '/C:/Music/Symphony #5.mp3');
});

test('fileUrlFromPath：? 留在路径里，不再变成查询', () => {
  assert.equal(pathOf(fileUrlFromPath('/tmp/song?live=1.mp3')), '/tmp/song?live=1.mp3');
});

test('fileUrlFromPath：没有 # 或 ? 时保持原先的拼接结果', () => {
  assert.equal(fileUrlFromPath('D:/music/测试曲.flac'), 'file://D:/music/测试曲.flac');
  assert.equal(fileUrlFromPath('C:/Music/Artist - Song.mp3'), 'file://C:/Music/Artist - Song.mp3');
});

test('fileUrlFromPath：反斜杠先换成斜杠，再交给同一套编码', () => {
  assert.equal(fileUrlFromPath('C:\\Music\\Symphony #5.mp3'), 'file://C:/Music/Symphony %235.mp3');
  assert.equal(pathOf(fileUrlFromPath('C:\\Music\\Symphony #5.mp3')), '/C:/Music/Symphony #5.mp3');
});

test('接线：src 里不再出现 file:// 字符串拼接', () => {
  const root = path.join(__dirname, '..', 'src');
  const hits = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|ts|vue)$/.test(name)) continue;
      const rel = path.relative(path.join(__dirname, '..'), full).split(path.sep).join('/');
      if (rel === 'src/shared/fileUrl.mjs') continue;
      const text = fs.readFileSync(full, 'utf8');
      text.split(/\r?\n/).forEach((line, i) => {
        if (/file:\/\/['"`]\s*\+/.test(line) || /['"`]file:\/\/['"`]\s*\+/.test(line)) {
          hits.push(`${rel}:${i + 1}`);
        }
      });
    }
  })(root);
  assert.deepEqual(hits, []);
});
