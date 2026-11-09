/**
 * 下载路径模板：把「相对下载目录的片段」规划成真实落盘目录
 *
 * 变量渲染不住在这里（那是 naming.renderPathSegments，和文件名模板同一张表），
 * 本模块只管目录语义三件事：
 *   1. 相对片段从哪来 —— 新模板存 subpath；老模板（含云同步/导入来的）只存了
 *      绝对路径，就按当前根目录现推，推不出来（用户换了下载目录）就当它不可用；
 *   2. 层级上限 —— 超过 MAX_SEGMENTS 整条模板作废，而不是静默截断到别处；
 *   3. 永远不出根目录 —— 单点规则（缺值段丢弃、点号段丢弃、未知变量段丢弃）之外，
 *      拼完再过两道包含检查：词法一道（防 C:\MusicX 冒充 C:\Music），
 *      真实路径一道（防根目录内的链接把落盘点甩到外面）。模板是用户输入 +
 *      外部同步数据，三道锁都要有。
 *
 * 落不了地时一律回落根目录并带上 reason，调用方（downloadQueue）只负责把
 * reason 写进日志：下载绝不能因为「目录规划失败」而失败。
 */

const path = require('path');
const { renderPathSegments } = require('./naming');
/**
 * 真实路径闸口复用同一条 realpath 判据（src/utils/realpathContain.js），
 * 不在本模块另抄一份 —— 两份判据必然漂。
 *
 * 该判据原先住在主进程的目录沙箱模块（approvedDirs），本模块 require 它形成
 * utils → main 的反向依赖。2026-11 已把 normalize / isInside / realpathDeep /
 * isInsideReal / isInsideRealAny 整体下沉到 utils/realpathContain.js（只 require
 * path / fs 两个 node 内置模块，不拖 electron / prefs），沙箱模块改为从那里
 * re-export。于是依赖方向恢复单向：main → utils，utils 侧仍是叶子，纯函数测试
 * 可直接 require 本模块；沙箱模块本身不再持有任何判据实现。
 *
 * ⚠️ 已闭合（2026-10-13 复审 P1-3）：src/main/ipc/ai-music.js 曾另带一份纯词法
 * isInside（ai-generate-music 的 saveDir 校验），只做 path.relative、没过 realpath
 * 复核，于是同一种「批准目录内的链接指到外面」的形态在 AI 落盘侧仍放行。那一处
 * 现已改为调用 approvedDirs.isApprovedDir，全仓的路径判据到此只有一份。
 * 由 test/ai-music-savepath.test.js 钉住，别让它退回自写判据。
 */
const { isInsideReal } = require('./realpathContain');

/** 子目录层级上限：8 层已经超出「按歌手/专辑整理」的量级，再多是写错了 */
const MAX_SEGMENTS = 8;

// Windows 与 macOS 默认大小写不敏感：比较包含关系时先归一大小写，
// 否则 D:\Music 与 d:\music 会被当成两个目录，把合法模板误判成越界。
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function normDir(p) {
  const s = path.resolve(String(p));
  return CASE_INSENSITIVE ? s.toLowerCase() : s;
}

/** target 是否落在 base 内（含 base 自身） */
function isInsideDir(base, target) {
  if (!base || !target) return false;
  const b = normDir(base);
  return normDir(target) === b || normDir(target).startsWith(b + path.sep);
}

/**
 * 绝对模板路径 → 相对下载根目录的片段
 * @returns {string} 在内（含正好是根目录 → ''）
 * @returns {null} 参数不全或不在根目录内
 */
function subpathFromAbsolute(absPath, saveDir) {
  if (typeof absPath !== 'string' || !absPath.trim()) return null;
  if (typeof saveDir !== 'string' || !saveDir.trim()) return null;
  if (!isInsideDir(saveDir, absPath)) return null;
  return path.relative(path.resolve(saveDir), path.resolve(absPath));
}

/** 只按 id 取活动模板；id 缺失或查不到都算「没有模板」，不猜第一个 */
function activePathTemplate(templates, activeId) {
  if (!activeId || !Array.isArray(templates)) return null;
  return templates.find((t) => t && t.id === activeId) || null;
}

/**
 * 规划这首歌唱到哪个目录
 * @param {object|null} template 活动模板 { subpath } 或老数据 { path }
 * @param {string} saveDir 生效的下载根目录（绝对；逐曲覆盖目录也算根目录）
 * @param {object} song 歌曲信息
 * @param {object} [opts] { now: Date } 透传给变量渲染
 * @returns {{dir:string, applied:boolean, reason:string}}
 *   reason: '' | 'no-root' | 'no-template' | 'no-subpath' | 'empty-after-render'
 *           | 'too-deep' | 'outside-save-dir' | 'link-escapes-save-dir'
 */
function planDownloadDir(template, saveDir, song, opts) {
  const root = (typeof saveDir === 'string' && saveDir.trim()) ? path.resolve(saveDir.trim()) : '';
  if (!root) return { dir: '', applied: false, reason: 'no-root' };

  const tpl = (template && typeof template === 'object') ? template : null;
  let pattern = '';
  if (tpl && typeof tpl.subpath === 'string') {
    pattern = tpl.subpath.trim();
  } else if (tpl && typeof tpl.path === 'string' && tpl.path.trim()) {
    const sub = subpathFromAbsolute(tpl.path.trim(), root);
    if (sub === null) return { dir: root, applied: false, reason: 'outside-save-dir' };
    pattern = sub.trim();
  } else {
    return { dir: root, applied: false, reason: 'no-template' };
  }

  if (!pattern) return { dir: root, applied: false, reason: 'no-subpath' };
  const segments = renderPathSegments(pattern, song, opts);
  if (!segments.length) return { dir: root, applied: false, reason: 'empty-after-render' };
  if (segments.length > MAX_SEGMENTS) return { dir: root, applied: false, reason: 'too-deep' };

  const dir = path.join(root, ...segments);
  if (!isInsideDir(root, dir)) return { dir: root, applied: false, reason: 'outside-save-dir' };
  // ── 审计 P1-7：第二道闸，真实路径复核 ──────────────────────
  // 词法判定挡得住前缀碰撞，挡不住符号链接：D:\Music\link → C:\Windows\System32
  // 时 D:\Music\link\evil 词法上「在根目录内」，真实落盘却在沙箱外 —— 而这一路
  // 此前完全没有复核（downloadQueue 只判根目录，随后直接 mkdir recursive）。
  // realpathContain 早已把这条列为 P1 并用 realpath + realpathDeep 关掉（见该
  // 文件头注释里保留的 approvedDirs 原审计说明），这里补的是同一道防线，不是
  // 另立一套口径。
  // realpathDeep 对尚不存在的子目录逐级回退到最近已存在祖先，所以「这次下载
  // 才新建的目录」照样能判，不会因为路径还没出现就误杀正常模板。
  if (!isInsideReal(root, dir)) {
    return { dir: root, applied: false, reason: 'link-escapes-save-dir' };
  }
  return { dir, applied: true, reason: '' };
}

module.exports = {
  MAX_SEGMENTS,
  planDownloadDir,
  subpathFromAbsolute,
  activePathTemplate,
  isInsideDir,
};
