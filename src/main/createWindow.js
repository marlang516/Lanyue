/**
 * 主窗口创建（M2-T5：从 main/index.js 抽出）
 *
 * 只负责「造窗口 + 装窗口级防护」：渲染层入口白名单校验、导航拦截、快捷键屏蔽、
 * 关闭转托盘。生命周期/托盘/队列装配仍留在 main/index.js。
 *
 * 依赖显式注入：Electron 能力（BrowserWindow / app）与队列引用都从参数来，
 * 本模块不读取共享上下文。
 */

const path = require('path');
const fs = require('fs');
const { buildContractArg } = require('../shared/ipcContract');
const senderTrust = require('./ipc/senderTrust');

// dist 根：打包后 __dirname 是 <app>/dist/main，上一级即 <app>/dist。
const DIST_ROOT = path.resolve(__dirname, '..');
// 唯一允许的渲染层目录（迁移期双轨）：默认新层 dist/renderer；显式回退 dist/renderer-legacy。
// 注意这是**穷举白名单**：dist 下其他子目录即使有 index.html 也不放行。
const RENDERER_DIR_WHITELIST = Object.freeze([
  path.join(DIST_ROOT, 'renderer'),
  path.join(DIST_ROOT, 'renderer-legacy'),
]);

/**
 * target 是否严格位于 root 之下（root 自身不算）。
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isStrictlyInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 解析主窗口入口（默认 dist/renderer/index.html）。
 *
 * 为什么必须校验：主窗口挂着全量特权 IPC 桥，LY_RENDERER_DIR 若被指向任意
 * 本机目录（比如临时目录里的钓鱼 HTML），等于把攻击者页面直接放进特权窗口——
 * 页面脚本可以调用 preload 暴露的全部通道（写文件、读 Cookie、发起下载…）。
 * 因此只允许**白名单目录**：dist/renderer（默认）、dist/renderer-legacy（旧层回退），
 * 不是「dist 根下任意子目录」——即便其他目录也塞了 index.html 一律拒绝。
 * 另外真实路径（realpath）必须仍在 dist 根内（防 symlink 逃逸），入口文件必须存在；
 * 非法值回退默认入口并告警，不阻断启动。
 *
 * @param {{ logger: object }} deps
 * @returns {string} 可交给 loadFile 的绝对路径 */
function resolveRendererEntry({ logger }) {
  const defaultEntry = path.join(DIST_ROOT, 'renderer', 'index.html');
  const requested = process.env.LY_RENDERER_DIR;
  if (!requested) return defaultEntry;

  try {
    const dir = path.resolve(requested);
    if (!RENDERER_DIR_WHITELIST.includes(dir)) {
      logger.warn('[main] LY_RENDERER_DIR 非法，回退默认入口:', requested);
      return defaultEntry;
    }
    if (!isStrictlyInside(DIST_ROOT, dir)) {
      logger.warn('[main] LY_RENDERER_DIR 非法，回退默认入口:', requested);
      return defaultEntry;
    }
    if (!isStrictlyInside(fs.realpathSync(DIST_ROOT), fs.realpathSync(dir))) {
      logger.warn('[main] LY_RENDERER_DIR 非法，回退默认入口:', requested);
      return defaultEntry;
    }
    const entry = path.join(dir, 'index.html');
    if (!fs.statSync(entry).isFile()) {
      logger.warn('[main] LY_RENDERER_DIR 非法，回退默认入口:', requested);
      return defaultEntry;
    }
    return entry;
  } catch (e) {
    logger.warn('[main] LY_RENDERER_DIR 非法，回退默认入口:', (e && e.message) || String(e));
    return defaultEntry;
  }
}

/**
 * 创建主窗口并装好窗口级防护。
 *
 * @param {object} deps
 * @param {object} deps.app                electron app（getAppPath 用）
 * @param {Function} deps.BrowserWindow    electron BrowserWindow 构造器
 * @param {object} deps.logger             日志器
 * @param {Function} deps.safeSend         统一投递（首屏队列快照补发）
 * @param {Function} deps.getDownloadQueue 返回当前下载队列数组
 * @param {Function} deps.getDownloadQueueEngine 返回队列引擎（可能为 null）
 * @param {object} deps.trayMod            托盘模块（isQuittingApp / getTray）
 * @param {number} deps.bootT0             模块加载时刻（[perf] 基准）
 * @returns {object} 新建的 BrowserWindow
 */
