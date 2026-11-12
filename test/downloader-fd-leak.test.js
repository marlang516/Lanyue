/**
 * 回归测试：downloadFile 失败/取消时必须释放写流句柄（H2）
 *
 * 缺陷形态（修复前）：failTransfer / req error / req timeout 只 reject，
 * 从不 destroy writeStream —— 每次失败/取消泄漏一个 fd，Windows 上 .tmp
 * 还处于 pending-delete 占用态。批量下载反复失败时句柄攒到 EMFILE。
 *
 * 判据：包一层 fs.createWriteStream 捕获真实流实例，失败后断言
 *   1) 流已 destroyed（fd 已释放）—— 修复前为 false，本断言红
 *   2) .tmp 前缀仍在（断点续传契约，destroy 不得删文件）
 * 若生产代码去掉失败路径上的 writeStream.destroy()，用例 1/2 都会红；
 * 若改成 destroy 时连带删 .tmp，续传断言会红。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadFile, cancelDownload } = require('../src/utils/downloader');

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function tmpFile(name) {
  return path.join(os.tmpdir(), `dl-fd-${process.pid}-${name}`);
}

const OPTS = { skipSsrfCheck: true };

/** 捕获本次测试创建的所有写流（真实流，仅记录引用） */
function captureWriteStreams() {
  const orig = fs.createWriteStream;
  const streams = [];
  fs.createWriteStream = (...args) => {
    const s = orig.apply(fs, args);
    streams.push(s);
    return s;
  };
  return { streams, restore: () => { fs.createWriteStream = orig; } };
}

test('downloadFile: 传输中断后写流句柄必须释放，且 .tmp 前缀保留供续传', async () => {
  const part1 = Buffer.alloc(16 * 1024, 0xAA);
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': 64 * 1024 });
    res.write(part1);
    setTimeout(() => res.socket.destroy(), 30);
  });
  const savePath = tmpFile('reset.bin');
  const cap = captureWriteStreams();
  try {
    await assert.rejects(
      downloadFile(url + '/f.mp3', savePath, () => {}, {}, 0, OPTS),
      /ECONNRESET|aborted|socket/i,
    );
    assert.strictEqual(cap.streams.length, 1, '应恰好创建一个写流');
    assert.strictEqual(cap.streams[0].destroyed, true, '失败后写流必须被 destroy（fd 释放）');
    assert.ok(fs.existsSync(savePath + '.tmp'), '.tmp 必须保留（续传依赖残留前缀）');
    assert.ok(fs.readFileSync(savePath + '.tmp').equals(part1), '前缀内容应完整');
  } finally {
    cap.restore();
    server.close();
    fs.rmSync(savePath, { force: true });
    fs.rmSync(savePath + '.tmp', { force: true });
  }
});

test('downloadFile: 用户取消后写流句柄必须释放，错误带 cancelled 标', async () => {
  const part1 = Buffer.alloc(16 * 1024, 0xBB);
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': 64 * 1024 });
    res.write(part1);
    // 保持连接不结束，等用户取消
  });
  const savePath = tmpFile('cancel.bin');
  const cap = captureWriteStreams();
  let firstProgress = null;
  const gotProgress = new Promise(r => { firstProgress = r; });
  try {
    const pending = downloadFile(url + '/f.mp3', savePath, () => firstProgress(), {}, 0,
      { ...OPTS, token: 'fd-test-token' });
    await gotProgress; // 确保写流已创建、首段已落盘
    assert.strictEqual(cancelDownload('fd-test-token'), true);
    await assert.rejects(pending, (e) => e.cancelled === true);
    assert.strictEqual(cap.streams.length, 1);
    assert.strictEqual(cap.streams[0].destroyed, true, '取消后写流必须被 destroy（fd 释放）');
    assert.ok(fs.existsSync(savePath + '.tmp'), '取消后 .tmp 保留（可续传）');
  } finally {
    cap.restore();
    server.close();
    fs.rmSync(savePath, { force: true });
    fs.rmSync(savePath + '.tmp', { force: true });
  }
});