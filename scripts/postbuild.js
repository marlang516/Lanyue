const fs = require('fs');
const path = require('path');

// Vite 已把这两个入口打进 dist（index → dist/main，preload → dist/preload）。
// 用源码覆盖 index.js 会丢掉压缩后的入口。
const VITE_OWNED_MAIN_FILES = new Set(['index.js', 'preload.js']);

/**
 * 主进程里要原样进 dist 的条目。
 *
 * 顶层 .js（除 Vite 入口）一向是扫目录得到的。子目录曾经是手工名单
 * （ipc/、后来补上的 mcp/）：模块再拆成目录时名单不会自己跟上，
 * 打包后 `require` 才失败。这里改为与顶层文件同一条规则——src/main
 * 下的每个子目录都拷。
 *
 * @param {string} mainDir src/main 的绝对路径
 * @returns {{name: string, kind: 'dir'|'file'}[]}
 */
function planMainRuntimeCopies(mainDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(mainDir, { withFileTypes: true });
  } catch (_e) {
    return [];
  }
  const planned = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      planned.push({ name: entry.name, kind: 'dir' });
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.js') &&
      !VITE_OWNED_MAIN_FILES.has(entry.name)
    ) {
      planned.push({ name: entry.name, kind: 'file' });
    }
  }
  return planned;
}

function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (
      entry.name.endsWith('.js') ||
      entry.name.endsWith('.mjs') ||
      entry.name.endsWith('.json')
    ) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 把运行时仍要 `require` 的源码拷进 dist。
 * Vite 只产出主进程/preload 入口和渲染层 bundle，其余模块靠这里。
 *
 * @param {{root?: string, dist?: string}} [options]
 *   root 默认仓库根；dist 默认 `<root>/dist`。测试传入临时 dist，避免写工作树。
 */
function runPostbuild(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const src = path.join(root, 'src');
  const dist = options.dist || path.join(root, 'dist');

  const jobs = [
    { from: path.join(src, 'api'), to: path.join(dist, 'api') },
    { from: path.join(src, 'utils'), to: path.join(dist, 'utils') },
    { from: path.join(src, 'shared'), to: path.join(dist, 'shared') },
  ];

  for (const item of planMainRuntimeCopies(path.join(src, 'main'))) {
    jobs.push({
      from: path.join(src, 'main', item.name),
      to: path.join(dist, 'main', item.name),
    });
  }

  for (const { from, to } of jobs) {
    if (fs.existsSync(from)) {
      if (fs.statSync(from).isDirectory()) {
        copyDir(from, to);
      } else {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
      console.log(`  copied: ${path.relative(root, from)} -> ${path.relative(root, to)}`);
    }
  }

  // Copy mini-player.html / desktop-lyric.html (Vite 不处理主进程动态 loadFile 的页面)
  const standalonePages = ['mini-player.html', 'desktop-lyric.html'];
  for (const page of standalonePages) {
    const from = path.join(src, 'renderer', page);
    const to = path.join(dist, 'renderer', page);
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      console.log(`  copied: ${path.relative(root, from)} -> ${path.relative(root, to)}`);
    }
  }

  // 独立窗口（mini-player / desktop-lyric）不在 Vite 入口内，其 <link href="./styles/base.css">
  // 必须让 dist 下真有该文件：主 index.html 的样式会被 Vite 合并成 assets/index-<hash>.css，
  // 独立窗口无法引用那个 hash 名。只复制 base.css（令牌 + 重置 + 通用组件）以保持令牌单源。
  const sharedCss = path.join(src, 'renderer', 'styles', 'base.css');
  const sharedCssDest = path.join(dist, 'renderer', 'styles', 'base.css');
  if (fs.existsSync(sharedCss)) {
    fs.mkdirSync(path.dirname(sharedCssDest), { recursive: true });
    fs.copyFileSync(sharedCss, sharedCssDest);
    console.log(
      `  copied: ${path.relative(root, sharedCss)} -> ${path.relative(root, sharedCssDest)}`
    );
  }

  console.log('[postbuild] done');
}

module.exports = {
  planMainRuntimeCopies,
  runPostbuild,
};

// 被测试 require 时不写 dist；只有 `node scripts/postbuild.js` 才执行。
if (require.main === module) runPostbuild();
