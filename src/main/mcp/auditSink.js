/**
 * 审计落点（userData 里的那一个文件）
 *
 * 「谁在写审计」有两个 caller（HTTP Agent、应用内助手），「审计存在哪」只有一个答案。
 * 定位、单例、写盘失败不影响调用这三件事都住在这里：caller 只管 record(entry)。
 *
 * userData 在 app ready 之前取不到：此时 store() 返回 null、record() 静默跳过，
 * 服务照跑（可观测性不该变成可用性的前置条件），下次调用再试一次。
 */

const path = require('path');
const logger = require('../../utils/logger');
const { createAuditStore, AUDIT_FILE_NAME } = require('./auditStore');

let _dirOverride = '';
let _store = null;
let _storePath = '';

// 端口注入：由外部（main/index.js）提供 electron 能力，未注入时回退到直取 electron
let _port = {};
function setAuditPort(port) { _port = port || {}; }

function _appGetUserDataDir() {
  const app = _port.app;
  if (app && typeof app.getPath === 'function') {
    try { return app.getPath('userData'); } catch (_e) { return ''; }
  }
  try { return require('electron').app.getPath('userData'); } catch (_e) { return ''; }
}

function _userDataDir() {
  if (_dirOverride) return _dirOverride;
  return _appGetUserDataDir();
}

function store() {
  const dir = _userDataDir();
  if (!dir) return null;
  const filePath = path.join(dir, AUDIT_FILE_NAME);
  if (_store && _storePath === filePath) return _store;
  _storePath = filePath;
  _store = createAuditStore({ filePath });
  return _store;
}

/** 审计是可观测性，绝不影响调用结果：写盘失败（磁盘满、权限）只记一条 warn */
function record(entry) {
  const s = store();
  if (!s) return Promise.resolve();
  return s.record(entry).catch((e) => logger.warn('[mcp] 审计写入失败:', e));
}

function _setUserDataDirForTest(dir) {
  _dirOverride = dir || '';
  _store = null;
  _storePath = '';
}

module.exports = { store, record, AUDIT_FILE_NAME, _setUserDataDirForTest, setAuditPort };
