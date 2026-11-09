/**
 * 迁移框架的纯函数钉：utils/dataMigration.js
 *
 * 为什么必须在这一层钉住：
 *   - prefs 的迁移跑在**启动路径**上（prefs._load），一旦抛异常用户就打不开应用；
 *   - 备份的迁移跑在**外部文件**上，脏数据的形状不可穷举。
 *   所以这两条底线（不抛、幂等）只能靠跑纯函数来证明，放到集成测试里既慢
 *   又会被 electron 依赖挡在门外。
 *
 * 另外三件事是"迁移必须真做事"的证据：
 *   - v0 的 eqSettings 对象真的被展开成平铺两键；
 *   - 已经存在的平铺键不被旧对象覆盖（否则用户最新的一次 EQ 调节被历史值吃掉）；
 *   - 非数组的 eqGains 被删掉（否则播放器拿到一条不存在的曲线）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PREF_SCHEMA_VERSION,
  BACKUP_SCHEMA_VERSION,
  migratePrefs,
  migrateBackup,
} = require('../src/utils/dataMigration');

test('常量：prefs 到 v1、备份到 v3（导出/导入两侧共用同一份数字）', () => {
  assert.equal(PREF_SCHEMA_VERSION, 1);
  assert.equal(BACKUP_SCHEMA_VERSION, 3);
});

// ── migratePrefs ───────────────────────────────────────

test('migratePrefs 幂等：同一输入跑两次，data 深相等且第二次不再报迁移', () => {
  const raw = { eqSettings: { preset: 'rock', gains: [1, 2, 3] }, theme: 'dark' };
  const first = migratePrefs(raw);
  const second = migratePrefs(first.data);

  assert.deepEqual(second.data, first.data, '第二次迁移改变了数据 —— 说明某一步不是幂等的');
  assert.deepEqual(second.applied, [], '已是 v1 的文件不该再跑一次 v0->v1');
  assert.equal(second.fromVersion, PREF_SCHEMA_VERSION);
});

test('migratePrefs v0→v1：eqSettings 展开成 eqPreset/eqGains，并盖上新版本号', () => {
  const raw = { eqSettings: { preset: 'rock', gains: [1, 2, 3] } };
  const r = migratePrefs(raw);

  assert.equal(r.fromVersion, 0);
  assert.equal(r.toVersion, PREF_SCHEMA_VERSION);
  assert.equal(r.data.eqPreset, 'rock');
  assert.deepEqual(r.data.eqGains, [1, 2, 3]);
  assert.equal(r.data.prefsVersion, PREF_SCHEMA_VERSION);
  assert.ok(r.applied.length > 0, 'applied 必须如实记下这一步，否则导入报告无从说起');
  assert.ok(r.applied.includes('v0->v1'));
  // 原对象不得被就地改动：迁移的调用方可能还拿着它（prefs._cache）
  assert.deepEqual(raw, { eqSettings: { preset: 'rock', gains: [1, 2, 3] } }, '迁移污染了入参');
});

test('migratePrefs 不覆盖已有平铺键：eqPreset 以用户当前值为准', () => {
  const r = migratePrefs({ eqPreset: 'jazz', eqSettings: { preset: 'rock' } });
  assert.equal(r.data.eqPreset, 'jazz', '旧的 eqSettings 覆盖了更新的 eqPreset');
});

test('migratePrefs 删掉非数组的 eqGains（数字/字符串/对象都不算曲线）', () => {
  for (const bad of ['not-an-array', 42, { 0: 1 }]) {
    const r = migratePrefs({ eqGains: bad, theme: 'neon' });
    assert.ok(!Object.prototype.hasOwnProperty.call(r.data, 'eqGains'),
      `${JSON.stringify(bad)} 被当成有效 EQ 曲线留了下来`);
    assert.equal(r.data.theme, 'neon', '删脏值不该连带删掉别的键');
  }
});

test('migratePrefs 脏入参不抛异常：null/字符串/数组/数字一律给空对象', () => {
  for (const bad of [null, undefined, 'x', [], [1, 2], 42, true]) {
    let r;
    assert.doesNotThrow(() => { r = migratePrefs(bad); }, `${JSON.stringify(bad)} 让迁移抛了`);
    assert.deepEqual(r, { data: {}, fromVersion: 0, toVersion: PREF_SCHEMA_VERSION, applied: [] });
  }
});

test('migratePrefs 空对象不凭空落版本号：没有数据就没有 schema 可升', () => {
  const r = migratePrefs({});
  assert.deepEqual(r.data, {});
  assert.deepEqual(r.applied, []);
});

test('migratePrefs 未来版本号不倒退：报告的 toVersion 不低于 fromVersion', () => {
  const r = migratePrefs({ prefsVersion: 9, theme: 'dark' });
  assert.equal(r.fromVersion, 9);
  assert.ok(r.toVersion >= 9, '报告的目版本低于文件版本 —— 等于谎称做了降级');
  assert.equal(r.data.theme, 'dark', '不认识的版本也必须原样放过用户数据');
  assert.deepEqual(r.applied, []);
});

// ── migrateBackup ──────────────────────────────────────

test('migrateBackup：无 version（v1）/v2/v3 都升到当前版本，data.eqPreset 原样保留', () => {
  const cases = [
    { label: '无 version（v1）', input: { app: 'music-downloader', data: { eqPreset: 'rock', eqGains: [1, 2], userPlaylists: [] } } },
    { label: 'v2', input: { version: 2, app: 'music-downloader', data: { eqPreset: 'rock', eqGains: [1, 2], userPlaylists: [], prefs: { theme: 'dark' } } } },
    { label: 'v3', input: { version: 3, app: 'music-downloader', data: { eqPreset: 'rock', eqGains: [1, 2], userPlaylists: [], prefs: { theme: 'dark' } } } },
  ];

  for (const { label, input } of cases) {
    const r = migrateBackup(input);
    assert.equal(r.skipped, false, `${label}: 合法备份被拒`);
    assert.equal(r.toVersion, BACKUP_SCHEMA_VERSION, `${label}: 没升到当前版本`);
    assert.equal(r.payload.version, BACKUP_SCHEMA_VERSION, `${label}: payload.version 没跟着写`);
    assert.equal(r.payload.data.eqPreset, 'rock', `${label}: legacy 读面要的 data.eqPreset 被删了`);
    assert.deepEqual(r.payload.data.eqGains, [1, 2], `${label}: legacy 读面要的 data.eqGains 被删了`);
    assert.equal(r.payload.app, 'music-downloader');
  }
});

test('migrateBackup v1→v2：顶层 EQ 复制进 data.prefs，源键一个不删', () => {
  const r = migrateBackup({ app: 'music-downloader', data: { eqPreset: 'rock', eqGains: [3, 0] } });
  assert.ok(r.applied.includes('v1->v2'));
  assert.equal(r.payload.data.prefs.eqPreset, 'rock');
  assert.deepEqual(r.payload.data.prefs.eqGains, [3, 0]);
  assert.equal(r.payload.data.eqPreset, 'rock', 'legacy 分支还要读顶层，不能搬完就删');
});

test('migrateBackup v2→v3：非法形状被钉正，合法数据一个字节都不动', () => {
  const input = {
    version: 2,
    app: 'music-downloader',
    data: {
      prefs: 'not-an-object',
      userPlaylists: 'oops',
      downloadTemplates: { a: 1 },
      downloadHistory: [{ id: 'x' }],
    },
  };
  const r = migrateBackup(input);
  assert.ok(r.applied.includes('v2->v3'));
  assert.deepEqual(r.payload.data.prefs, {}, '非对象的 prefs 必须换成空对象');
  assert.ok(!('userPlaylists' in r.payload.data), '非数组的歌单必须删掉，而不是伪装成空列表');
  assert.ok(!('downloadTemplates' in r.payload.data));
  assert.deepEqual(r.payload.data.downloadHistory, [{ id: 'x' }], '不认识的字段一律不许动');
  // 入参不得被就地改写（cloudSync 手里还拿着 JSON.parse 的那份）
  assert.equal(input.data.prefs, 'not-an-object');
});

test('migrateBackup 幂等：升过一次的备份再跑一遍，数据不变', () => {
  const once = migrateBackup({ app: 'music-downloader', data: { eqSettings: { preset: 'pop', gains: [1] } } });
  const twice = migrateBackup(once.payload);
  assert.deepEqual(twice.applied, [], '当前版本的备份不该再触发迁移');
  assert.deepEqual(twice.payload, once.payload);
});

test('migrateBackup v2→v3：prefs 里的 v0 形状照样被展开，但版本号不进备份', () => {
  const r = migrateBackup({
    version: 2,
    app: 'music-downloader',
    data: { prefs: { eqSettings: { preset: 'vocal', gains: [2, 2] } } },
  });
  assert.equal(r.payload.data.prefs.eqPreset, 'vocal');
  assert.deepEqual(r.payload.data.prefs.eqGains, [2, 2]);
  assert.ok(!('prefsVersion' in r.payload.data.prefs), 'prefs.json 的文件级标记泄漏进备份了');
});

test('migrateBackup version:99（未来版本）→ skipped，且原数据一动没动', () => {
  const future = { version: 99, app: 'music-downloader', data: { someNewField: { deep: [1, 2] } } };
  let r;
  assert.doesNotThrow(() => { r = migrateBackup(future); }, '未来版本的备份让导入崩了');
  assert.equal(r.skipped, true);
  assert.deepEqual(r.payload, future, '未来的备份不许被这一版改写');
  assert.deepEqual(r.applied, []);
});

test('migrateBackup 脏入参不崩：null/字符串/数组/数字都给空 payload', () => {
  for (const bad of [null, undefined, 'x', [], 42, true]) {
    let r;
    assert.doesNotThrow(() => { r = migrateBackup(bad); }, `${JSON.stringify(bad)} 让 migrateBackup 抛了`);
    assert.equal(r.skipped, false);
    assert.deepEqual(r.payload, {}, '脏入参交给调用方去报"文件格式无效"，而不是在这里抛 TypeError');
    assert.equal(r.toVersion, BACKUP_SCHEMA_VERSION);
  }
});

test('migrateBackup 未来版本与脏入参组合：确认版本判定先于形状修补', () => {
  const r = migrateBackup({ version: '99', data: null, app: 'music-downloader' });
  assert.equal(r.skipped, true, '字符串形式的版本号也要认出来');
  assert.deepEqual(r.payload, { version: '99', data: null, app: 'music-downloader' });
});

// ── 接线：prefs.js 真的在加载时迁移并立即落盘 ─────────────
// 纯函数再正确，如果 _load 不调它、或者调了却不落盘，用户重启后读到的还是老文件。
// 这条用例走真的磁盘：写一份 v0 的 prefs.json，require 一次 prefs，再看盘上那份。

test('接线：prefs 加载老文件时展开 EQ 并立即落盘（不依赖 300ms 防抖）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicdl-migrate-'));
  const file = path.join(dir, 'prefs.json');
  fs.writeFileSync(file, JSON.stringify({
    eqSettings: { preset: 'rock', gains: [1, 2, 3] },
    theme: 'dark',
  }), 'utf8');

  const prefs = require('../src/utils/prefs');
  prefs.init(dir);
  try {
    assert.strictEqual(prefs.get('eqPreset'), 'rock', '老文件的 eqSettings 没被展开');
    assert.deepEqual(prefs.get('eqGains'), [1, 2, 3]);
    assert.strictEqual(prefs.get('theme'), 'dark', '迁移弄丢了别的键');

    // 立即读盘：此刻还没到防抖窗口，写不进去就说明迁移只活在内存里
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(onDisk.prefsVersion, PREF_SCHEMA_VERSION, '迁移结果没有落盘');
    assert.strictEqual(onDisk.eqPreset, 'rock');
    assert.deepEqual(onDisk.eqGains, [1, 2, 3]);
  } finally {
    prefs.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});