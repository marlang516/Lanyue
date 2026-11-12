/**
 * SDK 活跃度门禁测试 —— scripts/check-sdk-activity.cjs
 *
 * 为什么要有这道闸（ADR-20261017-01 方案 C 核实清单第 3 条）：
 * 老包 NeteaseCloudMusicApi 之死是无声的 —— 2024-01 网易法务函后上游删库，
 * npm 上版本号永远停在 4.32.0，`npm outdated` 永远不会报它。只有「最近一次
 * 发布时间」能暴露停更。门禁对超过阈值（180 天）的 SDK 发 warn：
 *   - 是 warn 不是 block：停更不等于有漏洞，阻断发版没有依据；
 *   - 必须触网查 registry：所以挂 CI 独立步骤，绝不进离线的 verify 链
 *     （test/verify-chain.test.js 守着那条分工）；
 *   - 查不到（网络/registry 故障）也放行：与 audit 步骤同口径，
 *     基础设施失败不该红掉与代码质量无关的 job。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { evaluate, MAX_AGE_DAYS } = require('../scripts/check-sdk-activity.cjs');

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 12);
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

test('阈值语义：恰好 180 天不算停更，181 天才 warn（边界不漂移）', () => {
  assert.strictEqual(MAX_AGE_DAYS, 180, '阈值改动必须同步 ADR 与 SECURITY.md');
  assert.deepStrictEqual(
    evaluate({ pkg: 'x', modified: at(180), now: NOW, maxAgeDays: 180 }),
    { stale: false, ageDays: 180 });
  assert.deepStrictEqual(
    evaluate({ pkg: 'x', modified: at(181), now: NOW, maxAgeDays: 180 }),
    { stale: true, ageDays: 181 });
});

test('时钟偏差防护：发布时间在未来（registry 时钟漂移）不得误报停更', () => {
  const r = evaluate({ pkg: 'x', modified: at(-3), now: NOW, maxAgeDays: 180 });
  assert.strictEqual(r.stale, false);
  assert.ok(r.ageDays <= 0);
});

test('脚本纪律：warn-only —— 任何分支都不许交出非 0 退出码', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'check-sdk-activity.cjs'), 'utf8');
  assert.match(src, /if \(require\.main === module\) process\.exit\(main\(\)\);/,
    '退出码只能在被当脚本跑时交出（与 audit-gate 同律）');
  assert.ok(!/process\.exit\(1\)/.test(src), '活跃度门禁是 warn，不是 block');
  assert.match(src, /::warning::/, '停更必须产出 CI 可见的 warning 注解');
});

test('CI 与发版流水线都挂了活跃度检查（两处口径一致）', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const rel = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  assert.match(ci, /check:sdk-activity/);
  assert.match(rel, /check:sdk-activity/);
});