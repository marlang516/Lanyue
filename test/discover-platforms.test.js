/**
 * 发现页平台条只放有榜单或歌单的音源。
 * 酷我 / 咪咕 / 5sing / 汽水仍留在平台实现里，供搜索、播放、歌词使用。
 *
 * discover.ts 顶层依赖 Vue，node:test 不直接 import。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function registeredPlatformIds() {
  const dir = path.join(ROOT, 'src/api/platforms');
  const rows = readdirSync(dir)
    .filter((name) => name.endsWith('.js') && name !== 'index.js')
    .map((name) => {
      const src = readFileSync(path.join(dir, name), 'utf8');
      const id = src.match(/\bid:\s*'([a-z0-9]+)'/);
      const order = src.match(/policies:\s*\{[^}]*\border:\s*(\d+)/);
      assert.ok(id && order, `${name} 缺少 id 或 policies.order`);
      return { id: id[1], order: Number(order[1]) };
    });
  rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return rows.map((row) => row.id);
}

function discoverSectionPlats() {
  const src = read('src/renderer/app/stores/discover.ts');
  const block = src.match(/export const DISCOVER_SECTIONS[\s\S]*?Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(block, 'discover.ts 应导出 DISCOVER_SECTIONS');
  return [...block[1].matchAll(/plat:\s*'([a-z0-9]+)'/g)].map((m) => m[1]);
}

test('发现页只列出有分区的四家，且这四家都在注册表里', () => {
  const ids = discoverSectionPlats();
  const registered = new Set(registeredPlatformIds());
  assert.deepEqual(ids, ['netease', 'qq', 'bilibili', 'kugou']);
  assert.ok(ids.every((id) => registered.has(id)));
  const src = read('src/renderer/app/stores/discover.ts');
  assert.match(src, /charts\.filter\(\(id\) => known\.has\(id\)\)/);
  assert.doesNotMatch(src, /DISCOVER_PLATFORM_FALLBACK/);
});

test('酷我/咪咕/5sing/汽水没有榜单或歌单实现，发现页不能给它们编分区', () => {
  const chartFns = ['getTopList', 'getRecommendPlaylists', 'getRanking', 'getCategoryPlaylists', 'getNewSongs'];
  for (const file of ['kuwo.js', 'migu.js', 'fivesing.js', 'soda.js']) {
    const src = read(`src/api/platforms/${file}`);
    for (const fn of chartFns) {
      assert.doesNotMatch(src, new RegExp(`\\b${fn}\\s*:`), `${file} 不应声明 ${fn}`);
    }
  }
  const sections = read('src/renderer/app/stores/discover.ts');
  const view = read('src/renderer/app/views/DiscoverView.vue');
  for (const id of ['kuwo', 'migu', 'fivesing', 'soda']) {
    assert.doesNotMatch(sections, new RegExp(`plat:\\s*'${id}'`));
    assert.match(read(`src/api/platforms/${id}.js`), /\bsearch\s*:/);
  }
  assert.doesNotMatch(view, /暂无榜单和歌单/);
  assert.match(read('src/renderer/app/views/SearchView.vue'), /search\.platforms/);
});

test('发现页 tab 只渲染有分区的平台', () => {
  const view = read('src/renderer/app/views/DiscoverView.vue');
  assert.match(view, /v-for="id in discoverPlatformIds"/);
  assert.doesNotMatch(view, /暂无榜单和歌单/);
});
