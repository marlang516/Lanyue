// 启动耗时基准：模块加载即开始计时，[perf] 日志全部相对它计算
const bootT0 = Date.now();

const { app, BrowserWindow, Notification, protocol, session, dialog, shell } = require('electron');
const { handle: ipcHandle, on: ipcOn, assertContractCoverage } = require('./ipc/register');
const { defaultDownloadDir } = require('../shared/downloadDefaults');
const path = require('path');
const { setCookieStore } = require('../api');
const logger = require('../utils/logger');
const { installRejectionGuard } = require('../utils/rejectionGuard');
const cookieStore = require('../utils/cookieStore');
const { setOnlineLrcNotifier } = require('../utils/onlineLrc');
const api = require('../api');
const { getDownloadUrlSmart, getLyrics } = api;
const { init: initContext, safeSend: ctxSafeSend } = require('./context');
const taskbarProgress = require('./taskbarProgress');
const { createDownloadQueueEngine } = require('./downloadQueue');
const playCache = require('./playCache');
const { registerStreamScheme, STREAM_SCHEME } = require('./streamProtocol');
const streamRegistry = require('./streamRegistry');
const approvedDirs = require('./approvedDirs');
const history = require('../utils/history');
const prefs = require('../utils/prefs');
const { getPolicyFactsForQueue } = require('./qualityPolicyFacts');
// 主进程即 UI 线程：文件 IO 走异步封装（见 utils/fsAsync.js）
const fsa = require('../utils/fsAsync');
// 窗口创建（含渲染层入口白名单校验 / 导航拦截）已抽到 main/createWindow.js
const { createWindow } = require('./createWindow');
// ─── IPC 域模块（装配在 ipc/index.js 的 registerAllIpcHandlers 里完成）───
const ipcWindow  = require('./ipc/window');
const ipcSearch  = require('./ipc/search');
const ipcDownload= require('./ipc/download');
const ipcCookie  = require('./ipc/cookie');
const ipcLibrary = require('./ipc/library');
const ipcPrefs   = require('./ipc/prefs');
const ipcCheckLocal = require('./ipc/checkLocal');
const ipcHistory = require('./ipc/history');
const ipcAiMusic = require('./ipc/ai-music');
const ipcSongStory = require('./ipc/songStory');
const ipcTasteProfile = require('./ipc/tasteProfile');
const ipcProvider = require('./ipc/ai-provider');
const ipcPlaylist = require('./ipc/playlist');
const ipcDownloadTemplates = require('./ipc/downloadTemplates');
const ipcCloudSync = require('./ipc/cloudSync');
const ipcSubscriptions = require('./ipc/subscriptions');
const ipcMcp = require('./ipc/mcp');
const ipcAssistant = require('./ipc/ai-assistant');
const ipcSmartPlaylist = require('./ipc/smart-playlist');
const ipcPlaylistAudit = require('./ipc/playlistAudit');
const { registerAllIpcHandlers: registerAllIpc } = require('./ipc');
const subscriptions = require('./subscriptions');
const { createSubscriptions } = require('./subscriptions');
const clipboardWatch = require('./clipboardWatch');
const { createLibraryWatcher } = require('./libraryWatcher');
const { buildAppMenu } = require('./appMenu');
const trayMod = require('./tray');
const globalShortcuts = require('./globalShortcuts');
const { installCorsHeaders } = require('./corsHeaders');
const { installPermissionGuards } = require('./permissions');
const { initCrashReporter } = require('./crash');

// 修复 B15：使用 context.js 提供的统一 safeSend，避免代码漂移
const safeSend = ctxSafeSend;

let libraryWatcher = null;

// ─── 崩溃转储（本地，不上传）──────────────────────────
// 必须在 app ready 之前调用：Electron 只在此之前挂上崩溃处理器。
// 初始化失败只记日志，不阻断启动（实现见 main/crash.js）。
const crashDumpsDir = initCrashReporter(app, logger);
if (crashDumpsDir) logger.log('[crash] 本地转储目录:', crashDumpsDir);

