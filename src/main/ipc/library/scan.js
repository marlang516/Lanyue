/**
 * 本地音乐库 IPC · 扫描域
 * 注册：scan-local-library / load-library-index
 * 仅做参数校验 + 委托 domain；不直接触碰 electron/context/fsAsync。
 */

const { handle } = require('../register');
const { isValidPath, isInAllowedDir } = require('./sandbox');

function register(deps) {
  const { scan } = deps;

  // 扫描本地目录（增量扫描：缓存索引 + 只处理变更文件）
  handle('scan-local-library', async (_, dirPath) => {
    try {
      if (!isValidPath(dirPath)) return { error: '非法路径', songs: [] };
      // C1: 未批准/未配置目录不可枚举（原实现可扫全盘任意目录）
      if (!isInAllowedDir(dirPath)) return { error: '路径不可访问', songs: [] };
      return await scan.scanLocalLibrary(dirPath);
    } catch (e) {
      return { error: e.message, songs: [] };
    }
  });

  // 读取缓存索引（启动时秒加载）
  handle('load-library-index', async () => {
    try {
      return await scan.loadLibraryIndex();
    } catch (e) {
      return { songs: [], dirPath: '', lastScan: 0 };
    }
  });
}

module.exports = register;
