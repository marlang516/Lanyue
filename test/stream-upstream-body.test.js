/**
 * 在线播放的响应体必须跟完上游，不能把「这一拍还没数据」当成 EOF。
 *
 * 旧 create 内联 Readable 在 res.read() 返回 null 时 push(null)。
 * IncomingMessage 的 null 只表示缓冲区空：本地复现里，先写 5 字节、
 * 80ms 后再写剩余的响应，消费端只拿到第一段；按 20ms 节奏写 200KB
 * 时只拿到第一个 16KB 高水位。在线歌因此播一两秒就停，seek 同样截断。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createUpstreamBody } = require('../src/main/streamProtocol');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }),
      });
    });
  });
}

function collect(body) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    body.on('data', (c) => chunks.push(c));
    body.on('end', () => resolve(Buffer.concat(chunks)));
    body.on('error', reject);
  });
}

function getBody(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/' }, (res) => {
      collect(createUpstreamBody(res, 200 * 1024 * 1024)).then(resolve, reject);
    });
    req.on('error', reject);
  });
}

test('延迟到达的第二段必须进播放流，不能在第一段后结束', async () => {
  const part1 = Buffer.from('PART1');
  const part2 = Buffer.from('PART2-DELAYED!!');
  const whole = Buffer.concat([part1, part2]);
  const srv = await serve((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(whole.length),
    });
    res.write(part1);
    setTimeout(() => res.end(part2), 80);
  });
  try {
    const got = await getBody(srv.port);
    assert.deepStrictEqual(got, whole);
  } finally {
    await srv.close();
  }
});

test('大于套接字高水位的响应必须收齐，不能停在第一块', async () => {
  const total = 200 * 1024;
  const srv = await serve((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(total),
    });
    let sent = 0;
    const tick = () => {
      if (sent >= total) { res.end(); return; }
      const n = Math.min(8 * 1024, total - sent);
      sent += n;
      if (!res.write(Buffer.alloc(n, 7))) res.once('drain', () => setTimeout(tick, 5));
      else setTimeout(tick, 5);
    };
    tick();
  });
  try {
    const got = await getBody(srv.port);
    assert.strictEqual(got.length, total);
    assert.ok(got.every((b) => b === 7));
  } finally {
    await srv.close();
  }
});

test('超过单次体积上限时停止继续拉，且已经推出的前缀仍可消费', async () => {
  const cap = 1000;
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.write(Buffer.alloc(400, 3));
    setTimeout(() => {
      res.write(Buffer.alloc(400, 3));
      setTimeout(() => res.end(Buffer.alloc(4000, 3)), 40);
    }, 40);
  });
  try {
    const got = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: srv.port, path: '/' }, (res) => {
        collect(createUpstreamBody(res, cap)).then(resolve, reject);
      });
      req.on('error', reject);
    });
    assert.ok(got.length > 0 && got.length <= cap, `应保留未超限的前缀，实际 ${got.length}`);
    assert.ok(got.every((b) => b === 3));
  } finally {
    await srv.close();
  }
});
