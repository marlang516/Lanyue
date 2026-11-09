/**
 * 静态 require 路径门禁 · 自测 + 仓库体检
 *
 * 两类断言：
 *   ① 真实仓库：scripts/check-require-paths.cjs 判定 UNRESOLVED === 0；
 *   ② 扫描器自测：合成一个含错路径的临时目录，必须被逮到（防假绿），
 *      并验证注释 / 字符串里的 `require('./x')` 不会被当成真引用。
 *
 * 直接调用导出的纯函数，不启子进程 —— 判据与 CLI 完全同源。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveAll, scanRequirePaths } = require('../scripts/check-require-paths.cjs');

const ROOT = path.resolve(__dirname, '..');

/** 建一个临时「仓库」：root/src/…，返回 root */
function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'require-path-scan-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('真实仓库：全部相对 require 均可静态解析', () => {
  const result = resolveAll(ROOT);
  assert.ok(result.fileCount > 0, '扫描器没扫到任何文件，门禁等于空转');
  assert.ok(result.relativeRequires > 0, '一条相对 require 都没提取到，判据可疑');
  const detail = result.unresolved
    .map((u) => `${u.file}:${u.line} require('${u.request}')`)
    .join('\n');
  assert.equal(result.unresolved.length, 0, `存在无法解析的相对 require：\n${detail}`);
});

test('扫描器自测：错路径必须被逮到（防假绿）', () => {
  const root = makeFixture({
    'src/ok.js': 'module.exports = 1;\n',
    'src/dir/index.js': 'module.exports = 2;\n',
    // 正确：../../ = src；../index = src/dir/index.js（目录 index + 省略扩展名）
    // 错误：../../../ok 越过仓库根；./missing 不存在
    'src/dir/nested/bad.js': [
      "require('../../ok');",
      "require('../');",
      "require('../index');",
      "require('../../../ok');",
      "require('./missing');",
      '',
    ].join('\n'),
  });
  try {
    const result = resolveAll(root);
    assert.equal(result.fileCount, 3);
    assert.equal(result.relativeRequires, 5);
    const got = result.unresolved.map((u) => u.request).sort();
    assert.deepEqual(got, ['../../../ok', './missing']);
    // 行号必须可定位（bad.js 第 4、5 行）
    assert.deepEqual(result.unresolved.map((u) => u.line).sort(), [4, 5]);
    assert.ok(result.unresolved.every((u) => u.file === 'src/dir/nested/bad.js'));
  } finally {
    cleanup(root);
  }
});

test('注释与字符串正文里的 require 不算真引用', () => {
  const root = makeFixture({
    'src/real.js': 'module.exports = 1;\n',
    'src/noise.js': [
      "// require('./comment-line');",
      "/* require('./comment-block'); */",
      'const a = "require(\'./string-dq\')";',
      "const b = 'require(\"./string-sq\")';",
      'const c = `require(\'./template\')`;',
      "require('./real');",
      '',
    ].join('\n'),
  });
  try {
    const result = resolveAll(root);
    assert.equal(result.relativeRequires, 1, '只应提取到真正的 require');
    assert.equal(result.unresolved.length, 0);
    const scanned = scanRequirePaths(path.join(root, 'src'));
    assert.deepEqual(scanned.requires.map((r) => r.request), ['./real']);
  } finally {
    cleanup(root);
  }
});

test('node_modules 与 dist 不在扫描范围内', () => {
  const root = makeFixture({
    'src/a.js': "require('./b');\n",
    'src/b.js': 'module.exports = 1;\n',
    'src/node_modules/pkg/index.js': "require('./nope');\n",
    'src/dist/bundle.js': "require('./nope');\n",
  });
  try {
    const result = resolveAll(root);
    assert.equal(result.fileCount, 2);
    assert.equal(result.unresolved.length, 0);
  } finally {
    cleanup(root);
  }
});