/**
 * 真实路径包含判据（从 src/main/approvedDirs.js 下沉）
 *
 * 为什么在这里：`utils/downloadPath.js` 曾直接 require `../main/approvedDirs`，
 * 只为了复用 `isInsideReal` 这一条判据。依赖图上形成 utils → main 的反向边，
 * 纯函数单测虽然能跑，但层次关系是错的。判据本身只依赖 path / fs 两个
 * node 内置模块（不含任何项目文件、不拖 electron / prefs），所以下沉到 utils
 * 之后依赖方向恢复单向：main → utils，utils 侧仍是叶子。
 *
 * approvedDirs 保留 `isApprovedDir` / `approve` 等注册表语义，从本模块 re-export
 * 下列函数，对外 8 个导出的名字与行为不变。
 *
 * ── 原始设计说明（2026-09 审计 P1 加固）────────────────────
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
 */
const path = require('path');
const fs = require('fs');

function normalize(p) {
  if (!p || typeof p !== 'string') return null;
  try { return path.resolve(p); } catch (_e) { return null; }
}

/** base 是否包含 target（相等算包含）；path.relative 判定，防前缀碰撞 */
function isInside(base, target) {
  try {
    const rel = path.relative(base, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch (_e) { return false; }
}

/**
 * 只有「这一级确实不存在」才允许向上回退。
 *
 * 回退的语义是「拼出尚未创建的目标的真实父目录」，前提是失败原因**只有**
 * 不存在一种。若把权限不足、循环链接、乃至某些环境上对 reparse point 的
 * stat 直接失败（实测 Windows 上对 junction 的 realpathSync 会抛
 * UNKNOWN/-4094）也当成「不存在」，回退就会拿**祖先的真实路径冒充目标**：
 * `D:\Music\link\evil.dll` 里的 link 明明指向沙箱外，回退后算出的却是
 * `D:\Music\link\evil.dll` 本身 —— 判定为「在沙箱内」，第二道闸形同虚设。
 *
 * 所以：ENOENT / ENOTDIR 之外的错误一律向上抛，由 isInsideReal /
 * isInsideRealAny 的 catch 转成「判否」（fail-closed）。
 */
function _isMissing(e) {
  return !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
}

/**
 * realpathSync 失败、且失败原因不是「不存在」时的补救：手动解析路径上的链接段。
 *
 * 为什么需要（实测 2026-10-13）：某些 Windows 环境（含本机）对 junction 的
 * `stat` / `realpathSync` 一律返回 `UNKNOWN(-4094)`，而 `readlinkSync` 正常。
 * 此时若一律 fail-closed，用户「把下载目录本身选成一个 junction」就会全程
 * 不可用；若像旧实现那样回退到祖先真实路径，又等于没有第二道闸。
 *
 * 做法：逐段向下走，遇到可 `readlink` 的段就解析其目标、对目标做 realpath，
 * 再把剩余段拼回去。解析不出（目标同样不可验证 / 链接环）返回 null，
 * 调用方据此判否。
 */
function _realpathViaLink(p) {
  const root = path.parse(p).root;
  const parts = p.slice(root.length).split(path.sep).filter(Boolean);
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    if (i > 32) return null;          // 防链接环（junction 指向自身之类）
    cur = path.join(cur, parts[i]);
    let target = null;
    try { target = fs.readlinkSync(cur); } catch (_e) { continue; }  // 不是链接，继续往下
    const rest = parts.slice(i + 1);
    try {
      const realTarget = fs.realpathSync(path.resolve(path.dirname(cur), target));
      return rest.length ? path.join(realTarget, ...rest) : realTarget;
    } catch (_e) {
      return null;                    // 目标本身不可验证 ⇒ 无法判定
    }
  }
  return null;
}

/**
 * 取真实路径（解析符号链接 / 8.3 短名 / 大小写）。
 *
 * 路径可能尚不存在（新建下载目录、rename 的目标路径），此时逐级回退到
 * **最近的已存在祖先**取其 realpath，再把剩余段拼回去 —— 这样
 * `D:\Music\link\new.mp3`（new.mp3 还不存在）也能算出真实父目录。
 *
 * @returns {string|null} 连根都不存在时返回 null
 * @throws 失败原因不是「不存在」时抛出原错误（无法验证 ≠ 安全）
 */
function realpathDeep(p) {
  if (!p) return null;
  try {
    return fs.realpathSync(p);
  } catch (e) {
        if (!_isMissing(e)) {
      const viaLink = _realpathViaLink(p);
      if (viaLink) return viaLink;
      throw e;   // 无法验证 → 上抛，不许回退
    }
  }
  let cur = p;
  const tail = [];
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    tail.unshift(path.basename(cur));
    cur = parent;
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch (e2) {
      if (!_isMissing(e2)) {
        const viaLink = _realpathViaLink(cur);
        if (viaLink) return tail.length ? path.join(viaLink, ...tail) : viaLink;
        throw e2;  // 同上：非「不存在」不回退
      }
    }
  }
}

/**
 * 真实路径层面的包含判定（防符号链接绕过）。
 * 任一环节解析不出真实路径即判否 —— 安全判定上宁可拒绝。
 */
function isInsideReal(base, target) {
  try {
    const realBase = realpathDeep(normalize(base) || base);
    const realTarget = realpathDeep(normalize(target) || target);
    if (!realBase || !realTarget) return false;
    return isInside(realBase, realTarget);
  } catch (_e) {
    return false;   // 无法验证真实路径 ⇒ 判否（不向上冒泡成 IPC 异常）
  }
}

/**
 * target 的真实路径是否落在给定基目录集合中任一成员的真实路径之内。
 *
 * realpathDeep 对「无法验证」的错误会抛出（见其注释），这里统一转成
 * **判否**：调用方都是安全判定，宁可拒绝一次合法路径，也不能把一次
 * 无法验证的路径判成沙箱内。
 */
function isInsideRealAny(bases, target) {
  let realTarget;
  try {
    realTarget = realpathDeep(target);
  } catch (_e) {
    return false;
  }
  if (!realTarget) return false;
  for (const base of bases) {
    try {
      const realBase = realpathDeep(base);
      if (realBase && isInside(realBase, realTarget)) return true;
    } catch (_e) {
      // 单个基目录解析不出来不影响其余基目录；但它自身不能贡献「命中」
    }
  }
  return false;
}

module.exports = {
  isInside,
  isInsideReal,
  isInsideRealAny,
  realpathDeep,
  normalize,
};