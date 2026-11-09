/**
 * 本地音乐库 IPC · 组装根
 *
 * 三层结构：
 *   infra/*   —— fs/online/relink/localLibrary/approvedDirs/prefs 适配器（无业务判断）
 *   domain/*  —— 纯业务逻辑（scan/metadata/lyrics/files/convert/dupScan），不含 electron/context/safeSend
 *   library/*.js —— IPC 层，仅做参数校验 + 委托 domain
 *
 * register(opts) 显式注入依赖；子模块不再直接读取主进程共享上下文。
 */

const context = require('../context');

function register(opts = {}) {
  // 显式注入优先；未注入时从共享上下文/模块默认值回退（保持旧行为）
  let ctxSetWatch = null;
  try {
    const c = context.getCtx();
    if (c && typeof c.setLibraryWatchDir === 'function') ctxSetWatch = c.setLibraryWatchDir;
  } catch (_e) { /* context 未初始化（如单测） */ }
  const setLibraryWatchDir = (typeof opts.setLibraryWatchDir === 'function')
    ? opts.setLibraryWatchDir : ctxSetWatch;
  const safeSend = (typeof opts.safeSend === 'function') ? opts.safeSend : context.safeSend;

  // 子模块（library/domain 下、library 下）统一导出 register 函数本体
  // （module.exports = register），不是 { register } 对象。直接调用；
  // 同时兼容 { register } 形态，避免契约漂移再次变成启动阻断。
  const toRegister = (mod) => (typeof mod === 'function' ? mod : (mod && mod.register));

  // ─── infra：基础设施适配器 ───
  const infraFs = require('./library/infra/fs');
  const infraOnline = require('./library/infra/online');
  const infraRelink = require('./library/infra/relink');
  const infraLocalLibrary = require('./library/infra/localLibrary');
  const infraApprovedDirs = require('./library/infra/approvedDirs');
  const infraPrefs = require('./library/infra/prefs');

  // ─── domain：纯业务逻辑（所有外部依赖经 deps 注入） ───
  const domainScan = toRegister(require('./library/domain/scan'))({
    fs: infraFs,
    localLibrary: infraLocalLibrary,
    libraryIndex: require('../../utils/libraryIndex'),
    fileRelink: infraRelink,
    logger: require('../../utils/logger'),
    setLibraryWatchDir,
  });

  const domainMetadata = toRegister(require('./library/domain/metadata'))({
    localLibrary: infraLocalLibrary,
    online: infraOnline,
  });

  const domainLyrics = toRegister(require('./library/domain/lyrics'))({
    fs: infraFs,
    localLibrary: infraLocalLibrary,
    relink: infraRelink,
    online: infraOnline,
  });

  const domainFiles = toRegister(require('./library/domain/files'))({
    fs: infraFs,
    relink: infraRelink,
    logger: require('../../utils/logger'),
    trashItem: require('electron').shell.trashItem,
  });

  const domainConvert = toRegister(require('./library/domain/convert'))({
    fs: infraFs,
    audioConvert: require('../../utils/audioConvert'),
    prefs: infraPrefs,
    approvedDirs: infraApprovedDirs,
    dialog: require('electron').dialog,
    shell: require('electron').shell,
    safeSend,
  });

  const domainDupScan = toRegister(require('./library/domain/dupScan'))({
    fs: infraFs,
    localLibrary: infraLocalLibrary,
    dupScan: require('../../utils/dupScan'),
    logger: require('../../utils/logger'),
    audioProbe: require('../../utils/audioProbe'),
  });

  // ─── IPC 层：仅参数校验 + 委托 domain ───
  toRegister(require('./library/scan'))({ scan: domainScan });
  toRegister(require('./library/metadata'))({ metadata: domainMetadata });
  toRegister(require('./library/lyrics'))({ lyrics: domainLyrics });
  toRegister(require('./library/files'))({ files: domainFiles });
  toRegister(require('./library/convert'))({ convert: domainConvert });
  toRegister(require('./library/dupScan'))({ dupScan: domainDupScan });
}

module.exports = { register };
