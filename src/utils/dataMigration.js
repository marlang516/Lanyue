/**
 * 数据迁移框架：prefs.json 与备份文件各有一套 schema 版本
 *
 * 为什么单独成模块（而不是塞进 prefs.js / cloudSync.js）：
 *   同一套迁移既要被启动路径（prefs._load）调用，也要被导入路径（cloudSync）
 *   调用，还得能被单元测试直接跑（node --test 不启 electron）。放进任一侧，
 *   另一侧就得 require 一个带 electron 依赖的模块，测试立刻没了。
 *   因此本模块是纯函数 + 零 IO：不读盘、不写盘、不 require electron。
 *
 * 版本号语义：
 *   - prefs.json 的 prefsVersion 描述"这份文件已经升到哪一版"，缺省 0；
 *   - 备份文件的 version 是导出时的 schema 版本，v1 时代没有这个字段。
 *
 * 迁移铁律：只许"加字段"和"改形状"，不许删用户数据。每一步都必须在脏数据上
 * 安全返回 —— 迁移跑在启动路径上，抛一次异常就等于用户打不开应用，而用户
 * 根本无从知道是哪个历史字段惹的祸。
 */

/** prefs.json 的 schema 版本（0 = 没有版本号的旧文件） */
const PREF_SCHEMA_VERSION = 1;
/** 备份文件的 schema 版本（1 = 无 version 字段 / 2 = 引入 data.prefs / 3 = 本次） */
const BACKUP_SCHEMA_VERSION = 3;

/** 只认"朴素对象"：数组、null、日期、类实例都不是 prefs/备份的合法形状 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 自身属性判断：`in` 会把原型链上的东西也认成"已存在"（原型污染下的坑） */
function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 深拷贝：迁移不能改调用方手里那份对象，否则 prefs._cache 与返回值会互相影响，
 * 幂等性也就无从谈起。备份只可能来自 JSON.parse，退化路径（JSON 往返）足够。
 */
function clone(value) {
  if (!isPlainObject(value) && !Array.isArray(value)) return value;
  try {
    return structuredClone(value);
  } catch (_) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_e) {
      return Array.isArray(value) ? [] : {};
    }
  }
}

