/**
 * 目录授权注册表（C1 下载目录沙箱的统一底座）
 *
 * 背景：渲染层能把任意路径字符串送进多条 IPC 通道（add-to-queue 的 saveDir、
 * check-local-exists、scan-local-library…）。文件名有 sanitize，目录没有 ——
 * 渲染层一旦被恶意歌单/歌词数据 XSS，即可把文件写到任意目录。
 *
 * 规则：只有**经过主进程原生目录选择器（select-dir）确认**的路径（含其子目录）
 * 算「用户批准过」。应用启动时把 prefs 里已存的各目录键 seed 进集合
 * （它们是历史会话里选器确认的结果），此后 set-pref 写入目录键必须先过
 * isApprovedDir，攻击者无法在运行时凭空注入新目录。
 *
 * ── 2026-09 审计 P1 加固：词法判定 + 真实路径复核 ──────────
 *
 * 旧实现只做词法判定（path.resolve + path.relative），这挡得住
 * `C:\MusicX` 冒充 `C:\Music`（前缀碰撞），但挡不住**符号链接**：
 * 批准目录内的 `D:\Music\link` 一旦指向 `C:\Windows\System32`，
 * 字符串 `D:\Music\link\evil.dll` 依然"在批准目录内"，而真实写入落在
 * System32 —— 沙箱等于交给链接持有者。
 *
 * 现在两道闸：
 *   1. 词法快筛：不在任何批准目录字符串前缀下的路径直接否（零系统调用）；
 *   2. 真实路径复核：对通过快筛的路径取 realpath（不存在则回退到最近的
 *      已存在祖先再拼回剩余段），要求真实路径仍落在某个批准目录的
 *      **真实路径**之内。
 *
 * 残留风险：校验与使用之间仍存在 TOCTOU 窗口（校验后把目录换成链接）。
 * 要彻底关闭需要在打开文件时用句柄校验，属另一量级改造；本层已把
 * 「静态链接即绕过」这条最省力的路径封死。
 *
 * ── 2026-11 下沉：判据移到 utils/realpathContain.js ────────
 *
 * 上述两道闸的实现（normalize / isInside / realpathDeep / isInsideReal /
 * isInsideRealAny 等）原本住在本文件，但 utils/downloadPath.js 需要复用
 * 同一条判据，形成了 utils → main 的反向依赖。判据只依赖 node 内置模块，
 * 已整体下沉到 src/utils/realpathContain.js；本文件只保留注册表语义
 * （_approved / approve / isApprovedDir）并 re-export 同名函数，对外行为不变。
 * 真实路径判据的全仓唯一实现在 utils 侧，依赖方向保持 main → utils 单向。
 */
const { isInside, isInsideReal, isInsideRealAny, realpathDeep, normalize } = require('../utils/realpathContain');

/** 目录型偏好键：值必须通过 isApprovedDir 校验后才允许写入 */
const DIR_PREF_KEYS = new Set(['saveDir', 'localDirPath', 'aiMusicSaveDir', 'convertOutputDir']);

const _approved = new Set();

function approve(p) {
  const r = normalize(p);
  if (r) _approved.add(r);
  return r;
}

/** p 等于某批准目录或其子目录（词法快筛 + 真实路径复核） */
function isApprovedDir(p) {
  const r = normalize(p);
  if (!r) return false;
  // 闸 1：词法快筛。不在任何批准目录下 → 直接否，不做系统调用。
  //
  // 这一闸也让判定**单向**：用户批准的是哪个字符串，就只认那个字符串下的路径。
  // 若用户选中的本身是链接（D:\Music\alias → E:\RealMusic），则
  // alias\a.mp3 放行、而 E:\RealMusic\a.mp3 不放行 —— 应用内所有路径
  // 都源自用户给出的那一形态（扫描结果、下载落盘、历史记录一致），
  // 故这是「更严格但不误伤」的选择，代价只是不接受另一种等价写法。
  let lexHit = false;
  for (const a of _approved) {
    if (isInside(a, r)) { lexHit = true; break; }
  }
  if (!lexHit) return false;
  // 闸 2：真实路径复核。批准目录内的符号链接可能指向外部。
  return isInsideRealAny(_approved, r);
}

module.exports = {
  approve,
  isApprovedDir,
  isInside,
  isInsideReal,
  isInsideRealAny,
  realpathDeep,
  normalize,
  DIR_PREF_KEYS,
};