// ─── 权限护栏：覆盖所有会话 ─────────────────────────────
// 登录窗口按 partition: `login-${platform}` 建独立会话（远程第三方登录页），
// defaultSession 的护栏管不到它。session-created 在会话创建时触发，先于该
// 会话首个页面加载；defaultSession 在 ready 后再装一次（setXxxHandler 幂等）。
app.on('session-created', (s) => installPermissionGuards(s, logger));

// ─── 全局未捕获拒绝归口 ─────────────────────────────────
// 「为什么需要它、为什么按栈帧分流」见 utils/rejectionGuard.js 顶部说明。
installRejectionGuard({ logger });

// ─── 同步未捕获异常兜底（uncaughtException）─────────────
// rejectionGuard 只兜 unhandledRejection（异步）。启动期 / 运行期任何同步 throw
// 走 Node 默认行为：把栈打到 stderr 后退出。问题在于：(1) 文件日志是异步缓冲的，
// 进程退出前最后一批可能来不及落盘；(2) 启动脚本（启动.bat）用 `start` 分离
// 进程，stderr 直接被丢弃。两者叠加 → 用户只看到「主进程起不来」，main.log 里
// 却只有一行「日志落盘已启用」、零错误线索（历史 2026-11-10 05:27–05:37 即此症
// 状）。这里在退出前先把错误同步落盘，再 exit(1) 干净退出——干净退出会释放单实
// 例锁，避免残留僵尸占锁导致后续每次启动都被 app.quit() 秒拒的死循环。
process.on('uncaughtException', (err) => {
  try {
    logger.error('[main][uncaughtException] 同步异常，进程即将退出:\n' + (err && err.stack ? err.stack : String(err)));
  } catch (_e) { /* 记录通道自身失败不能阻断退出 */ }
  try { logger.flushSyncOnExit(); } catch (_e) { /* 同上 */ }
  process.exit(1);
});

// 在 app ready 之前声明：Electron 要求特权 scheme 只能在 ready 前注册。
// 少了 standard，Chromium 不会按媒体语义对这个 scheme 发 Range 请求，
// 流式播放就退化成"只能从头顺播"，seek 依旧不可用 —— 这正是根因 1。
protocol.registerSchemesAsPrivileged([
  {
    scheme: STREAM_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

let mainWindow;

// ── 下载队列引擎（Sprint C：已从本文件抽到 main/downloadQueue.js）──
// 队列状态 / 持久化 / 并发调度 / 单曲处理（取流→落盘→ID3→歌词→历史→通知）
// 全部归 downloadQueue.js；本文件只负责组装依赖。
let downloadQueueEngine = null;
/** 队列引用：引擎创建后与其内部数组同一引用，供 context / IPC 消费 */
let downloadQueue = [];

// ── 下载域 ProgressPort 实现（M1.1-B）──────────────────────────────
// Electron 能力（webContents.send）只允许出现在装配层，引擎只认 ProgressPort。
// 定义为模块级常量而非 boot 内局部量：队列 IPC 域（ipc/download/queue.js）
// 必须复用**同一份**实现，队列快照才有唯一投递路径（ADR §5.2 C5）。
// 引用全部惰性求值，早于 createWindow / 引擎创建声明也安全。
// 注意：taskbarProgress 的刷新仍由 context.safeSend 承担（M1.1-B 不迁移），
// 这里绝不重复调 taskbarProgress.refresh，否则会双刷。
const downloadProgressPort = {
  emitQueueUpdated(rows) {
    // 同步转发：rows 是队列活引用，与改造前的 safeSend('queue-updated') 语义一致。
    safeSend('queue-updated', rows || (downloadQueueEngine ? downloadQueueEngine.getQueue() : downloadQueue));
    // 对应 onQueueChanged：队列变更时同步托盘菜单（下载数量/进度展示）。
    try { trayMod.updateTrayMenu(); } catch (_e) { /* 托盘未就绪可忽略 */ }
  },
  emitProgress(taskId, payload) {
    // 引擎已完成 120ms 节流，但 100% 必发；实现不得再做时间窗合并
    safeSend('download-progress', payload);
  },
  emitError(taskId, payload) {
    safeSend('download-error', payload);
  },
};

// ─── 单实例锁 ──────────────────────────────────────────
// 没有它时每次启动都是一个完全独立的进程：各自的托盘图标、各自的下载队列，
// 且共同读写 userData 下的 queue.json / play-queue.json / history.json ——
// atomicWriteJson 防文件损坏但不防后写覆盖先写，两个窗口的队列会互相清空。
// 全局媒体键也只有一份归属（register 后到的静默失败），按键会打到错误实例。
// 因此第二次启动直接退出，并把焦点还给已开着的窗口。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    // 主窗口平时「关闭」只是 hide 到托盘，这里要把它捞回来
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    if (!mainWindow.isFocused()) mainWindow.focus();
  });
}

