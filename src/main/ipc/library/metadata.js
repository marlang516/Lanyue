/**
 * 本地音乐库 IPC · 元数据/标签域
 * 注册：read-local-metadata / update-id3-tags / update-id3-cover / fetch-online-cover
 * 仅做参数校验 + 委托 domain；不直接触碰 electron/context/fsAsync。
 */

const { handle } = require('../register');
const { isValidPath, isInAllowedDir } = require('./sandbox');

function register(deps) {
  const { metadata } = deps;

  // 读取单首歌曲元数据
  handle('read-local-metadata', async (_, filePath) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { error: '路径不可访问' };
      return await metadata.readLocalMetadata(filePath);
    } catch (e) {
      return { error: e.message };
    }
  });

  // 更新 ID3 标签（渲染层位置参数：api.updateId3Tags(filePath, tags)）
  handle('update-id3-tags', async (_, filePath, tags) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { success: false, error: '路径不可访问' };
      return await metadata.updateId3Tags(filePath, tags);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 更新封面（渲染层位置参数：api.updateId3Cover(filePath, imageBase64)）
  handle('update-id3-cover', async (_, filePath, imageBase64) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { success: false, error: '路径不可访问' };
      if (typeof imageBase64 !== 'string' || !imageBase64.trim()) {
        return { success: false, error: '无效的封面数据' };
      }
      return await metadata.updateId3Cover(filePath, imageBase64);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 在线拉取封面（渲染层位置参数：api.fetchOnlineCover(title, artist)）
  handle('fetch-online-cover', async (_, title, artist) => {
    try {
      return await metadata.fetchOnlineCover(title, artist);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = register;
