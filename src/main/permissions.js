/**
 * 渲染层权限护栏（最小权限原则：默认拒绝）
 *
 * 为什么必须有：Electron 对「渲染层申请的特权」默认是交给应用决定的 ——
 * 不装 permission handler 时，Chromium 的默认行为并不等于「全拒」，个别
 * 权限（如 media / geolocation / notifications）在部分平台上会被直接放行。
 * 主窗口挂着全量特权 IPC，一旦渲染层被注入脚本，申请麦克风/摄像头/定位/
 * 通知等权限就成了额外的信息泄露面。这里统一改成白名单：只有明确需要的
 * 才放行，其余一律 callback(false)。
 *
 * 白名单只有两项：
 *   - fullscreen：沉浸式播放页依赖元素全屏，不涉及任何设备或用户数据；
 *   - clipboard-sanitized-write：navigator.clipboard.writeText 的权限门控，
 *     歌单 M3U 复制（renderer/app/stores/playlist.js）与 MCP 配置复制依赖它。
 * 注意不能顺手加 clipboard-read：读取剪贴板会把用户剪贴内容暴露给页面，
 * 本应用没有任何读取场景。扩展白名单时请同步更新 test/main-hardening.test.js
 * 的断言，让「白名单变大」这件事在 CI 里可见。
 *
 * 日志约束：只记录权限名 + 窗口来源（协议或 origin），不记录完整 file:
 * 路径、query、fragment —— 这些里可能带用户名、歌名、token。
 */

'use strict';

/** 放行的权限（最小集），见文件头说明 */
const ALLOWED_PERMISSIONS = Object.freeze(['fullscreen', 'clipboard-sanitized-write']);

const ALLOWED_SET = new Set(ALLOWED_PERMISSIONS);

/**
 * 把窗口来源压缩成可安全落盘的标签。
 * file: → 'file://app'（不暴露本机绝对路径）
 * http(s): → origin（不暴露路径与 query）
 * @param {Electron.WebContents|undefined|null} webContents
 * @param {{requestingUrl?: string}|undefined} details
 * @returns {string}
 */
function describeSource(webContents, details) {
  let raw = '';
  try {
    if (webContents && typeof webContents.getURL === 'function') {
      raw = webContents.getURL() || '';
    }
  } catch (_e) {
    raw = '';
  }
  if (!raw && details && typeof details.requestingUrl === 'string') {
    raw = details.requestingUrl;
  }
  if (!raw) return 'unknown';
  try {
    const u = new URL(raw);
    if (u.protocol === 'file:') return 'file://app';
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    return u.protocol;
  } catch (_e) {
    return 'unknown';
  }
}

/**
 * 安装权限请求 / 权限检查两道护栏。
 * @param {Electron.Session} session 目标会话（主窗口用 session.defaultSession）
 * @param {{warn: Function}} logger 主进程日志器（只用到 warn）
 * @returns {boolean} 是否安装成功（session 接口缺失时返回 false）
 */
function installPermissionGuards(session, logger) {
  const warn = logger && typeof logger.warn === 'function'
    ? logger.warn.bind(logger)
    : () => {};

  if (!session || typeof session.setPermissionRequestHandler !== 'function') {
    warn('[permission] session 不支持权限处理器，跳过安装');
    return false;
  }

  /**
   * 统一的判定 + 拒绝日志。
   * @param {string} permission
   * @param {Electron.WebContents|undefined|null} webContents
   * @param {{requestingUrl?: string}|undefined} details
   * @returns {boolean}
   */
  const decide = (permission, webContents, details) => {
    if (ALLOWED_SET.has(permission)) return true;
    warn(`[permission] 拒绝 ${permission} 来源=${describeSource(webContents, details)}`);
    return false;
  };

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = decide(permission, webContents, details);
    try {
      callback(allowed);
    } catch (e) {
      // callback 抛错（窗口已销毁等）不能让未捕获异常打断主进程
      warn('[permission] 回调失败:', e && e.message ? e.message : e);
      try { callback(false); } catch (_e2) { /* 窗口已销毁，无处可回调 */ }
    }
  });

  if (typeof session.setPermissionCheckHandler === 'function') {
    session.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => (
      decide(permission, webContents, details)
    ));
  } else {
    warn('[permission] session 不支持 setPermissionCheckHandler，仅安装请求护栏');
  }

  return true;
}

module.exports = { installPermissionGuards, ALLOWED_PERMISSIONS };