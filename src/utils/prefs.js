/**
 * 用户偏好持久化
 *
 * 存储内容（JSON 文件 userData/prefs.json）：
 *   - saveDir:       下载目录（用户在设置里改过的）
 *   - localDirPath:  本地音乐库目录
 *
 * 与 cookieStore 的区别：
 *   - cookieStore 存的是"登录态"，敏感，不应备份
 *   - prefs 存的是"用户偏好"，可备份，丢失不影响功能
 *
 * 另有一个本机内部键 prefsVersion（schema 版本，见 utils/dataMigration.js）：
 * 它只描述这份文件被升到哪一版，不是用户设置，故不进任何白名单。
 *
 * 关于同步 IO（有意保留的例外，勿当作遗漏）：
 *   prefs 极小且全程内存缓存，只有首次加载读一次盘。关键在于 flush()——
 *   它要在进程退出路径上「立即写完」，此时事件循环可能已不再推进，
 *   await 永远等不到回调。所以这里必须同步。其余主进程 IO 请走 utils/fsAsync。
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const secret = require('./secretStore');
const { atomicWriteJson, safeReadJson } = require('./atomicFile');
const { migratePrefs } = require('./dataMigration');

// M4: 这些键是凭证级数据（AI 服务计费 key），落盘必须走 safeStorage 加密；
// get 时透明解回明文，解密不可用（换机导入的备份）按未配置处理
const SECRET_KEYS = new Set(['aiMusicApiKey']);

let _userDataPath = null;
let _cache = null;        // 内存缓存，避免每次都读盘
let _writeTimer = null;   // 防抖写入

function init(userDataPath) {
  _userDataPath = userDataPath;
  _cache = null;
  _writeTimer = null;
}

function _getFilePath() {
  if (!_userDataPath) return null;
  return path.join(_userDataPath, 'prefs.json');
}

function _readFromDisk() {
  try {
    const fp = _getFilePath();
    if (!fp || !fs.existsSync(fp)) return {};
    const res = safeReadJson(fp);
    if (!res.ok) {
      // 损坏文件已备份为 prefs.json.bak，此处走空对象等下次写入覆盖
      logger.warn('prefs: 文件损坏，已备份为 .bak，使用空对象');
      return {};
    }
    if (res.empty) return {};
    const parsed = res.data;
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    logger.warn('prefs: 加载失败，使用空对象:', e.message);
    return {};
  }
}

/**
 * 磁盘态 → 内存态：读文件，并顺手把 schema 升到当前版本。
 *
 * 迁移放在这里而不是各个读取方：prefs.json 长什么样只由本模块定义，要求每个
 * 调用方自己判断版本，就等着有人漏判。升级结果必须**立即落盘**（不走 set 的
 * 300ms 防抖）：只升内存的话，用户重启读到的还是老文件，迁移等于白做；而下次
 * 启动又会再迁一次，永远迁不完。落盘失败只告警 —— 读路径不能因为写不进去而挂。
 */
function _load() {
  if (_cache !== null) return _cache;
  _cache = _readFromDisk();
  const migrated = migratePrefs(_cache);
  if (migrated.applied.length === 0) return _cache;
  _cache = migrated.data;
  const fp = _getFilePath();
  // 未 init（fp 为 null）时只升内存：此时没有可信的落盘位置
  if (!fp) return _cache;
  try {
    atomicWriteJson(fp, _cache);
  } catch (e) {
    logger.warn('prefs: 迁移结果落盘失败（本次运行仍按新 schema）:', e.message);
  }
  return _cache;
}

function get(key, defaultValue) {
  const data = _load();
  const v = data[key] !== undefined ? data[key] : defaultValue;
  if (SECRET_KEYS.has(key) && typeof v === 'string') return secret.decrypt(v) || '';
  return v;
}

/**
 * 写入偏好。
 *
 * @returns {boolean} 是否真的写入（凭证键在安全存储不可用时会被拒绝并返回 false，
 *   调用方据此给用户可操作提示；普通键恒为 true）。
 */
function set(key, value) {
  _load();  // 确保 _cache 已初始化
  if (value === undefined || value === null) {
    delete _cache[key];
  } else if (SECRET_KEYS.has(key) && typeof value === 'string') {
    // 审计 P1：加密不可用/失败时**拒绝写入**，绝不把计费密钥明文落进 prefs.json。
    // 旧实现在这里直接透传明文，用户既看不到告警、文件里也是明文。
    let encrypted;
    try {
      encrypted = secret.encrypt(value);
    } catch (e) {
      logger.warn(`prefs: 拒绝保存凭证键 ${key}：`, e.message);
      return false;
    }
    _cache[key] = encrypted;
  } else {
    _cache[key] = value;
  }
  // 防抖 300ms 写盘（避免短时间内多次改）
  if (_writeTimer) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    try {
      const fp = _getFilePath();
      if (!fp) return;
      atomicWriteJson(fp, _cache || {});
    } catch (e) {
      logger.warn('prefs: 写入失败:', e.message);
    }
  }, 300);
  return true;
}

function flush() {
  // 立即同步写盘（退出时调用）
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  try {
    const fp = _getFilePath();
    if (!fp) return;
    atomicWriteJson(fp, _cache || {});
  } catch (e) {
    logger.warn('prefs: flush 失败:', e.message);
  }
}

/**
 * 释放资源（测试清理用）
 * 取消挂起的防抖写盘，避免在目录删除后还触发
 */
function destroy() {
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  _cache = null;
  _userDataPath = null;
}

module.exports = { init, get, set, getAll: _load, flush, destroy, SECRET_KEYS };
