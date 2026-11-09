/**
 * 本地音乐库 IPC · domain · 文件操作域
 * 纯业务逻辑：所有外部依赖经 deps 注入。
 */

function register(deps) {
  const { fs, relink, logger, trashItem } = deps;

  async function deleteFile(filePath) {
    if (!await fs.exists(filePath)) {
      return { success: false, error: '文件不存在' };
    }
    await trashItem(filePath);
    return { success: true };
  }

  async function renameFile(oldPath, newPath) {
    if (!await fs.exists(oldPath)) {
      return { success: false, error: '源文件不存在' };
    }
    if (await fs.exists(newPath)) {
      return { success: false, error: '目标文件已存在' };
    }
    await fs.fsp.rename(oldPath, newPath);
    let relinkResult = null;
    try {
      relinkResult = await relink.relinkFileRefs(oldPath, newPath);
    } catch (e) {
      logger.warn('[rename-file] 路径引用回写失败:', e.message);
    }
    return { success: true, relink: relinkResult };
  }

  return { deleteFile, renameFile };
}

module.exports = register;
