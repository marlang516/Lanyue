/**
 * 契约测试：网易 SDK 换装 @neteasecloudmusicapienhanced/api（ADR-20261017-01 方案 C）
 *
 * 为什么需要这份钉：2026-10-18 发生过「依赖先到、代码后到」的中间态 ——
 * enhanced 包被提前加进 package.json 但全仓零引用，audit:deps 必红，
 * 卡住 v1.0.37 发版闸，最后整包撤回。本文件把「换装必须原子完成」固化成
 * 机器判据：依赖声明、lock、唯一消费面、vite external、真实导出五处
 * 任何一处停在中间态，这里就红。
 *
 * 换装依据（2026-11-12 实测）：
 *   - 10 个被消费的方法模块与老包逐字节一致（diff=0），签名契约不变；
 *   - main.js 头部与末尾的 server 加载形态不变（express 仍在运行时，
 *     但已升 5.x，express/body-parser/path-to-regexp 的旧 advisory 消失）；
 *   - 上游 2024-01 因网易法务函删库停更，老包 4.32.0 是 registry 最后一版。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NEW_SDK = '@neteasecloudmusicapienhanced/api';
const OLD_SDK = 'NeteaseCloudMusicApi';

/** 本项目消费的全部 SDK 方法（与 test/netease.test.js 白名单同源） */
const SDK_METHODS = [
  'search', 'song_url', 'song_detail', 'lyric', 'login_status',
  'playlist_detail', 'personalized', 'artists', 'artist_album', 'album',
];

function collectJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('package.json：依赖只留增强包，老包必须移除（双包并存 = 老漏洞树还在）', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies[NEW_SDK], `dependencies 未声明 ${NEW_SDK}`);
  assert.ok(!pkg.dependencies[OLD_SDK],
    `dependencies 仍有 ${OLD_SDK} —— 换装不是加包，老包必须整棵移出依赖树`);
});

test('package-lock.json：老包节点消失、增强包节点就位（lock 与声明同步）', () => {
  const lock = JSON.parse(read('package-lock.json'));
  const keys = Object.keys(lock.packages || {});
  const oldNodes = keys.filter((k) => k.split('node_modules/').pop() === OLD_SDK);
  assert.deepStrictEqual(oldNodes, [], 'lock 里仍有老包节点：' + oldNodes.join(', '));
  assert.ok(keys.some((k) => k.split('node_modules/').pop() === NEW_SDK),
    'lock 里没有增强包节点 —— npm install 未与声明同步');
});

test('消费面：src/ 里 require 增强包的唯一文件是 netease.js，老包名零引用', () => {
  const files = collectJs(path.join(ROOT, 'src')).map((abs) => ({
    rel: path.relative(ROOT, abs).split(path.sep).join('/'),
    src: fs.readFileSync(abs, 'utf8'),
  }));
  const newConsumers = files
    .filter((f) => f.src.includes(`require('${NEW_SDK}')`) || f.src.includes(`require("${NEW_SDK}")`))
    .map((f) => f.rel);
  assert.deepStrictEqual(newConsumers, ['src/api/platforms/netease.js'],
    '消费面必须唯一（ADR 方案 C 的前提）：' + JSON.stringify(newConsumers));
  const oldConsumers = files
    .filter((f) => f.src.includes(`require('${OLD_SDK}')`) || f.src.includes(`require("${OLD_SDK}")`))
    .map((f) => f.rel);
  assert.deepStrictEqual(oldConsumers, [], '仍有文件 require 老包：' + oldConsumers.join(', '));
});

test('vite.config.mjs：external 名单换成增强包（主进程 bundle 不得吞掉 SDK 树）', () => {
  const vite = read('vite.config.mjs');
  assert.ok(vite.includes(`'${NEW_SDK}'`), 'external 未包含增强包');
  assert.ok(!vite.includes(`'${OLD_SDK}'`), 'external 仍列着老包名');
});

test('增强包真实导出：10 个被消费方法全部存在且为函数（不触网，只 require）', () => {
  const ncm = require(NEW_SDK);
  for (const m of SDK_METHODS) {
    assert.strictEqual(typeof ncm[m], 'function', `增强包缺少方法 ${m} —— 消费面契约被破坏`);
  }
});

