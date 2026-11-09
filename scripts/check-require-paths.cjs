#!/usr/bin/env node
/**
 * 静态 require 路径门禁 —— 防止「惰性 require 多上溯 / 少上溯一层」的启动阻断。
 *
 * 为什么需要这个脚本：
 *   src/main/ipc/library.js 的 7 处惰性 require 写了 `../../../utils/...`，
 *   该文件在 src/main/ipc/，到 src/utils 只需两层。这些 require 位于
 *   register() 函数体内，模块加载期不会执行，于是：
 *     - 主进程启动到注册 IPC 时才抛 MODULE_NOT_FOUND；
 *     - 打包、lint、大部分单测全部照常通过；
 *     - 单测若用桩替换 electron，也未必走到该分支。
 *   症状是「用户机器上打开本地音乐库就崩」，排查成本极高。
 *   同一批事故里还有 `require('./domain')` 指向不存在目录、被空 catch
 *   吞掉的静默失败死代码。两类问题的共同点是：**路径能否解析，本来可以
 *   在 CI 里静态判定**，不需要启动应用。
 *
 * 做法：
 *   递归扫描 src/ 下全部 .js / .cjs，用 codeMask（复用
 *   scripts/check-dead-deps.cjs 的词法掩码）剔除注释与字符串正文，
 *   只保留 `require('相对路径')` 字面量，再按所在文件解析目标。
 *   解析规则与 Node 一致：原样、.js、.cjs、.json、目录 index.js/cjs/json。
 *
 * 用法：
 *   node scripts/check-require-paths.cjs
 *
 * 输出：
 *   FILES <n>
 *   RELATIVE_REQUIRES <n>
 *   UNRESOLVED <n>
 *   （UNRESOLVED > 0 时逐条打印文件:行 + request，并以退出码 1 结束）
 *
 * 退出码：0 = 全部可解析；1 = 存在无法解析的相对 require。
 *
 * 白名单：ALLOWLIST 仅用于「确实无法静态解析」的动态 require 场景。
 *   目前为空。往里加一条之前，先证明它不能改写成静态路径 ——
 *   放大白名单等于把门禁关掉。
 */

const fs = require('fs');
const path = require('path');
// codeMask 是纯词法函数、无顶层副作用；直接复用死依赖扫描器里的实现，
// 避免两套「注释 / 字符串判定」各自漂移后互相打脸。
const { codeMask } = require('./check-dead-deps.cjs');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'src');

/** 参与扫描的源码扩展名 */
const SOURCE_EXTS = new Set(['.js', '.cjs']);
/** 解析候选：原样 / 补 .js / .cjs / .json（按 Node 的优先级） */
const RESOLVE_EXTS = ['', '.js', '.cjs', '.json'];
/** 目录内命中这些名字时整棵跳过 */
const EXCLUDED_DIRS = new Set(['node_modules', 'dist']);

/**
 * 显式白名单：`<相对仓库根的源文件>|<require 请求>`。
 * 只允许登记确实无法静态解析的条目（例如按运行时开关加载的可选模块）。
 * 空数组起步 —— 当前仓库一条都不需要。
 */
const ALLOWLIST = Object.freeze([]);

/** 相对仓库根的统一 POSIX 形式，便于白名单与报错信息稳定 */
function toRepoPath(file, root) {
  return path.relative(root, file).split(path.sep).join('/');
}

/** 行号（1 起）：按 `\n` 计数到指定下标 */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch (_e) {
    return false;
  }
}

/**
 * 递归收集目录下的 .js / .cjs 文件（跳过 node_modules、dist）。
 * @param {string} dir 起始目录
 * @returns {string[]} 绝对路径，按名称排序
 */
function walkSourceFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return [];
  }
  const out = [];
  for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...walkSourceFiles(full));
    } else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

// 只匹配 `require('literal')` / require("literal")。动态 require(变量) 本来
// 就没有可解析的静态目标，不在本门禁职责内（白名单即为此留的口子）。
const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"\\]+)\1\s*\)/g;

/**
 * 从一份源码里提取所有**相对路径** require。
 * 注释里、字符串正文里的 `require('./x')` 由 codeMask 判为伪代码，直接跳过。
 * @param {string} src
 * @returns {{request: string, index: number, line: number}[]}
 */
