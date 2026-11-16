/**
 * 目录授权注册表上限（2026-10-13 复审 P2-15）
 *
 * 旧实现只增不删：用户每换一次下载目录，_approved 就多一项，
 * isApprovedDir 的两道闸都随之线性变慢。现在保留最近 64 个，
 * 淘汰只会收窄允许面（fail-closed）。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

const { approve, isApprovedDir, MAX_APPROVED_DIRS } = require('../src/main/approvedDirs');

const base = path.join(os.tmpdir(), `lanyue-approve-bound-${process.pid}`);
const dirOf = (i) => path.join(base, `d${i}`);

test('上限常量是正数，且远小于「一次会话可能选过的目录数」', () => {
  assert.ok(Number.isInteger(MAX_APPROVED_DIRS) && MAX_APPROVED_DIRS > 0);
  assert.ok(MAX_APPROVED_DIRS >= 16, '太小会误伤正常使用');
});

test('超过上限时淘汰最早批准的目录（fail-closed）', () => {
  for (let i = 0; i < MAX_APPROVED_DIRS + 3; i++) approve(dirOf(i));

  assert.strictEqual(isApprovedDir(dirOf(0)), false, '最早 3 个应被淘汰');
  assert.strictEqual(isApprovedDir(dirOf(2)), false);
  assert.strictEqual(isApprovedDir(dirOf(3)), true, '窗口内最旧的仍在');
  assert.strictEqual(isApprovedDir(dirOf(MAX_APPROVED_DIRS + 2)), true, '刚批准的仍在');
});

test('重复批准会刷新到「最近使用」，不会被下一轮淘汰先踢掉', () => {
  const survivor = dirOf(10);
  approve(survivor);                      // 刷新到末尾
  approve(path.join(base, 'new-1'));      // 触发一次淘汰
  assert.strictEqual(isApprovedDir(survivor), true, '刚用过的目录不能被淘汰');
});

test('未批准目录仍然拒绝（限制收窄不等于放宽）', () => {
  assert.strictEqual(isApprovedDir(path.join(base, 'never-approved')), false);
});
