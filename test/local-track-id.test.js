/**
 * 本地曲目 id 去路径化（SECURITY.md §5 出站缺口）
 *
 * 本地歌的 id 曾等于绝对路径：outboundScrub 的键名闸剥得掉 filePath 键，
 * 却剥不掉 id 值里的路径。本模块把本地 id 换成路径的 SHA-1 前 16 位
 * （'l' 前缀），并提供持久化数据的幂等迁移。
 *
 * 判据：
 *   - 纯 JS SHA-1 与 node:crypto 逐字节一致（渲染层没有 node:crypto）
 *   - id 不含路径残片、确定性、满足 syncMerge 的 SAFE_ID_RE
 *   - 迁移只动 source=local 且 id 呈路径形的条目；幂等、不改入参
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

async function loadMod() {
  return import('../src/shared/localTrackId.mjs?ck=' + Math.random());
}

const nodeSha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

test('sha1Hex：已知向量（空串 / abc / fox）', async () => {
  const { sha1Hex } = await loadMod();
  assert.strictEqual(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.strictEqual(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.strictEqual(sha1Hex('The quick brown fox jumps over the lazy dog'),
    '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12');
});

test('sha1Hex：与 node:crypto 交叉验证（中文 / 空格 / UNC / 长路径 / 边界长度）', async () => {
  const { sha1Hex } = await loadMod();
  const samples = [
    'C:\\Users\\admin\\Music\\周杰伦 - 晴天.mp3',
    'D:/music/hello world.flac',
    '\\\\NAS\\share\\只歌.m4a',
    '/home/user/音乐/曲目 (1).opus',
    'E:\\' + '深'.repeat(300) + '\\a.mp3',
    'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65),
    '🎵 emoji path.mp3',
  ];
  for (const s of samples) {
    assert.strictEqual(sha1Hex(s), nodeSha1(s), '样本: ' + s.slice(0, 40));
  }
});

test('localTrackId：l 前缀 + 16 位 hex，确定性，不含路径残片', async () => {
  const { localTrackId } = await loadMod();
  const p = 'C:\\Users\\admin\\Music\\晴天.mp3';
  const id = localTrackId(p);
  assert.match(id, /^l[0-9a-f]{16}$/);
  assert.strictEqual(id, localTrackId(p), '同路径必须同 id');
  assert.strictEqual(id, 'l' + nodeSha1(p).slice(0, 16), '与 node:crypto 同源');
  assert.notStrictEqual(id, localTrackId('C:\\Users\\admin\\Music\\晴天2.mp3'));
  assert.ok(!id.includes(p) && !/[\\/:]/.test(id), 'id 里不许有路径残片');
  assert.ok(!id.includes('admin') && !id.includes('Music'));
});

test('localTrackId：满足 syncMerge 的 SAFE_ID_RE（外来快照修复闸不误伤）', async () => {
  const { localTrackId } = await loadMod();
  const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  for (const p of ['C:\\a.mp3', '/x/y.flac', '\\\\nas\\z.opus', '相对路径.m4a']) {
    assert.ok(SAFE_ID_RE.test(localTrackId(p)), p);
  }
});

test('migrateLocalSong：路径形 id 换成 filePath 的哈希，其余字段原样', async () => {
  const { migrateLocalSong, localTrackId } = await loadMod();
  const song = { source: 'local', id: 'C:\\m\\a.mp3', filePath: 'C:\\m\\a.mp3', title: 'A', addedAt: 7 };
  const m = migrateLocalSong(song);
  assert.strictEqual(m.id, localTrackId('C:\\m\\a.mp3'));
  assert.strictEqual(m.filePath, 'C:\\m\\a.mp3', 'filePath 保留（播放只读它）');
  assert.strictEqual(m.title, 'A');
  assert.strictEqual(m.addedAt, 7);
  assert.strictEqual(song.id, 'C:\\m\\a.mp3', '不改入参');
});

test('migrateLocalSong：relink 过的行（id=旧路径 ≠ filePath）按当前 filePath 收敛', async () => {
  const { migrateLocalSong, localTrackId } = await loadMod();
  const m = migrateLocalSong({ source: 'local', id: 'D:\\old.mp3', filePath: 'D:\\new.mp3' });
  assert.strictEqual(m.id, localTrackId('D:\\new.mp3'));
});

test('migrateLocalSong：幂等 + 边界（已迁移 / 在线行 / 缺 filePath / 脏数据）', async () => {
  const { migrateLocalSong, localTrackId } = await loadMod();
  const done = { source: 'local', id: localTrackId('C:\\m\\a.mp3'), filePath: 'C:\\m\\a.mp3' };
  assert.strictEqual(migrateLocalSong(done), done, '已迁移的行原引用返回');
  const online = { source: 'netease', id: 'D:/looks/like/path.mp3', filePath: 'x' };
  assert.strictEqual(migrateLocalSong(online), online, '在线行即使 id 像路径也不动');
  const noPath = { source: 'local', id: 'C:\\m\\a.mp3' };
  assert.strictEqual(migrateLocalSong(noPath), noPath, '缺 filePath 无从派生，保持原样');
  const numeric = { source: 'local', id: 3, filePath: 'C:\\m\\a.mp3' };
  assert.strictEqual(migrateLocalSong(numeric), numeric, '数字 id 不是路径形，不动');
  assert.strictEqual(migrateLocalSong(null), null);
  assert.strictEqual(migrateLocalSong('x'), 'x');
});

test('migrateLocalSongIds：跨歌单迁移、幂等、不改入参、在线歌与歌单元数据原样', async () => {
  const { migrateLocalSongIds, localTrackId } = await loadMod();
  const pls = [
    { id: 'favorites', name: '收藏', updatedAt: 1, songs: [
      { source: 'local', id: 'C:\\m\\a.mp3', filePath: 'C:\\m\\a.mp3', title: 'A' },
      { source: 'netease', id: '42', title: 'N' },
    ] },
    { id: 'p2', songs: [{ source: 'local', id: 'D:/x.flac', filePath: 'D:/x.flac' }] },
    { id: 'p3', songs: [] },
    null,
  ];
  const before = JSON.stringify(pls);
  const r1 = migrateLocalSongIds(pls);
  assert.strictEqual(r1.changed, true);
  assert.strictEqual(r1.playlists[0].songs[0].id, localTrackId('C:\\m\\a.mp3'));
  assert.strictEqual(r1.playlists[0].songs[1].id, '42');
  assert.strictEqual(r1.playlists[0].name, '收藏');
  assert.strictEqual(r1.playlists[0].updatedAt, 1);
  assert.strictEqual(r1.playlists[1].songs[0].id, localTrackId('D:/x.flac'));
  assert.strictEqual(JSON.stringify(pls), before, '入参不被修改');

  const r2 = migrateLocalSongIds(r1.playlists);
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(r2.playlists, r1.playlists, '幂等：无变化时原引用返回');
});

test('migrateLocalSongIds：脏输入安全（非数组 / 缺 songs / 非对象条目）', async () => {
  const { migrateLocalSongIds } = await loadMod();
  assert.deepStrictEqual(migrateLocalSongIds(null), { playlists: null, changed: false });
  assert.deepStrictEqual(migrateLocalSongIds('x'), { playlists: 'x', changed: false });
  const r = migrateLocalSongIds([{ id: 'p' }, { id: 'q', songs: [null, 'bad', 3] }]);
  assert.strictEqual(r.changed, false);
});