// ── 豁免清单重写（ADR 方案 C 第 4 步）─────────────────────────
// 2026-11-12 换装后实测（运行时插桩 + npm audit，非干净环境推算）：
//   - 增强包自身加载 express 5.3.0 / body-parser 2.4.0 / path-to-regexp 8.4.2，
//     这三个版本无 advisory；
//   - audit 仍报 express/body-parser/path-to-regexp high，毒源是两条**从不被
//     加载**的 express 4 链：qq-music-api 声明的 4.16.4（入口 node/index.js
//     插桩零命中）与 unblockmusic-utils 的 4.22.3（只在增强包 server.js 的
//     路由回调里 require，server 从未启动）—— 分组保留，理由按新事实重写；
//   - node-forge 1.4.0 → override 升 1.4.3（同大版本 patch，advisory 消失）；
//   - 剩 4 项 high：增强包根 + basic-ftp/get-uri/pac-proxy-agent 链（PAC 分支
//     仅在用户配置 PAC 代理时实例化，本项目未走）。

test('豁免清单：四个分组保留，server_never_launched 组理由换成换装后的新事实', () => {
  const raw = JSON.parse(read('scripts/audit-allowlist.json'));
  const groups = Object.keys(raw).filter((k) => !k.startsWith('_')).sort();
  assert.deepStrictEqual(groups, [
    'unreachable_but_packaged',
    'unreachable_excluded',
    'upstream_locked',
    'upstream_locked_server_never_launched',
  ]);
  const g = raw.upstream_locked_server_never_launched;
  assert.deepStrictEqual([...g.packages].sort(), ['body-parser', 'express', 'path-to-regexp']);
  assert.match(g._why, /qq-music-api/, '理由必须指明 qq 侧 express 4 毒源（插桩零加载）');
  assert.match(g._why, /unblockmusic-utils/, '理由必须指明 unblock 链只在从未启动的 server 路由里');
  assert.match(g._why, /机器判据|audit-attack-surface/, '机器复核挂钩不得丢');
});

test('豁免清单：upstream_locked 换成增强包根 + PAC 代理链，老包名零残留', () => {
  const raw = JSON.parse(read('scripts/audit-allowlist.json'));
  const locked = raw.upstream_locked.packages;
  for (const p of [NEW_SDK, 'basic-ftp', 'get-uri', 'pac-proxy-agent']) {
    assert.ok(locked.includes(p), `upstream_locked 缺 ${p}（换装后实测仍 high）`);
  }
  assert.ok(!locked.includes(OLD_SDK), '老包名仍在豁免清单');
  assert.ok(!locked.includes('node-forge'), 'node-forge 已 override 到 1.4.3，留着会被 stale 判据红');
  const all = JSON.stringify(raw);
  assert.ok(!all.includes(OLD_SDK), '清单任何角落都不许再出现老包名');
});

test('node-forge override：升到 1.4.3（同大版本 patch，advisory 修复版）', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.overrides['node-forge'] || '', /1\.4\.3/,
    'node-forge 1.4.0 有 high advisory，1.4.3 已修 —— 能升就升，不进豁免清单');
});

// ── 活跃度门禁（ADR 方案 C 核实清单第 3 条）───────────────────
// 老包之死（2024-01 法务函 → 删库）是无声的：npm 上版本号永远停在最后一版，
// 只有「最近发布时间」能暴露停更。门禁是 warn 不是 block（停更不等于有漏洞），
// 且必须触网查 registry —— 所以挂 CI 独立步骤，绝不进离线的 verify 链。

test('活跃度门禁：脚本存在、纯函数导出、warn 阈值判据可测', () => {
  const gatePath = path.join(ROOT, 'scripts', 'check-sdk-activity.cjs');
  assert.ok(fs.existsSync(gatePath), '缺 scripts/check-sdk-activity.cjs');
  const gate = require(gatePath);
  assert.strictEqual(typeof gate.evaluate, 'function', '判据必须以纯函数导出供测试');
  const DAY = 86400000;
  const now = Date.UTC(2026, 10, 12);
  // 5 个月前发布 → 放行；7 个月前发布 → warn（阈值 6 个月）
  assert.deepStrictEqual(
    gate.evaluate({ pkg: NEW_SDK, modified: new Date(now - 150 * DAY).toISOString(), now, maxAgeDays: 180 }),
    { stale: false, ageDays: 150 });
  const old = gate.evaluate({ pkg: NEW_SDK, modified: new Date(now - 210 * DAY).toISOString(), now, maxAgeDays: 180 });
  assert.strictEqual(old.stale, true);
  assert.strictEqual(old.ageDays, 210);
});

test('活跃度门禁：CI 挂独立 warn 步骤，verify 链保持离线（不得串进去）', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['check:sdk-activity'] || '', /check-sdk-activity\.cjs/);
  assert.doesNotMatch(pkg.scripts.verify, /sdk-activity/, '触网检查混进离线 verify 链');
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /check:sdk-activity/, 'CI 未挂活跃度门禁');
});