function extractRelativeRequires(src) {
  const text = String(src);
  const mask = codeMask(text);
  const out = [];
  for (const match of text.matchAll(REQUIRE_RE)) {
    // match.index 指向 `require` 的 r（\b 为零宽），落在字符串/注释正文时 mask 为 0
    if (!mask[match.index]) continue;
    const request = match[2];
    if (!request.startsWith('.')) continue; // 裸模块名 / node: 内建不归本门禁管
    out.push({ request, index: match.index, line: lineAt(text, match.index) });
  }
  return out;
}

/**
 * 按 Node 的解析顺序把相对 request 落成具体文件。
 * @param {string} fromFile 发起 require 的文件绝对路径
 * @param {string} request 相对路径
 * @returns {string|null} 解析到的绝对路径；解析失败返回 null
 */
function resolveRequest(fromFile, request) {
  const base = path.resolve(path.dirname(fromFile), request);
  for (const ext of RESOLVE_EXTS) {
    const candidate = base + ext;
    if (isFile(candidate)) return candidate;
  }
  // 目录：require('./dir') → dir/index.js / index.cjs / index.json
  for (const ext of RESOLVE_EXTS.slice(1)) {
    const candidate = path.join(base, 'index' + ext);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 扫描目录下所有源码，产出相对 require 清单（不做解析）。
 * @param {string} [srcDir] 默认仓库 src/
 * @returns {{files: string[], requires: {file: string, request: string, index: number, line: number}[]}}
 */
function scanRequirePaths(srcDir = SOURCE_DIR) {
  const files = walkSourceFiles(srcDir);
  const requires = [];
  for (const file of files) {
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch (_e) {
      continue; // 读不了的文件不应让门禁崩溃：下一轮 CI 仍会暴露
    }
    for (const item of extractRelativeRequires(src)) {
      requires.push({ file, ...item });
    }
  }
  return { files, requires };
}

/**
 * 解析全部相对 require，返回判定结果（纯函数，供测试直接调用）。
 * @param {string} [root] 仓库根目录（内部扫描 root/src）
 * @param {{allowlist?: string[]}} [opts]
 * @returns {{fileCount: number, relativeRequires: number, unresolved: object[], allowlisted: object[]}}
 */
function resolveAll(root = ROOT, opts = {}) {
  const allowlist = new Set(opts.allowlist === undefined ? ALLOWLIST : opts.allowlist);
  const { files, requires } = scanRequirePaths(path.join(root, 'src'));
  const unresolved = [];
  const allowlisted = [];
  for (const item of requires) {
    if (resolveRequest(item.file, item.request)) continue;
    const entry = {
      file: toRepoPath(item.file, root),
      request: item.request,
      line: item.line,
    };
    const key = entry.file + '|' + entry.request;
    if (allowlist.has(key)) allowlisted.push(entry);
    else unresolved.push(entry);
  }
  return {
    fileCount: files.length,
    relativeRequires: requires.length,
    unresolved,
    allowlisted,
  };
}

function main() {
  const result = resolveAll(ROOT);
  console.log('FILES ' + result.fileCount);
  console.log('RELATIVE_REQUIRES ' + result.relativeRequires);
  console.log('UNRESOLVED ' + result.unresolved.length);
  if (result.allowlisted.length) {
    console.log('ALLOWLISTED ' + result.allowlisted.length);
  }
  if (result.unresolved.length) {
    console.error('\n无法静态解析的相对 require（路径写错 / 目标不存在）：');
    for (const item of result.unresolved) {
      console.error("  " + item.file + ':' + item.line + "  require('" + item.request + "')");
    }
    console.error('\n修正路径；仅当确实无法静态解析时才登记到 ALLOWLIST。');
    process.exitCode = 1;
    return;
  }
  console.log('\n✓ 全部相对 require 均可静态解析。');
}

module.exports = {
  ALLOWLIST,
  lineAt,
  walkSourceFiles,
  extractRelativeRequires,
  resolveRequest,
  scanRequirePaths,
  resolveAll,
};

// 退出码只在「被当脚本跑」时交出；测试 require 本文件时保持安静。
if (require.main === module) main();