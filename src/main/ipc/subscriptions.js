/**
 * 订阅更新 IPC
 *
 * 注册：subscribe-list / subscribe-add / subscribe-remove /
 *       subscribe-update / subscribe-check / subscribe-mark-seen
 *
 * 全部逻辑在 main/subscriptions.js，这里只做参数转发与结果包装。
 *
 * 构造注入：register(deps = {})，deps.subscriptions 为订阅服务实例；
 * 无参时回退到默认单例（兼容 test/mcp-e2e.test.js 的 register() 无参调用）。
 */

const { handle } = require('./register');
const { createSubscriptions } = require('../subscriptions');

/**
 * @param {object} [deps]
 * @param {object} [deps.subscriptions] 订阅服务实例（缺省 createSubscriptions() 默认单例）
 */
function register(deps = {}) {
  const subs = deps.subscriptions || createSubscriptions();

  handle('subscribe-list', () => subs.list());

  handle('subscribe-add', (_, type, platform, targetId, name) => subs.add(type, platform, targetId, name));

  handle('subscribe-remove', (_, key) => subs.remove(key));

  handle('subscribe-update', (_, key, patch) => subs.update(key, patch));

  handle('subscribe-check', async () => subs.checkNow());

  handle('subscribe-mark-seen', (_, key) => subs.markSeen(key));
}

module.exports = { register };