// ── 下载队列：状态 / 持久化 / 调度已抽到 main/downloadQueue.js ──
// 本文件只保留「引擎装配」；播放队列持久化已抽到 main/playQueue.js。
const { persistPlayQueue, flushPlayQueueNow, loadPersistedPlayQueue, setPlayQueuePort } = require('./playQueue');

// 端口注入到 playQueue（app.getPath('userData')）
setPlayQueuePort({ app });

/** 创建主窗口：把窗口级依赖显式交给 createWindow，返回值即模块级 mainWindow */
function openMainWindow() {
  mainWindow = createWindow({
    app,
    BrowserWindow,
    logger,
    safeSend,
    getDownloadQueue: () => downloadQueue,
    getDownloadQueueEngine: () => downloadQueueEngine,
    trayMod,
    bootT0,
  });
  return mainWindow;
}

// ─── 系统托盘已抽到 main/tray.js（createTray / updateTrayMenu / toggleMainWindow）───
// 导出供其他模块调用
module.exports = { updateTrayMenu: trayMod.updateTrayMenu };

// ── 全局快捷键已抽到 main/globalShortcuts.js（register / unregister / updateGlobalShortcutsEnabled）──

// ─── 应用菜单已抽到 main/appMenu.js（buildAppMenu）─────────────────

