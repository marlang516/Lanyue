/**
 * 本地音乐库 IPC · infra · 文件系统
 *
 * 封装 fs/fsAsync 基础设施，供 domain 层调用。不含业务判断。
 */

const fsa = require('../../../../utils/fsAsync');

module.exports = {
  /** 是否存在（替代 fs.existsSync，永不抛） */
  exists: fsa.exists,
  /** 取 stat，失败返回 null */
  statOrNull: fsa.statOrNull,
  /** fs.promises 只读 */
  fsp: fsa.fsp,
};