/** 读 prefsVersion：缺失/非法/非正数一律 0（= 从未迁移过） */
function readPrefVersion(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** 读备份 version：缺失/非法一律 1（最早的备份格式没有 version 字段） */
function readBackupVersion(raw) {
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  const v = Math.floor(n);
  return v >= 1 ? v : 1;
}

/**
 * v0 → v1：EQ 形状搬家（嵌套对象 eqSettings → 平铺 eqPreset/eqGains）。
 *
 * v0 存的是 eqSettings:{preset,gains}，而播放器与设置页读的是平铺的
 * eqPreset/eqGains。这里只做"展开"，**不删 eqSettings**：备份导入侧的
 * legacy 分支还在读那个对象，删了等于让旧备份丢 EQ。
 *
 * @param {Object} data 已克隆的待迁移对象（原地修改）
 * @returns {Object} 同一个对象
 */
function _prefsV0ToV1(data) {
  const legacy = data.eqSettings;
  if (isPlainObject(legacy)) {
    // 已存在的平铺键优先：它是更新的读面，语义上比 eqSettings 靠后
    if (!own(data, 'eqPreset') && legacy.preset !== undefined) data.eqPreset = legacy.preset;
    if (!own(data, 'eqGains') && legacy.gains !== undefined) data.eqGains = legacy.gains;
  }
  // 非数组的 eqGains 是脏值（历史上出现过把单个数字当整条曲线写进去）。
  // 留着它等于给播放器喂一条不存在的曲线：要么 IPC 里炸，要么画出鬼影。
  // 删掉后 EQ 回落到默认曲线 —— 比"有一条坏曲线"更可解释。
  if (own(data, 'eqGains') && !Array.isArray(data.eqGains)) delete data.eqGains;
  data.prefsVersion = 1;
  return data;
}

/**
 * 把 prefs.json 的内存态升到 PREF_SCHEMA_VERSION。
 *
 * 幂等：对同一份输入连跑两次，第二次 applied 为空、data 深相等（第一次已是 v1）。
 *
 * @param {*} raw 从 prefs.json 读出的原始对象（可能是任何脏值）
 * @returns {{data: Object, fromVersion: number, toVersion: number, applied: string[]}}
 */
function migratePrefs(raw) {
  const fromVersion = isPlainObject(raw) ? readPrefVersion(raw.prefsVersion) : 0;
  const out = {
    data: {},
    fromVersion,
    toVersion: Math.max(fromVersion, PREF_SCHEMA_VERSION),
    applied: [],
  };
  // 脏入参（null/字符串/数组/数字）：给空对象，绝不抛 —— 调用方拿它当"没有偏好"
  if (!isPlainObject(raw)) return out;

  const data = clone(raw);
  // 空文件没有 schema 可升。刻意**不**在这里补写版本号：否则第一次 get 就会在
  // 盘上凭空造出一份 {"prefsVersion":1}，而这个键对任何读取方都没有意义。
  if (fromVersion === 0 && Object.keys(data).length === 0) {
    out.data = data;
    return out;
  }

  if (fromVersion < 1) {
    _prefsV0ToV1(data);
    out.applied.push('v0->v1');
  }
  out.data = data;
  return out;
}

/**
 * v1 → v2：EQ 从备份的 data 顶层搬进 data.prefs。
 *
 * v2 起备份只有一条偏好通道 data.prefs（导出侧全量 dump prefs.json），EQ 三键
 * 因此只住在那里。旧文件的顶层键**保留不删**：导入侧还有一段 legacy 分支专门
 * 认顶层 eqPreset/eqGains 与 eqSettings 对象，删掉等于让 v1 备份丢 EQ。
 *
 * @param {Object} payload 已克隆的备份对象（原地修改）
 */
function _backupV1ToV2(payload) {
  const data = payload.data;
  // 没有 data 的文件本就过不了格式校验，这里不替它补形状
  if (!isPlainObject(data)) return;

  const legacy = isPlainObject(data.eqSettings) ? data.eqSettings : null;
  const carried = {};
  if (own(data, 'eqPreset')) carried.eqPreset = data.eqPreset;
  else if (legacy && legacy.preset !== undefined) carried.eqPreset = legacy.preset;
  if (own(data, 'eqGains')) carried.eqGains = data.eqGains;
  else if (legacy && legacy.gains !== undefined) carried.eqGains = legacy.gains;
  if (own(carried, 'eqGains') && !Array.isArray(carried.eqGains)) delete carried.eqGains;
  if (own(data, 'eqBypass')) carried.eqBypass = data.eqBypass;
  if (Object.keys(carried).length === 0) return;

  if (!isPlainObject(data.prefs)) data.prefs = {};
  for (const [k, v] of Object.entries(carried)) {
    // prefs 里已有的值优先（v1 文件里的 prefs 只可能是用户手工加的）
    if (!own(data.prefs, k)) data.prefs[k] = v;
  }
}

/**
 * v2 → v3：把 data 的形状钉成"可直接消费"的样子。
 *
 * v2 的 data.prefs / userPlaylists / downloadTemplates 只是纸面约定：导出侧写
 * 什么就是什么，手改过或第三方生成的备份会把字符串塞进数组位。v3 把它们钉成
 * 具体类型。只改形状、不动值 —— 已经合法的数据一个字节都不许变。
 *
 * @param {Object} payload 已克隆的备份对象（原地修改）
 */
function _backupV2ToV3(payload) {
  const data = payload.data;
  if (!isPlainObject(data)) return;

  // prefs 必须是普通对象：导入侧对 data.prefs 做 Object.entries 遍历，
  // 数组/字符串都会让白名单通道静默空转
  if (!isPlainObject(data.prefs)) data.prefs = {};

  // 非数组的列表值留不得：导入侧 Array.isArray 会静默跳过，用户看到的只是
  // "歌单没恢复"。删掉至少让"这份备份不完整"可查，而不是伪装成空列表。
  for (const key of ['userPlaylists', 'downloadTemplates']) {
    if (own(data, key) && !Array.isArray(data[key])) delete data[key];
  }

  // prefs 内部可能还躺着 v0 形状（eqSettings 对象 / 脏 eqGains），用同一套规则
  // 再走一遍。applied 为空说明本来就是合法数据，原样不动。
  const migrated = migratePrefs(data.prefs);
  if (migrated.applied.length) {
    // prefsVersion 是 prefs.json 的文件级标记，不该跟着备份文件传播
    delete migrated.data.prefsVersion;
    data.prefs = migrated.data;
  }
}

/**
 * 把备份文件升到 BACKUP_SCHEMA_VERSION。
 *
 * 与 prefs 不同，备份是外部文件：绝不能因为版本号不认识就当成"坏文件"，
 * 但也绝不能硬改未来版本 —— 那里面可能有我们完全不懂的字段，动一下就是
 * 销毁证据。所以只有"过新"才整体拒绝，其余一律按最近的可识别版本往上推。
 *
 * @param {*} payload JSON.parse 出来的备份对象
 * @returns {{payload: *, fromVersion: number, toVersion: number, applied: string[], skipped: boolean}}
 */
function migrateBackup(payload) {
  // 脏入参：交回空对象，让调用方走"文件格式无效"的友好报错，而不是在这里抛 TypeError
  if (!isPlainObject(payload)) {
    return {
      payload: {},
      fromVersion: 0,
      toVersion: BACKUP_SCHEMA_VERSION,
      applied: [],
      skipped: false,
    };
  }

  const fromVersion = readBackupVersion(payload.version);
  const out = {
    payload: clone(payload),
    fromVersion,
    toVersion: fromVersion, // 未真正升级前，"升到哪一版"就等于原版本
    applied: [],
    skipped: false,
  };

  if (fromVersion > BACKUP_SCHEMA_VERSION) {
    out.skipped = true;
    return out;
  }

  let v = fromVersion;
  if (v < 2) {
    _backupV1ToV2(out.payload);
    v = 2;
    out.applied.push('v1->v2');
  }
  if (v < 3) {
    _backupV2ToV3(out.payload);
    v = 3;
    out.applied.push('v2->v3');
  }

  out.payload.version = BACKUP_SCHEMA_VERSION;
  out.toVersion = BACKUP_SCHEMA_VERSION;
  return out;
}

module.exports = {
  PREF_SCHEMA_VERSION,
  BACKUP_SCHEMA_VERSION,
  migratePrefs,
  migrateBackup,
};