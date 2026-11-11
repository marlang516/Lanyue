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
  // 曲库目录监听：必须由调用方显式注入（M2-T5 起 context 不再中转跨域能力）。
  // 未注入时退化为空实现，避免曲库扫描路径上出现 undefined 调用。
  const setLibraryWatchDir = (typeof opts.setLibraryWatchDir === 'function')
    ? opts.setLibraryWatchDir : () => {};
  const safeSend = (typeof opts.safeSend === 'function') ? opts.safeSend : context.safeSend;

  // 端口注入：electron 能力由外部（main/index.js）提供，未注入时回退到直取 electron
  const _port = opts.port || {};
  function _shellTrashItem() {
    const shell = _port.shell;
    if (shell && typeof shell.trashItem === 'function') return shell.trashItem.bind(shell);
    return require('electron').shell.trashItem.bind(require('electron').shell);
  }
  function _dialog() {
    const d = _port.dialog;
    if (d && typeof d.showOpenDialog === 'function') return d;
    return require('electron').dialog;
  }
  function _shell() {
    const s = _port.shell;
    if (s && typeof s.showItemInFolder === 'function') return s;
    return require('electron').shell;
  }

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
    trashItem: _shellTrashItem(),
  });

  const domainConvert = toRegister(require('./library/domain/convert'))({
    fs: infraFs,
    audioConvert: require('../../utils/audioConvert'),
    prefs: infraPrefs,
    approvedDirs: infraApprovedDirs,
    dialog: _dialog(),
    shell: _shell(),
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
