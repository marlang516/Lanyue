/**
 * 本地音乐库 IPC · domain · 扫描域
 * 纯业务逻辑：不含 electron / context / safeSend，所有外部依赖经 deps 注入。
 */

function register(deps) {
  const { fs, localLibrary, libraryIndex, fileRelink, logger, setLibraryWatchDir } = deps;

  async function scanLocalLibrary(dirPath) {
    if (!await fs.exists(dirPath)) return { error: '目录不存在', songs: [] };

    // 扫描成功即（重新）武装目录监听：用户换目录后 watcher 自动跟随
    if (typeof setLibraryWatchDir === 'function') {
      try { setLibraryWatchDir(dirPath); } catch (_e) { /* watcher 未就绪不影响扫描 */ }
    }

    let result;
    try {
      result = await libraryIndex.incrementalScan(
        dirPath,
        localLibrary.scanDirectory,
        localLibrary.readAudioMetadata,
      );
    } catch (e) {
      logger.warn('[Library] 增量扫描失败，回退全量扫描:', e.message);
      result = null;
    }

    if (result) {
      let relinked = { fixed: 0, ambiguous: 0 };
      try {
        relinked = await fileRelink.reconcileScannedRefs(result.songs);
      } catch (e) {
        logger.warn('[scan-local-library] 外部改名对账失败:', e.message);
      }
      return { songs: result.songs, count: result.songs.length, incremental: true, relinked };
    }

    // 回退到全量扫描
    try {
      const filePaths = await localLibrary.scanDirectory(dirPath);
      const songs = [];
      const BATCH = 20;
      for (let i = 0; i < filePaths.length; i += BATCH) {
        const batch = filePaths.slice(i, i + BATCH);
        const metas = await Promise.allSettled(batch.map(fp => localLibrary.readAudioMetadata(fp)));
        for (const r of metas) {
          if (r.status === 'fulfilled') songs.push(r.value);
          else logger.warn('读取元数据失败:', r.reason?.message);
        }
        await new Promise(r => setImmediate(r));
      }
      let relinked = { fixed: 0, ambiguous: 0 };
      try {
        relinked = await fileRelink.reconcileScannedRefs(songs);
      } catch (e) {
        logger.warn('[Library] 外部改名对账失败:', e.message);
      }
      return { songs, count: songs.length, incremental: false, relinked };
    } catch (e2) {
      return { error: e2.message, songs: [] };
    }
  }

  async function loadLibraryIndex() {
    try {
      const index = await libraryIndex.loadIndex();
      return { songs: index.songs || [], dirPath: index.dirPath, lastScan: index.lastScan };
    } catch (e) {
      return { songs: [], dirPath: '', lastScan: 0 };
    }
  }

  return { scanLocalLibrary, loadLibraryIndex };
}

module.exports = register;
