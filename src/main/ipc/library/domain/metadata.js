/**
 * 本地音乐库 IPC · domain · 元数据/标签域
 * 纯业务逻辑：所有外部依赖经 deps 注入。
 */

function register(deps) {
  const { localLibrary, online } = deps;

  async function readLocalMetadata(filePath) {
    return await localLibrary.readAudioMetadata(filePath);
  }

  async function updateId3Tags(filePath, tags) {
    return await localLibrary.writeAudioMetadata(filePath, tags);
  }

  async function updateId3Cover(filePath, imageBase64) {
    return await localLibrary.writeAudioCover(filePath, imageBase64);
  }

  async function fetchOnlineCover(title, artist) {
    const result = await online.fetchOnlineCover(title || '', artist || '');
    if (!result) return { success: false, error: '未找到匹配的封面' };
    return { success: true, ...result };
  }

  return { readLocalMetadata, updateId3Tags, updateId3Cover, fetchOnlineCover };
}

module.exports = register;
