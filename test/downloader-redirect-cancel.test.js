/**
 * 回归测试：重定向 DNS 校验等待期间到达的取消，不得再发起下一跳（L2）
 *
 * 缺陷形态（修复前）：重定向分支在 await assertPublicHttpUrl(nextUrl) 之后
 * 直接递归 downloadFile，从不检查 req._cancelled —— 用户在 DNS 等待窗口里
 * 取消时，下一跳照样被完整下载：带宽白花，取消语义失效。
 *
 * 手法：把 urlGuard.assertPublicHttpUrl 桩成闸门控制的 Promise
 * （require.cache 替换，bilibili.test.js 同款手法），让执行冻结在
 * DNS 等待里；先取消、再放行闸门，断言：
 *   1) Promise 以 cancelled 标拒绝
 *   2) 下一跳端点命中数为 0（修复前此断言红 —— 即便外层 Promise 恰好
 *      被 destroy 的错误路径先拒绝，递归传输仍会打到服务器）
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GUARD_PATH = require.resolve('../src/utils/urlGuard');
const realGuard = require(GUARD_PATH);
const { downloadFile, cancelDownload } = require('../src/utils/downloader');

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('downloadFile: 重定向 DNS 等待中取消 ⇒ 不发起下一跳，错误带 cancelled 标', async () => {
  const hits = { start: 0, final: 0 };
  const { server, url } = await startServer((req, res) => {
    if (req.url.startsWith('/start')) {
      hits.start++;
      res.writeHead(302, { Location: '/final' });
      res.end();
    } else {
      hits.final++;
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': 4 });
      res.end(Buffer.from('DATA'));
    }
  });

  let releaseDns;
  const dnsGate = new Promise((r) => { releaseDns = r; });
  let dnsCalls = 0;
  require.cache[GUARD_PATH].exports = {
    ...realGuard,
    assertPublicHttpUrl: async () => { dnsCalls++; await dnsGate; return { ok: true, ips: [] }; },
  };

  const savePath = path.join(os.tmpdir(), `dl-rc-${process.pid}.bin`);
  try {
    const pending = downloadFile(url + '/start', savePath, () => {}, {}, 0,
      { skipSsrfCheck: true, token: 'rc-token' });
    // 等执行冻结进重定向的 DNS 等待
    const t0 = Date.now();
    while (dnsCalls === 0) {
      if (Date.now() - t0 > 2000) throw new Error('未进入重定向 DNS 等待');
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.strictEqual(cancelDownload('rc-token'), true);
    releaseDns();
    await assert.rejects(pending, (e) => e.cancelled === true);
    await new Promise((r) => setTimeout(r, 150)); // 给（修复前的）递归传输留出到达服务器的时间
    assert.strictEqual(hits.final, 0, '取消后不得再发起下一跳下载');
  } finally {
    require.cache[GUARD_PATH].exports = realGuard;
    releaseDns();
    server.closeAllConnections();
    server.close();
    fs.rmSync(savePath, { force: true });
    fs.rmSync(savePath + '.tmp', { force: true });
  }
});