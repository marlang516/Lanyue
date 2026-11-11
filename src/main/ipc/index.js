/**
 * IPC 组装根（M2-T5：从 main/index.js 抽出 registerAllIpcHandlers）
 *
 * 只做「装配」：把各 IPC 域模块、订阅域 domain/infra、队列引擎能力接起来。
 * 所有跨域能力（队列 / 播放队列 / 曲库监听 / Electron 端口）都由调用方显式注入，
 * 本模块不读取共享上下文（context.getCtx() 已清零，仅剩 app）。
 *
 * 硬性约定：
 *   - 通道名、参数、注册顺序与拆分前完全一致（MCP 自启必须在所有 register 之后）。
 *   - 日志文案不变。
 */

function registerAllIpcHandlers(deps = {}) {
  const {
    app, dialog, shell, BrowserWindow,
    ipcWindow, ipcSearch, ipcDownload, ipcCookie, ipcLibrary, ipcPrefs, ipcCheckLocal,
    ipcHistory, ipcAiMusic, ipcSongStory, ipcTasteProfile, ipcProvider, ipcPlaylist,
    ipcDownloadTemplates, ipcCloudSync, ipcSubscriptions, ipcMcp, ipcAssistant,
    ipcSmartPlaylist, ipcPlaylistAudit, createSubscriptions,
    downloadQueueEngine, libraryWatcher, downloadProgressPort,
    safeSend, persistPlayQueue, loadPersistedPlayQueue,
    api, history, logger, prefs, trayMod, globalShortcuts,
    ipcHandle, ipcOn, initContext, mainWindowGetter,
  } = deps;

  // 必须先 init context，再 register（其他域 handler 仍通过共享上下文拿状态；
  // 下载队列域自 M1.1-C 起改为显式注入，见下方 ipcDownload 的注册调用。
  // 关键：传 getter 而不是值，否则 mainWindow / downloadQueue 在 createWindow 之后
  // 才赋值时，子模块里永远是 undefined。
  initContext({
    getMainWindow:    mainWindowGetter,
    app,
    getDownloadQueue: () => (downloadQueueEngine ? downloadQueueEngine.getQueue() : []),
  });

  // 本地曲库目录监听（watcher 由 main/index.js 创建并注入）：
  // 变动防抖后推送 local-library-changed，渲染层重走增量扫描。
  try { libraryWatcher.setDir(prefs.get('localDirPath')); } catch (_e) { /* 无历史目录则不监听 */ }
  const setLibraryWatchDir = (dir) => { if (libraryWatcher) libraryWatcher.setDir(dir); };

  ipcWindow.register({ port: { BrowserWindow, dialog, shell, app } });
  const searchDomain = require('./search/domain');
  const { createInfra: createSearchInfra } = require('./search/infra');
  ipcSearch.register({ domain: searchDomain, infra: createSearchInfra() });
  // M1.1-C：队列域能力在装配层一次性读取，handler 内不再 require context。
  // 引用全部是「延迟求值闭包」：此时引擎已创建，但队列内容仍按调用时取。
  ipcDownload.register({
    queue: {
      getQueue: () => downloadQueueEngine.getQueue(),
      persistQueue: () => downloadQueueEngine.persistQueue(),
      processQueue: () => downloadQueueEngine.processQueue(),
      requestCancel: (taskId) => downloadQueueEngine.requestCancel(taskId),
      setPaused: (v) => downloadQueueEngine.setPaused(v),
      isPaused: () => downloadQueueEngine.isPaused(),
      progress: downloadProgressPort,
    },
  });
  const playlistDomain = require('./playlist/domain');
  const { createInfra: createPlaylistInfra } = require('./playlist/infra');
  ipcPlaylist.register({ domain: playlistDomain, infra: createPlaylistInfra() });
  ipcCookie.register();
  // 曲库域：目录监听与投递通道显式注入（M2-T5 起不再经 context 中转）
  ipcLibrary.register({ port: { shell, dialog }, safeSend, setLibraryWatchDir });
  ipcPrefs.register();
  ipcCheckLocal.register();
  ipcHistory.register();
  ipcAiMusic.register({ port: { app } });
  // 歌曲讲解（候选方向 1）：播放页「讲讲这首歌」
  ipcSongStory.register({ port: { app } });
  // 厂商配置：AI 创作页与助手页那张厂商下拉的数据源
  ipcProvider.register();
  // 默认下载目录的解析留在组装根：downloadTemplates 不再 require('electron')
  ipcDownloadTemplates.register({ getMusicDir: () => app.getPath('music') });
  ipcCloudSync.register({
    showSaveDialog: dialog.showSaveDialog.bind(dialog),
    showOpenDialog: dialog.showOpenDialog.bind(dialog),
    getUserDataDir: () => app.getPath('userData'),
  });
  // 订阅域：构造注入 domain/infra，保证 IPC 通道与行为与旧实现完全一致。
  const subsDomain = require('./subscriptions/domain').createDomain({
    getPlugin: platform => api.registry.get(platform),
  });
  const subsInfra = require('./subscriptions/infra').createInfra({
    queue: {
      getQueue: () => downloadQueueEngine.getQueue(),
      persistQueue: () => downloadQueueEngine.persistQueue(),
      processQueue: () => downloadQueueEngine.processQueue(),
      // 订阅自动下载查重：显式注入，避免 infra/queue.js 依赖隐式全局
      findDownloadedAsync: (id, source) => history.findDownloadedAsync(id, source),
    },
  });
  ipcSubscriptions.register({
    subscriptions: createSubscriptions({
      domain: subsDomain,
      infra: subsInfra,
      safeSend,
      getQueue: () => downloadQueueEngine.getQueue(),
    }),
  });
  ipcMcp.register({ port: { app } });
  // MCP 依赖各 ipc 模块已把 handler 挂进注册表，必须在全部 register 之后自启
  ipcMcp.startIfEnabled().catch(e => logger.warn('[mcp] 自启失败:', e));

  // 助手与外部 Agent 共用同一张工具表与同一条桥，所以排在 MCP 之后（口径一致，非依赖）
  ipcAssistant.register({ port: { app } });

  // 智能歌单只读曲库、只出一次网，写库仍走 save-user-playlist，所以排在助手之后即可
  ipcSmartPlaylist.register();

  // 品味解读（候选方向 2）：设置页「品味画像」，读 playStats 出网一次
  ipcTasteProfile.register();

  // 歌单语义运维（候选方向 3）：给已有歌单做体检，只读，写库仍走既有通道
  ipcPlaylistAudit.register();

  // ── 播放队列持久化 IPC ─────────────────────────────
  ipcHandle('save-play-queue', (_, data) => {
    persistPlayQueue(data);
    return { ok: true };
  });
  ipcHandle('load-play-queue', () => {
    return loadPersistedPlayQueue() || { queue: [] };
  });

  // ── 系统托盘 IPC ───────────────────────────────────
  ipcOn('tray-update-play-state', (_, playState) => {
    trayMod.updateTrayMenu(playState);
  });

  // ── 全局快捷键开关（设置页实时切换）─────────────────
  ipcOn('set-global-shortcuts', (_, enabled) => {
    globalShortcuts.updateGlobalShortcutsEnabled(!!enabled);
    logger.log(`[shortcuts] 全局媒体键: ${enabled ? '已启用' : '已停用'}`);
  });

  // ── 版本查询 IPC ───────────────────────────────────
  ipcHandle('get-version', () => {
    const pkg = require('../../../package.json');
    const version = pkg.version || '1.0.0';
    const commit = process.env.npm_config_git_commit || '';
    return commit ? `${version} (${commit.slice(0, 7)})` : version;
  });
}

// ⚠️ 新增 IPC 请写进 src/main/ipc 下的模块，并通过 register.js 的 handle/on 注册：
// 通道与参数规格统一声明在 src/shared/ipcContract.js（契约未声明会启动即抛，
// test/ipc-contract.test.js 常驻对账，勿再裸用 ipcMain）

module.exports = { registerAllIpcHandlers };