function createWindow({
  app,
  BrowserWindow,
  logger,
  safeSend,
  getDownloadQueue,
  getDownloadQueueEngine,
  trayMod,
  bootT0,
}) {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 渲染层与 preload 均运行在 Chromium OS 沙箱内：preload 不能 require electron
      // 内置模块，IPC 契约经 argv 注入（见下方 additionalArguments），无需放宽。
      sandbox: true,
      webSecurity: true, // 启用安全策略，CORS 通过 session.defaultSession.webRequest 头部处理
      preload: path.join(__dirname, '../preload/preload.js'),
      // sandbox preload 不能 require 应用文件：IPC 契约经 argv 序列化注入
      additionalArguments: [buildContractArg('main')],
    },
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, '../../assets/icon.png'),
  });

  // 主窗口是唯一持有完整 IPC 能力面的窗口；先登记再加载页面，
  // 首屏脚本的第一条 invoke 就能通过来源闸。
  senderTrust.trust(win.webContents, 'main');

  // 默认入口是重写后的新渲染层（dist/renderer）。LY_RENDERER_DIR 只是显式回退
  // 开关（例如指向 dist/renderer-legacy），且必须先过 resolveRendererEntry 的
  // 包内校验 —— 否则任意本机 HTML 都能被加载进这个持有全量 IPC 桥的窗口。
  const rendererEntry = resolveRendererEntry({ logger });
  logger.log('[main] 渲染层入口:', rendererEntry);
  win.loadFile(rendererEntry).then(() => {
    logger.log('[main] loadFile done');
  }).catch(err => {
    logger.warn('[main] loadFile failed:', err);
    // 开发模式下可能 dist/renderer 还没构建好
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      if (app.isPackaged) {
        logger.warn('[main] 已打包应用忽略 VITE_DEV_SERVER_URL');
        return;
      }
      let parsedDevUrl;
      try { parsedDevUrl = new URL(devUrl); } catch (_) { parsedDevUrl = null; }
      if (!parsedDevUrl
        || parsedDevUrl.protocol !== 'http:'
        || !['localhost', '127.0.0.1', '[::1]'].includes(parsedDevUrl.hostname)
        || parsedDevUrl.username
        || parsedDevUrl.password) {
        logger.warn('[main] 拒绝非本地开发渲染层 URL');
        return;
      }
      logger.log('[main] trying dev server URL:', devUrl);
      win.loadURL(devUrl).catch(e => logger.warn('[main] loadURL also failed:', e));
    }
  });

  // 渲染层就绪后补发一次队列快照：新界面首次打开下载页即可看到重启前遗留的
  // pending/downloading 任务。旧层只靠增量事件，重启后会漏展示（本改动对旧层
  // 只是一次幂等整表刷新，行为无变化）。
  win.webContents.on('did-finish-load', () => {
    // 首屏就绪耗时：从模块加载到渲染层 load 完成（与 [perf] app-ready 同一基准）。
    logger.log(`[perf] window-ready ${Date.now() - bootT0}ms`);
    try {
      safeSend('queue-updated', getDownloadQueue());
      const engine = getDownloadQueueEngine();
      safeSend('queue-paused-changed', engine ? engine.isPaused() : false);
    } catch (e) {
      logger.warn('[main] 队列快照补发失败:', e.message);
    }
  });

  // 关闭开发者工具自动开启（按需通过菜单 → 视图 → 开发者工具 手动打开）
  // 导航防护：主窗口只加载本地内容，任何远程/file 导航一律拒绝
  // （渲染层一旦有脚本注入，window.open / location 跳转可把窗口导向
  // 钓鱼页或本地文件协议，此处统一拦截）
  const denyNav = (url) => {
    logger.warn('[main] 拒绝主窗口导航:', url);
  };
  win.webContents.on('will-navigate', (event, url) => {
    const u = (() => { try { return new URL(url); } catch (_) { return null; } })();
    if (!u) { denyNav(url); event.preventDefault(); return; }
    // M1: file: 导航只放行应用自身包内文件 —— 原先任意本机 HTML 都能载入
    // 这个挂着全量特权 IPC 的窗口（与下载目录写入组合即完整攻击链）
    const { fileURLToPath } = require('url');
    const isLocal = (() => {
      if (u.protocol !== 'file:') return false;
      try {
        const fp = fileURLToPath(u);
        const rel = path.relative(path.resolve(app.getAppPath()), path.resolve(fp));
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      } catch (_) { return false; }
    })();
    // 同源 http(s) 导航放行（dev 模式下 vite 服务器整页刷新）。
    // 不能直接比 u.origin === current.origin：file: 页的 origin 恒为
    // 字符串 'null'，会把所有 file: 导航误判成同源。
    const cur = (() => {
      try { return new URL(win.webContents.getURL()); } catch (_) { return null; }
    })();
    const sameHttpOrigin = !!cur
      && (cur.protocol === 'http:' || cur.protocol === 'https:')
      && u.protocol === cur.protocol && u.host === cur.host;
    if (!isLocal && !sameHttpOrigin) {
      denyNav(url);
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    denyNav(url);
    return { action: 'deny' };
  });

  // 拦截 F12 / Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+U 防止误开
  const blockList = new Set(['F12']);
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (blockList.has(input.key)) {
      event.preventDefault();
      return;
    }
    if (input.control && input.shift && ['I', 'i', 'J', 'j', 'C', 'c'].includes(input.key)) {
      event.preventDefault();
      return;
    }
    if (input.control && ['U', 'u'].includes(input.key)) {
      event.preventDefault();
      return;
    }
    // Ctrl+R 刷新页面（保留）
    if (input.key === 'r' && (input.control || input.meta)) {
      event.preventDefault();
      win.webContents.reload();
    }
  });

  // 窗口关闭时最小化到托盘（不是真的关闭）
  win.on('close', (event) => {
    if (!trayMod.isQuittingApp()) {
      event.preventDefault();
      win.hide();
      const t = trayMod.getTray();
      if (t) {
        t.displayBalloon({ title: '揽乐', content: '已最小化到托盘，点击恢复' });
      }
    }
  });

  return win;
}

module.exports = { createWindow, resolveRendererEntry };
