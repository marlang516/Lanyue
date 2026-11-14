/**
 * 测试用的「可信主窗口」sender
 *
 * register.js 的 IPC 包装器现在会过来源闸（src/main/ipc/senderTrust.js）：
 * 未登记的 webContents 一律拒绝。直调 `handlers.get(ch)(event, ...)` 的测试
 * 必须带一个已登记的主窗口事件，否则拿到的是信封化的拒绝而不是业务结果。
 *
 * 用法：`const { event: TEST_EVENT } = require('./helpers/ipcTrust').install();`
 */
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const senderTrust = require('../../src/main/ipc/senderTrust');

let _seq = 400;

function install() {
  senderTrust.configure({ appPath: process.cwd() });
  const frame = {
    url: pathToFileURL(path.join(process.cwd(), 'dist/renderer/index.html')).href,
    parent: null,
  };
  const webContents = { id: _seq++, isDestroyed: () => false, mainFrame: frame };
  senderTrust.trust(webContents, 'main');
  return { webContents, frame, event: { sender: webContents, senderFrame: frame } };
}

module.exports = { install };
