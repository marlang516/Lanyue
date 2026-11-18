/**
 * 发现页平台条：必须覆盖注册表里的全部音源，不能再停在原先四家。
 *
 * discover.ts 顶层依赖 Vue，node:test 不直接 import。
 * 这里把回落清单和平台 manifest 的 policies.order 对上，
 * 并钉住 DiscoverView 用这份清单渲染 tab、窄宽度下换行。
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

function fallbackIds() {
  const src = read('src/renderer/app/stores/discover.ts');
  const block = src.match(/export const DISCOVER_PLATFORM_FALLBACK[\s\S]*?Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'discover.ts 应导出 DISCOVER_PLATFORM_FALLBACK');
  return [...block[1].matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);
}

test('发现页平台条回落清单与已注册音源一致，且正好八家', () => {
  const ids = fallbackIds();
  assert.deepEqual(ids, registeredPlatformIds());
  assert.deepEqual(ids, [
    'netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'migu', 'fivesing', 'soda',
  ]);
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
  for (const id of ['kuwo', 'migu', 'fivesing', 'soda']) {
    assert.doesNotMatch(sections, new RegExp(`plat:\\s*'${id}'`));
  }
});

test('发现页 tab 走 discoverPlatformIds，不再只遍历有分区的四家', () => {
  const view = read('src/renderer/app/views/DiscoverView.vue');
  assert.match(view, /v-for="id in discoverPlatformIds"/);
  assert.doesNotMatch(view, /v-for="p in DISCOVER_SECTIONS"/);
  assert.match(view, /flex-wrap:\s*wrap/);
  assert.match(view, /max-width:\s*100%/);
});
