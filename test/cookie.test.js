/**
 * 单元测试：utils/cookie.js
 *
 * 跑：npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  pickCookieField,
  hasCookieField,
  hasCookieValue,
  extractQQUin,
  normalizeQQMusicId,
  extractQQMusickey,
  normalizeQQCookie,
  detectQQCookieType,
} = require('../src/utils/cookie');

test('pickCookieField: 抽取第一个命中的字段', () => {
  const cookie = 'a=1; b=2; c=3';
  assert.strictEqual(pickCookieField(cookie, 'a'), '1');
  assert.strictEqual(pickCookieField(cookie, 'c'), '3');
  assert.strictEqual(pickCookieField(cookie, 'b', 'c'), '2');
  assert.strictEqual(pickCookieField(cookie, 'qm_keyst', 'qqmusic_key'), '');
});

test('pickCookieField: 跳过空格', () => {
  const cookie = 'a=1;  b=2 ;c=3';
  assert.strictEqual(pickCookieField(cookie, 'b'), '2');
});

test('pickCookieField: null/空安全', () => {
  assert.strictEqual(pickCookieField(null, 'a'), '');
  assert.strictEqual(pickCookieField('', 'a'), '');
  assert.strictEqual(pickCookieField(undefined, 'a'), '');
});

test('hasCookieField: 检测字段是否存在', () => {
  assert.strictEqual(hasCookieField('a=1; b=2', 'a'), true);
  assert.strictEqual(hasCookieField('a=1; b=2', 'c'), false);
});

test('hasCookieValue: 检测字段值是否等于给定字符串', () => {
  assert.strictEqual(hasCookieValue('tmeLoginType=1', 'tmeLoginType', '1'), true);
  assert.strictEqual(hasCookieValue('tmeLoginType=1', 'tmeLoginType', '2'), false);
});

test('extractQQUin: 支持 uin 和 wxuin', () => {
  assert.strictEqual(extractQQUin('uin=12345; other=1'), '12345');
  assert.strictEqual(extractQQUin('wxuin=o67890; other=1'), 'o67890');
  // uin 优先
  assert.strictEqual(extractQQUin('wxuin=o67890; uin=12345; x=1'), '12345');
  assert.strictEqual(extractQQUin('notfound=1'), '');
});

test('extractQQMusickey: qm_keyst 优先于 qqmusic_key', () => {
  const cookie1 = 'qm_keyst=key1; qqmusic_key=key2';
  assert.strictEqual(extractQQMusickey(cookie1), 'key1');
  const cookie2 = 'qqmusic_key=key2; other=1';
  assert.strictEqual(extractQQMusickey(cookie2), 'key2');
  assert.strictEqual(extractQQMusickey('notfound=1'), '');
});

test('normalizeQQCookie: wxuin → uin', () => {
  const input  = 'wxuin=12345; other=1';
  const output = 'uin=12345; other=1';
  assert.strictEqual(normalizeQQCookie(input), output);
});

test('normalizeQQMusicId: 去掉 wxuin 的前导 o，保留纯数字 QQ 号', () => {
  assert.strictEqual(normalizeQQMusicId('o115292150478421314'), '115292150478421314');
  assert.strictEqual(normalizeQQMusicId('123456789'), '123456789');
  assert.strictEqual(normalizeQQMusicId('0'), '0');
  assert.strictEqual(normalizeQQMusicId(''), '');
});

test('detectQQCookieType: QQ 号登录（tmeLoginType=2 或 Q_H_L_ 前缀）', () => {
  const byField = detectQQCookieType('uin=12345; qqmusic_key=key1; tmeLoginType=2');
  assert.strictEqual(byField.isQQLogin, true);
  assert.strictEqual(byField.isWechatLogin, false);
  assert.strictEqual(byField.tmeLoginType, 2);
  assert.strictEqual(byField.musicId, '12345');
  assert.deepStrictEqual(byField.missing, []);

  // 密钥前缀优先于数字字段：Q_H_L_ 即使 cookie 写了 tmeLoginType=1 也是 QQ
  const byKey = detectQQCookieType('uin=12345; qm_keyst=Q_H_L_secret; tmeLoginType=1');
  assert.strictEqual(byKey.isQQLogin, true);
  assert.strictEqual(byKey.tmeLoginType, 2);
});

test('detectQQCookieType: 没有类型字段的 QQ 号 cookie 仍走 QQ', () => {
  const d = detectQQCookieType('uin=123456789; qm_keyst=SECRET_KEY_VALUE');
  assert.strictEqual(d.isQQLogin, true);
  assert.strictEqual(d.isWechatLogin, false);
  assert.strictEqual(d.tmeLoginType, 2);
  assert.strictEqual(d.musicId, '123456789');
});

test('detectQQCookieType: 微信登录（tmeLoginType=1、W_X 前缀、wxuin）', () => {
  const byField = detectQQCookieType('uin=115292150478421314; qqmusic_key=key1; tmeLoginType=1');
  assert.strictEqual(byField.isQQLogin, false);
  assert.strictEqual(byField.isWechatLogin, true);
  assert.strictEqual(byField.tmeLoginType, 1);

  // wxuin 比跳转页遗留的 login_type=2 更强（那个 2 是微信二维码页的 query，不是会话）
  const byWxuin = detectQQCookieType('wxuin=o12345; qqmusic_key=key1; login_type=2');
  assert.strictEqual(byWxuin.isWechatLogin, true);
  assert.strictEqual(byWxuin.isQQLogin, false);
  assert.strictEqual(byWxuin.musicId, '12345');
  assert.strictEqual(byWxuin.uin, 'o12345');

  // 只有 login_type=2、没有微信字段时，按会话字段算 QQ
  const redirectOnly = detectQQCookieType('uin=12345; qqmusic_key=key1; login_type=2');
  assert.strictEqual(redirectOnly.isQQLogin, true);
  assert.strictEqual(redirectOnly.isWechatLogin, false);

  // W_X 前缀压过 cookie 里写成 2 的数字
  const byKey = detectQQCookieType('uin=115292150478421314; qm_keyst=W_X_secret; tmeLoginType=2');
  assert.strictEqual(byKey.isWechatLogin, true);
  assert.strictEqual(byKey.tmeLoginType, 1);
  assert.strictEqual(byKey.musicId, '115292150478421314');
});

test('detectQQCookieType: 缺关键字段时记入 missing', () => {
  const d = detectQQCookieType('foo=bar');
  assert.strictEqual(d.isQQLogin, false);
  assert.strictEqual(d.isWechatLogin, false);
  assert.ok(d.missing.includes('uin (或wxuin)'));
  assert.ok(d.missing.includes('qqmusic_key'));
});