app.whenReady().then(async () => {
  try {
  // 启动耗时：模块加载到 app ready（[perf] window-ready 在同一基准上收尾）
  logger.log(`[perf] app-ready ${Date.now() - bootT0}ms`);

  // 权限最小化：默认拒绝，只放行全屏（实现见 main/permissions.js）。
  // 必须在创建任何窗口之前装好，否则首个页面就能先申请到权限。
  installPermissionGuards(session.defaultSession, logger);

  // 流式播放 scheme 就位（根因 1）。旧路径是把整首落盘再给 file://，
  // 那样整首下完前 audio.duration 恒为 NaN，seek 入口根本不存在。
  registerStreamScheme(protocol, (u) => streamRegistry.resolveStream(u));

  // 初始化 cookieStore
  cookieStore.init(app.getPath('userData'));
  setCookieStore(cookieStore);

  // 初始化 prefs（用户偏好持久化）
  prefs.init(app.getPath('userData'));

  // 启用日志落盘（P3-1）：生产环境控制台只留 error，而 155 处 logger.warn
  // 记录的正是所有降级路径（镜像兜底失败、队列丢脏记录、目录模板回落…）——
  // 用户报障时现场需要这些上下文。落盘异步 + 定时合并，不冻结主进程。
  try {
    logger.initLogFile(path.join(app.getPath('userData'), 'logs', 'main.log'));
  } catch (e) {
    logger.warn('[main] 日志落盘初始化失败:', e.message);
  }

  // C1: seed 目录授权注册表 —— prefs 里的目录键是历史会话经原生选器
  // 选定的结果，默认音乐子目录随应用始终可用
  for (const k of approvedDirs.DIR_PREF_KEYS) {
    const v = prefs.get(k);
    if (v) approvedDirs.approve(v);
  }
  approvedDirs.approve(defaultDownloadDir(app.getPath('music')));
  approvedDirs.approve(defaultDownloadDir(app.getPath('userData')));

  // 初始化下载历史持久化
  history.init(app.getPath('userData'));

  // ── 装配下载队列引擎（Sprint C：实现见 main/downloadQueue.js）──
  // 必须在 registerAllIpcHandlers 之前：registerAllIpcHandlers 会把引擎能力
  // 打包注入队列 IPC 域（M1.1-C），引用指向本函数创建的引擎。
  //
  // 下载域 ProgressPort（M1.1-B）：Electron 能力（webContents.send / Notification /
  // shell）只允许出现在装配层，引擎只认 ProgressPort / NotifyPort。
  // 实例在模块级声明（downloadProgressPort），队列 IPC 域复用同一实例。
  const downloadNotifyPort = {
    downloadDone(song, savePath) {
      const n = new Notification({
        title: '下载完成',
        body: `${song.title} - ${song.artist || '未知艺术家'}`,
        silent: false,
      });
      n.on('click', () => {
        downloadNotifyPort.showInFolder(savePath);
      });
      n.show();
    },
    showInFolder(filePath) {
      shell.showItemInFolder(filePath);
    },
  };

  downloadQueueEngine = createDownloadQueueEngine({
    userDataDir: () => app.getPath('userData'),
    // 落盘兜底必须与 get-default-dir（UI 展示）同源，否则用户没设 saveDir 时
    // 「打开文件夹」看到的和文件真实落点是两个目录
    getDefaultDownloadDir: () => defaultDownloadDir(app.getPath('music')),
    progress: downloadProgressPort,
    getDownloadUrlSmart,
    getLyrics,
    // C1: 渲染层传入的 saveDir 必须在用户批准目录内，否则回落默认目录
    isSaveDirAllowed: (p) => approvedDirs.isApprovedDir(p),
    // 3-C: already_have 规则的判据来源（本地曲库索引）。取数失败已在模块内降级，
    // 这里不必再包 try；未注入时 downloadQueue 会让该规则自然不命中。
    getPolicyFacts: getPolicyFactsForQueue,
    notify: downloadNotifyPort,
  });
  // 让共享引用指向引擎内部数组（context / IPC 用的是同一个数组）
  downloadQueue = downloadQueueEngine.getQueue();

  // 确保默认下载目录存在（如果有用户自定义的 saveDir 则用之，否则用系统默认）。
  // saveDir 可能指向不可用路径（盘符缺失 / 权限受限 / 网络盘离线），mkdir 失败
  // 不应阻断主进程启动——回落系统音乐目录，让窗口先起来，具体下载失败再单独报。
  const defaultDir = prefs.get('saveDir') || defaultDownloadDir(app.getPath('music'));
  try {
    await fsa.ensureDir(defaultDir); // mkdir recursive 本身幂等，无需先探测
  } catch (e) {
    logger.warn('[main] 默认下载目录不可用，回落系统音乐目录:', e.message);
    try { await fsa.ensureDir(defaultDownloadDir(app.getPath('music'))); } catch (_e2) {
      /* 回落也失败就跳过：下载时会再报错，启动不被一个目录拖死 */
    }
  }

  // 初始化 play_cache 目录 + 清理上次进程遗留的陈旧临时文件
  // 不 await：清理是尽力而为，不该拖慢启动
  playCache.cleanupStaleFiles(app.getPath('userData')).catch((e) => {
    logger.warn('[playCache] 清理陈旧缓存失败:', e.message);
  });

  // 设置在线拉歌词完成后的 renderer 通知回调
  setOnlineLrcNotifier(({ filePath, lrc, source }) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        safeSend('local-lrc-fetched', { filePath, lrc, source });
      }
    } catch (e) {
      logger.warn('[online-lrc] 推送事件失败:', e.message);
    }
  });

  // 启动时恢复队列
  try {
    await downloadQueueEngine.loadPersistedQueue();
  } catch (e) {
    logger.warn('[index] 恢复队列失败:', e.message);
  }

  // 启动时恢复播放队列
  try {
    const saved = await loadPersistedPlayQueue();
    if (saved && saved.queue && saved.queue.length) {
      safeSend('play-queue-restored', saved);
    }
  } catch (e) {
    logger.warn('[PlayQueue] 恢复播放队列失败:', e.message);
  }

  // 本地曲库目录监听：变动防抖后推送 local-library-changed，渲染层重走增量扫描。
  // watcher 留在本文件（模块级 let）：退出时需要 stop()，setLibraryWatchDir
  // 闭包也引用它，经 deps 传进 IPC 组装根即可。
  libraryWatcher = createLibraryWatcher({
    emit: () => safeSend('local-library-changed', {}),
    logger,
  });

  // 注册所有 IPC handler（按职责拆分到 src/main/ipc 下各模块，装配根在 ipc/index.js）
  registerAllIpc({
    app, dialog, shell, BrowserWindow,
    ipcWindow, ipcSearch, ipcDownload, ipcCookie, ipcLibrary, ipcPrefs, ipcCheckLocal,
    ipcHistory, ipcAiMusic, ipcSongStory, ipcTasteProfile, ipcProvider, ipcPlaylist,
    ipcDownloadTemplates, ipcCloudSync, ipcSubscriptions, ipcMcp, ipcAssistant,
    ipcSmartPlaylist, ipcPlaylistAudit, createSubscriptions,
    downloadQueueEngine, libraryWatcher, downloadProgressPort,
    safeSend, persistPlayQueue, loadPersistedPlayQueue,
    api, history, logger, prefs, trayMod, globalShortcuts,
    ipcHandle, ipcOn, initContext,
    mainWindowGetter: () => mainWindow,
  });

  // P0-1（2026-10-13 复审）：恢复出来的 pending 任务必须自己开跑。
  // 放在 registerAllIpcHandlers() 之后：调度过程中会用到的上下文（取流、
  // 歌词、偏好）都在这段装配里就绪。旧实现只在用户新增/重试/批量入队时才
  // 调度，重启后队列会一直挂在「排队中」不动。
  try {
    downloadQueueEngine.resumeRestoredQueue();
  } catch (e) {
    logger.warn('[index] 恢复队列调度失败:', e.message);
  }

  // 初始化自动更新（GitHub Releases）
  try {
    const { initUpdater } = require('./updater');
    initUpdater();
  } catch (_e) {
    logger.warn('[Updater] init failed:', _e.message);
  }

  // 契约 ↔ 注册对账：契约声明却无人注册的通道在此现形（update-* 由上面的 updater 注册）
  try { assertContractCoverage(); } catch (e) {
    logger.warn('[ipc] 契约覆盖检查失败:', e.message);
  }

  // 定期 GC play_cache（10 分钟一次，.unref() 不阻塞进程退出）
  // cleanupExpired 是异步的：setInterval 不接收返回值，需自带 catch 防未处理拒绝
  const gcTimer = setInterval(() => {
    playCache.cleanupExpired().catch((e) => logger.warn('[playCache] GC 失败:', e.message));
  }, playCache.PLAY_CACHE_GC_INTERVAL);
  if (gcTimer.unref) gcTimer.unref();

  // 订阅更新：界面已下线（2026-11-07），不再启动后台轮询。
  // IPC 仍保留，旧层回退时可手动检查；这里只是不再自动发网络请求。
  // subscriptions.startScheduler();

  // 剪贴板音乐链接嗅探（unref；prefs.clipboardWatch 每次 tick 现读，设置页即时生效）
  clipboardWatch.start();

  // 安装自定义应用菜单（屏蔽开发者工具菜单项及其加速键）
  buildAppMenu({ getMainWindow: () => mainWindow });

  // 安装 CORS 白名单（唯一安全边界，实现见 main/corsHeaders.js，
  // 由 test/platform-contract.test.js 的集合相等断言守住）
  installCorsHeaders();

  trayMod.init({
    getMainWindow: () => mainWindow,
    getDownloadQueueEngine: () => downloadQueueEngine,
  });
  globalShortcuts.init({
    getMainWindow: () => mainWindow,
    toggleMainWindow: trayMod.toggleMainWindow,
  });
  openMainWindow();
  trayMod.createTray();
  // 任务栏进度/托盘提示的落地目标（context.safeSend 在队列事件时驱动刷新）
  taskbarProgress.init({
    getWindows: () => (mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : []),
    getTray: () => trayMod.getTray(),
  });
  globalShortcuts.registerGlobalShortcuts();
  } catch (e) {
    // 启动期任何异常都要留痕并干净退出：落盘后 exit 释放单实例锁，
    // 避免半初始化僵尸占锁，让后续启动每次都被秒拒（「主进程起不来」死循环）。
    logger.error('[main] 启动流程异常，进程即将退出:\n' + (e && e.stack ? e.stack : String(e)));
    try { logger.flushSyncOnExit(); } catch (_e) { /* 记录失败不阻断退出 */ }
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  // 下载队列引擎：立即落盘待写队列 + 停定时器（防抖窗口内的最后一次变更会丢）
  try { if (downloadQueueEngine) downloadQueueEngine.dispose(); } catch (e) {
    logger.warn('[index] 队列引擎清理失败:', e.message);
  }
  try { if (libraryWatcher) libraryWatcher.stop(); } catch (_e) { /* 停止监听允许失败 */ }
  // 防抖窗口内挂起的播放队列变更立即落盘（只清定时器会把最后一次变更丢掉）
  try { flushPlayQueueNow(); } catch (e) { logger.warn('[index] 播放队列退出冲刷失败:', e.message); }
  // 防抖定时器由 flushPlayQueueNow() 内部清理，无需在此重复
  subscriptions.stopScheduler();
  clipboardWatch.stop();
  globalShortcuts.unregisterGlobalShortcuts();
  try { prefs.flush(); } catch (e) { logger.warn('prefs.flush 失败:', e.message); }
  try { history.flush(); } catch (e) { logger.warn('history.flush 失败:', e.message); }
  // 日志缓冲同步冲刷：异步写在 app.quit() 后可能来不及落盘（同上方的队列/偏好）
  try { logger.flushSyncOnExit(); } catch (_e) { /* 退出路径不再抛 */ }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) openMainWindow(); });

// ─── 下载队列调度（Sprint C：已抽到 main/downloadQueue.js）───────────────────
// processQueue / processOneSong / sanitizeFilename 的完整实现见
// src/main/downloadQueue.js（引擎在 bootstrap 处装配）。

// ⚠️ 此处下方的旧本地音乐库 IPC（scan-local-library / read-local-metadata /
//   read-local-lrc / update-id3-tags / update-id3-cover）+ LRC 解码函数
//   已在 P2-1 拆分到 src/main/ipc/library.js
// 此处不再重复定义，避免 IPC handler channel 重复注册

// ⚠️ 新增 IPC 请写进 src/main/ipc 下的模块，并通过 register.js 的 handle/on 注册：
// 通道与参数规格统一声明在 src/shared/ipcContract.js（契约未声明会启动即抛，
// test/ipc-contract.test.js 常驻对账，勿再裸用 ipcMain）
