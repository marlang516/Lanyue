/**
 * 回归测试：request() 的响应体 UTF-8 解码
 *
 * 缺陷形态（修复前）：`res.on('data', chunk => data += chunk)` 对每个 TCP
 * 分块各自 toString('utf8')。一个 3 字节汉字被拆到两个分块时，两半各自
 * 解码成 U+FFFD —— 所有平台的中文歌名/歌手名/歌词都会随机损坏，且
 * JSON.parse 失败后还会把坏字符串当 body 透传给调用方。
 *
 * 判据：让本机 server 故意在一个多字节字符中间切刀、延迟 30ms 再发后半段
 * （确保两次 write 落成两个独立分块），request() 必须还原出完整文本。
 * 若生产代码退回「逐块字符串拼接」（去掉 setEncoding/Buffer.concat），
 * 本文件两条用例都会红。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const request = require('../src/api/request');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/** 在 buf 中 needle 字符串的首个字符中间切一刀（第 1 字节之后） */
function splitInsideChar(buf, needle) {
  const idx = buf.indexOf(Buffer.from(needle, 'utf8'));
  assert.ok(idx >= 0, '测试数据里必须包含目标字符');
  return idx + 1;
}

test('request: JSON 响应中的汉字跨 TCP 分块到达时不被解码损坏', async () => {
  const payload = JSON.stringify({ title: '晴天', artist: '周杰伦' });
  const buf = Buffer.from(payload, 'utf8');
  const splitAt = splitInsideChar(buf, '晴');

  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.write(buf.subarray(0, splitAt));
    setTimeout(() => res.end(buf.subarray(splitAt)), 30);
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 0, timeout: 5000, skipSsrf: true });
    assert.deepStrictEqual(result, { title: '晴天', artist: '周杰伦' });
  } finally {
    server.close();
  }
});

test('request: 非 JSON 文本响应跨分块的汉字同样完整透传', async () => {
  const text = '服务器返回了一段中文错误说明';
  const buf = Buffer.from(text, 'utf8');
  const splitAt = splitInsideChar(buf, '错');

  const { server, port } = await startServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.write(buf.subarray(0, splitAt));
    setTimeout(() => res.end(buf.subarray(splitAt)), 30);
  });
  try {
    const result = await request(`http://127.0.0.1:${port}/`, { retries: 0, timeout: 5000, skipSsrf: true });
    assert.strictEqual(result, text);
  } finally {
    server.close();
  }
});