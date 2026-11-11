/**
 * 守卫：postbuild 必须把 src/main 下后拆出去的目录一并拷进 dist。
 *
 * Vite 构建主进程只压缩 dist/main/index.js（实测 1 module），本地 require
 * 原样留在产物里。运行时 `require('./downloadQueue')` 落到 postbuild 拷贝的
 * 源文件，再 `require('./downloadQueue/statemachine')`。目录若不在 dist，
 * 打包后启动即 MODULE_NOT_FOUND；开发态走 src/，看不出来。
 *
 * 2026-09 mcp/ 拆目录后靠往手工名单加一行才修好（5495360）。downloadQueue/
 * 是同一种漏法。判据因此不点名某个目录：src/main 的每个子目录都要进 dist，
 * 包括测试夹具里一个源码名单不可能写到的名字。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planMainRuntimeCopies, runPostbuild } = require('../scripts/postbuild');
const { extractRelativeRequires, resolveRequest } = require('../scripts/check-require-paths.cjs');

const ROOT = path.resolve(__dirname, '..');

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postbuild-copy-'));
  writeFile(root, 'src/main/index.js', 'module.exports = {};\n');
  writeFile(root, 'src/main/preload.js', 'module.exports = {};\n');
  writeFile(root, 'src/main/helper.js', 'module.exports = {};\n');
  writeFile(root, 'src/main/notes.md', 'not runtime\n');
  writeFile(root, 'src/main/ipc/register.js', 'module.exports = {};\n');
  writeFile(root, 'src/main/mcp/mcpServer.js', 'module.exports = {};\n');
  writeFile(root, 'src/main/downloadQueue.js', "require('./downloadQueue/statemachine');\n");
  writeFile(root, 'src/main/downloadQueue/statemachine.js', 'module.exports = {};\n');
  writeFile(root, 'src/main/futureSplit/nested/worker.js', 'module.exports = {};\n');
  return root;
}

function listMainDirs(mainDir) {
  return fs
    .readdirSync(mainDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test('夹具：未写进名单的子目录也要拷贝，Vite 入口不覆盖', () => {
  const root = makeFixture();
  const dist = path.join(root, 'dist');
  try {
    runPostbuild({ root, dist });
    const mainOut = path.join(dist, 'main');
    assert.equal(
      fs.existsSync(path.join(mainOut, 'futureSplit', 'nested', 'worker.js')),
      true,
      '后拆出的目录必须整棵进 dist，不能靠手工点名'
    );
    assert.equal(fs.existsSync(path.join(mainOut, 'downloadQueue', 'statemachine.js')), true);
    assert.equal(fs.existsSync(path.join(mainOut, 'ipc', 'register.js')), true);
    assert.equal(fs.existsSync(path.join(mainOut, 'mcp', 'mcpServer.js')), true);
    assert.equal(fs.existsSync(path.join(mainOut, 'helper.js')), true);
    assert.equal(
      fs.existsSync(path.join(mainOut, 'index.js')),
      false,
      'index.js 由 Vite 产出，postbuild 不得用源码覆盖'
    );
    assert.equal(
      fs.existsSync(path.join(mainOut, 'preload.js')),
      false,
      'preload.js 由 Vite 产出到 dist/preload'
    );
    assert.equal(fs.existsSync(path.join(mainOut, 'notes.md')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('真实仓库：src/main 的每个子目录都在拷贝计划里', () => {
  const mainDir = path.join(ROOT, 'src', 'main');
  const planned = planMainRuntimeCopies(mainDir)
    .filter((item) => item.kind === 'dir')
    .map((item) => item.name)
    .sort();
  assert.deepEqual(planned, listMainDirs(mainDir));
  assert.ok(planned.includes('downloadQueue'));
});

test('真实仓库：postbuild 之后主进程相对 require 都能落到 dist', () => {
  // 打包后的布局是 <app>/package.json + <app>/dist。ipc/index.js 的
  // require('../../../package.json') 靠的就是这层，临时 dist 必须同样摆。
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postbuild-app-'));
  const dist = path.join(appRoot, 'dist');
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(appRoot, 'package.json'));
  try {
    runPostbuild({ root: ROOT, dist });
    const copiedQueue = path.join(dist, 'main', 'downloadQueue', 'statemachine.js');
    assert.equal(fs.existsSync(copiedQueue), true, 'dist/main/downloadQueue/ 缺失');
    assert.equal(
      fs.existsSync(path.join(dist, 'shared', 'playReferer.mjs')),
      true,
      '渲染层与主进程共用的 .mjs 必须进 dist，否则打包后 require 找不到'
    );
    assert.equal(fs.existsSync(path.join(dist, 'shared', 'altSource.mjs')), true);
    assert.equal(fs.existsSync(path.join(dist, 'shared', 'fileUrl.mjs')), true);

    const missing = [];
    const mainOut = path.join(dist, 'main');
    const files = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    })(mainOut);
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const item of extractRelativeRequires(src)) {
        if (!resolveRequest(file, item.request)) {
          missing.push(`${path.relative(dist, file)} -> ${item.request}`);
        }
      }
    }
    assert.deepEqual(missing, [], `拷贝后仍解析不到：\n${missing.join('\n')}`);
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});
