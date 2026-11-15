/**
 * Cookie 工具函数
 *
 * 集中所有"从 cookie 字符串里抽字段"的逻辑，避免在每个平台实现里重复正则，
 * 也避免之前那种"误把 boolean 当字符串发给服务器"的 bug 再次发生。
 */

/**
 * 从 cookie 字符串里按候选字段名顺序抽取第一个非空值
 *
 * @param {string} cookie - 形如 "a=1; b=2; c=3" 的 cookie 字符串
 * @param  {...string} names - 候选字段名，按优先级顺序
 * @returns {string} 命中的字段值（去首尾空格），没命中返回空串
 *
 * @example
 *   pickCookieField(cookie, 'qm_keyst', 'qqmusic_key')
 *   // 优先取 qm_keyst，没有则取 qqmusic_key，都没有则返回 ''
 */
function pickCookieField(cookie, ...names) {
  if (!cookie || typeof cookie !== 'string') return '';
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?:^|;\\s*)' + escaped + '=([^;]*)');
    const m = cookie.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

/**
 * 检查 cookie 字符串里是否包含某个字段
 *
 * @param {string} cookie
 * @param {string} name
 * @returns {boolean}
 */
function hasCookieField(cookie, name) {
  return pickCookieField(cookie, name) !== '';
}

/**
 * 检查 cookie 字符串里是否包含某个字段，且值等于给定字符串
 *
 * @param {string} cookie
 * @param {string} name
 * @param {string} value
 * @returns {boolean}
 */
function hasCookieValue(cookie, name, value) {
  if (!cookie || !name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|;\\s*)' + escaped + '=' + value);
  return re.test(cookie);
}

/**
 * 把 wxuin 改名为 uin（让 qq-music-api 库能识别）
 * QQ 音乐 Cookie 常见两种 uin：
 *   1) uin=12345        （纯数字，PC QQ 登录）
 *   2) wxuin=o12345     （带 o 前缀，扫码/微信开放平台登录）
 *
 * @param {string} cookie
 * @returns {string}
 */
function normalizeQQCookie(cookie) {
  if (!cookie) return '';
  return cookie
    .replace(/(^|;)\s*wxuin=/g, '$1uin=')  // wxuin → uin
    .replace(/;\s*wxuin=/g, ';uin=');      // 重复 wxuin
}

/**
 * 提取 QQ uin（支持 uin / wxuin 两种字段）
 *
 * @param {string} cookie
 * @returns {string}
 */
function extractQQUin(cookie) {
  // 同时取 uin 和 wxuin，优先 uin。wxuin 可能带前导 o，原样返回。
  return pickCookieField(cookie, 'uin', 'wxuin');
}

/**
 * 把 cookie 里的账号字段收成 musicid。
 * wxuin 的前导 o 不是账号编号；再去掉多余的前导 0，只剩 0 时保留 0。
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeQQMusicId(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';
  if (/^o\d+$/.test(s)) s = s.slice(1);
  s = s.replace(/^0+(?=\d)/, '');
  return s;
}

/**
 * 提取 QQ 音乐 musickey
 * 优先级与 qq-music-api /refresh 一致：qm_keyst 优先，其次 qqmusic_key
 *
 * @param {string} cookie
 * @returns {string}
 */
function extractQQMusickey(cookie) {
  return pickCookieField(cookie, 'qm_keyst', 'qqmusic_key');
}

/**
 * 把新的 musickey（qm_keyst / qqmusic_key）写回 Cookie 字符串
 * 用于验证 QQ Cookie 后刷新音乐密钥
 *
 * @param {string} cookieStr - 原 cookie 字符串
 * @param {string} newKey - 新的 musickey 值
 * @returns {string|null} 更新后的 cookie 字符串，参数无效返回 null
 */
function refreshQQMusickey(cookieStr, newKey) {
  if (!cookieStr || !newKey) return null;
  const hasQM = /(^|;\s*)qm_keyst=/.test(cookieStr);
  const hasQMK = /(^|;\s*)qqmusic_key=/.test(cookieStr);
  let out = cookieStr;
  if (hasQM) out = out.replace(/(^|;\s*)qm_keyst=[^;]*/g, `$1qm_keyst=${newKey}`);
  else out += `; qm_keyst=${newKey}`;
  if (hasQMK) out = out.replace(/(^|;\s*)qqmusic_key=[^;]*/g, `$1qqmusic_key=${newKey}`);
  else out += `; qqmusic_key=${newKey}`;
  return out;
}

