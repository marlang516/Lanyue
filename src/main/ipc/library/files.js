/**
 * 本地音乐库 IPC · 文件操作域
 * 注册：delete-file / rename-file
 * 仅做参数校验 + 委托 domain；不直接触碰 electron/context/fsAsync。
 */

const { handle } = require('../register');
const { isValidPath, isInAllowedDir } = require('./sandbox');

function register(deps) {
  const { files } = deps;

  // 删除文件（回收站或永久删除）
  handle('delete-file', async (_, filePath) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { success: false, error: '路径不可访问' };
      return await files.deleteFile(filePath);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 重命名文件
  handle('rename-file', async (_, oldPath, newPath) => {
    try {
      if (!isValidPath(oldPath) || !isValidPath(newPath)) return { success: false, error: '非法路径' };
      if (!isInAllowedDir(oldPath) || !isInAllowedDir(newPath)) return { success: false, error: '路径不可访问' };
      return await files.renameFile(oldPath, newPath);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = register;
