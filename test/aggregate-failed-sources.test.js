/**
 * M1：「全部平台」搜索必须把失败的源报进 failed[]。
 *
 * 缺陷链：gateway.search 的 safeRun 把平台异常吞成 [] → fanOut 的 ok 恒 true
 * → searchMusic('all') 的 failed[] 永远是空 → 渲染层 announceFailed 的
 * 「某源搜索失败」提示从不触发。用户看到的就是「少了几个源的结果」却无任何提示。
 *
 * 本测试加载真实 registry（8 个内置平台），但把每个平台的 search 换成桩：
 * 除 kugou 抛错外其余各返回一首歌。不触网。
 */

const test = require('node:test');
const assert = require('node:assert');

const api = require('../src/api/index.js');

test('searchMusic(all): 某源抛错时 failed 包含该源，其余源结果不受影响', async () => {
  const plugins = api.registry.getAll();
  assert.ok(plugins.length >= 2, 'registry 应加载多个平台');

  const originals = new Map();
  try {
    for (const p of plugins) {
      originals.set(p, p.search);
      if (p.id === 'kugou') {
        p.search = async () => { throw new Error('kugou 接口挂了'); };
      } else {
        p.search = async () => [{
          id: `${p.id}-1`,
          title: '晴天',
          artist: '周杰伦',
          duration: 269000,
          source: p.id,
        }];
      }
    }

    const r = await api.searchMusic('周杰伦', 'all', 1);
    assert.strictEqual(r.error, null);
    assert.ok(Array.isArray(r.failed), 'failed 应为数组');
    assert.ok(r.failed.includes('kugou'), `failed 应包含 kugou，实际: ${JSON.stringify(r.failed)}`);
    for (const p of plugins) {
      if (p.id !== 'kugou') {
        assert.ok(!r.failed.includes(p.id), `${p.id} 成功却出现在 failed 里`);
      }
    }
    assert.ok(r.songs.length > 0, '其余源的歌不应因 kugou 失败而丢失');
  } finally {
    for (const [p, fn] of originals) p.search = fn;
  }
});

test('searchMusic(all): 全部源成功时 failed 为空', async () => {
  const plugins = api.registry.getAll();
  const originals = new Map();
  try {
    for (const p of plugins) {
      originals.set(p, p.search);
      p.search = async () => [{
        id: `${p.id}-1`,
        title: '晴天',
        artist: '周杰伦',
        duration: 269000,
        source: p.id,
      }];
    }
    const r = await api.searchMusic('周杰伦', 'all', 1);
    assert.deepStrictEqual(r.failed, []);
    assert.ok(r.songs.length > 0);
  } finally {
    for (const [p, fn] of originals) p.search = fn;
  }
});