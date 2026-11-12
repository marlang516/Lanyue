/**
 * M6：req.setTimeout 是 socket「空闲超时」，不是「等第一个字节」的时限。
 *
 * 原实现给 req 设 30s 后从不解除：响应头到达后，下游背压（Chromium 缓冲满 /
 * 用户暂停播放）一旦停读 30 秒，socket 无活动 → 空闲定时器照样触发 →
 * req.destroy 掐断一条完全健康的连接。
 *
 * 实测复现（本地探针，2026-11-12）：8ms 收到响应头，res.pause() 模拟停读，
 * 30011ms 时 res aborted / destroyed=true —— 暂停播放超 30 秒必断流。
 *
 * 修复契约：看门狗只守「等第一个字节」阶段，响应一到达就必须解除
 * （socket.timeout === 0）。此后上游何时再发数据由 Chromium 的缓冲与
 * Range 重取负责，不该被这个定时器掐断。30 秒级的真实断流已由探针验证，
 * 这里钉住机制本身，避免回归测试再等 30 秒。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { requestUpstream } = require('../src/main/streamProtocol');

test('响应到达后必须解除空闲看门狗（暂停播放超 30 秒不得断流）', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(10 * 1024 * 1024),
    });
    res.write(Buffer.alloc(1024)); // 首字节已到，之后保持连接但不再发数据
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const u = new URL(`http://127.0.0.1:${port}/song.mp3`);
    const res = await requestUpstream(u, ['127.0.0.1'], '', null);
    res.pause(); // 模拟 Chromium 缓冲满 / 用户暂停 → 停止读取
    assert.strictEqual(
      res.socket.timeout, 0,
      '响应到达后看门狗必须解除，否则停读超 30 秒会掐断健康的流',
    );
    res.destroy();
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  }
});