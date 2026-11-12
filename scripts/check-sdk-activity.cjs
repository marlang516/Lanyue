#!/usr/bin/env node
/**
 * SDK 活跃度门禁 —— 停更超过阈值发 warn，不阻断（ADR-20261017-01 方案 C）
 *
 * 为什么需要它：老包 NeteaseCloudMusicApi 之死是无声的 —— 2024-01 网易
 * 法务函后上游删库停更，npm 上版本号永远停在最后一版，`npm outdated`
 * 永远不会报它，audit 也只管漏洞不管维护状态。只有「最近一次发布时间」
 * 能暴露停更，让下一个「_binaryify 式死亡」在 CI 里发出声音。
 *
 * 三条纪律
 * --------
 * 1. warn-only：停更不等于有漏洞，任何分支都退出码 0。真出了安全事件
 *    由 audit-gate 的漏洞判据红灯，不由本脚本越权。
 * 2. 触网检查不进 verify 链：verify 必须离线可复现（test/verify-chain.test.js
 *    守着），本脚本只挂 CI / release 的独立步骤。
 * 3. 查不到也放行：registry 故障/限流时输出 warning 说明本次未核验，
 *    与 ci.yml 的 audit 步骤同口径 —— 基础设施失败不该红掉无关的 job。
 *
 * 用法：node scripts/check-sdk-activity.cjs
 * 退出码：恒 0（warn 通过 ::warning:: 注解呈现）
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SDK = '@neteasecloudmusicapienhanced/api';
/** 停更 warn 阈值：最近一次 npm 发布距今超过 180 天 */
const MAX_AGE_DAYS = 180;
const DAY = 86400000;
// Windows 上 npm 是 npm.cmd，必须经由 shell（与 audit-gate.cjs 同一坑）
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * 停更判据（纯函数，测试从这里进）。
 * @param {{pkg:string, modified:string, now:number, maxAgeDays:number}} cfg
 * @returns {{stale:boolean, ageDays:number}}
 */
function evaluate({ modified, now, maxAgeDays }) {
  const ageDays = Math.floor((now - Date.parse(modified)) / DAY);
  return { stale: ageDays > maxAgeDays, ageDays };
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!pkg.dependencies || !pkg.dependencies[SDK]) {
    console.warn(`::warning::package.json 未声明 ${SDK} —— 活跃度门禁失去对象，请核对换装状态`);
    return 0;
  }
  let modified;
  try {
    const out = execSync(
      `${NPM} view ${SDK} time.modified --json --registry=https://registry.npmjs.org`,
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    modified = JSON.parse(out.replace(/^\uFEFF+/, ''));
  } catch (e) {
    console.warn(`::warning::SDK 活跃度本次未核验（registry 查询失败：${e.message.split('\n')[0]}）——不阻断，请在网络恢复后复跑`);
    return 0;
  }
  if (typeof modified !== 'string' || Number.isNaN(Date.parse(modified))) {
    console.warn('::warning::SDK 活跃度本次未核验（registry 返回的 time.modified 不可解析）——不阻断');
    return 0;
  }
  const { stale, ageDays } = evaluate({ pkg: SDK, modified, now: Date.now(), maxAgeDays: MAX_AGE_DAYS });
  if (stale) {
    console.warn(`::warning::${SDK} 已 ${ageDays} 天未发布新版本（阈值 ${MAX_AGE_DAYS} 天）——上游可能停更，按 ADR-20261017-01 重评方案 B/C/D`);
  } else {
    console.log(`✓ ${SDK} 最近发布于 ${ageDays} 天前（${modified}），活跃度正常（阈值 ${MAX_AGE_DAYS} 天）`);
  }
  return 0;
}

module.exports = { evaluate, main, MAX_AGE_DAYS, SDK };
// 退出码只在被当脚本跑时交出（与 audit-gate / audit-attack-surface 同律）
if (require.main === module) process.exit(main());