/**
 * 检测 QQ Cookie 登录类型
 *
 * @param {string} cookie
 * @returns {{
 *   fields: Record<string, boolean>,
 *   isQQLogin: boolean,
 *   isWechatLogin: boolean,
 *   hasUin: boolean,
 *   uin: string,
 *   musicId: string,
 *   musickey: string,
 *   tmeLoginType: 0 | 1 | 2,
 *   missing: string[]
 * }}
 */
function detectQQCookieType(cookie) {
  const fields = {
    uin: hasCookieField(cookie, 'uin'),
    wxuin: hasCookieField(cookie, 'wxuin'),
    qqmusic_key: hasCookieField(cookie, 'qqmusic_key'),
    qm_keyst: hasCookieField(cookie, 'qm_keyst'),
    vkey: hasCookieField(cookie, 'vkey'),
    guid: hasCookieField(cookie, 'guid'),
    wxopenid: hasCookieField(cookie, 'wxopenid'),
    wxunionid: hasCookieField(cookie, 'wxunionid'),
    wxrefresh_token: hasCookieField(cookie, 'wxrefresh_token'),
    p_skey: hasCookieField(cookie, 'p_skey'),
    skey: hasCookieField(cookie, 'skey'),
  };

  // 发给 comm.tmeLoginType 的值：1 = 微信，2 = QQ。
  // 换票请求和登录成功后写入的 cookie 都是这个方向（ylw1997 wx-login、
  // whatsqqmusic 会话字段、sansenjian 微信登录 cookie 均为 tmeLoginType=1；
  // QQ 换票覆盖 "2"）。musickey 以 W_X 开头视为微信，Q_H_L 开头视为 QQ；
  // whatsqqmusic 的 login_with_cookie 只信这个前缀，不信 cookie 里的数字。
  // y.qq.com 扫码页跳转参数相反：微信二维码是 wx_redirect.html?login_type=2，
  // QQ OAuth 是 login_type=1。那是页面参数，不是会话 cookie。
  // 本文件旧注释把 tmeLoginType=1 当成 QQ，仓库里没有抓到的 cookie 能支持它。
  const musickey = extractQQMusickey(cookie);
  const hasWxIdentity = fields.wxuin || fields.wxopenid || fields.wxunionid || fields.wxrefresh_token;
  const typeField = pickCookieField(cookie, 'tmeLoginType', 'login_type');

  let isWechatLogin = false;
  let isQQLogin = false;
  if (musickey.startsWith('W_X')) isWechatLogin = true;
  else if (musickey.startsWith('Q_H_L')) isQQLogin = true;
  else if (hasWxIdentity) isWechatLogin = true;
  else if (typeField === '1') isWechatLogin = true;
  else if (typeField === '2') isQQLogin = true;

  const uin = extractQQUin(cookie);
  const musicId = normalizeQQMusicId(pickCookieField(cookie, 'uin', 'qqmusic_uin', 'wxuin'));
  const loggedIn = musicId !== '' && musicId !== '0';
  if (!isWechatLogin && !isQQLogin && loggedIn) isQQLogin = true;

  const missing = [];
  if (!loggedIn) missing.push('uin (或wxuin)');
  if (!fields.qqmusic_key && !fields.qm_keyst) missing.push('qqmusic_key');

  return {
    fields,
    isQQLogin,
    isWechatLogin,
    hasUin: loggedIn,
    uin,
    musicId,
    musickey,
    tmeLoginType: isWechatLogin ? 1 : (isQQLogin ? 2 : 0),
    missing,
  };
}

module.exports = {
  pickCookieField,
  hasCookieField,
  hasCookieValue,
  normalizeQQCookie,
  extractQQUin,
  normalizeQQMusicId,
  extractQQMusickey,
  refreshQQMusickey,
  detectQQCookieType,
};
