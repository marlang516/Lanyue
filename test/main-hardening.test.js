/**
 * main-hardening.test.js — 主进程安全与观测硬化的常驻门禁
 *
 * 守护六件事（任何一项回退都应该让 CI 红）：
 *   1. 主窗口显式 sandbox: true（preload 契约走 argv，不需要 Node 集成）
 *   2. 权限护栏默认拒绝，白名单 = fullscreen + clipboard-sanitized-write
 *      （两道 handler 口径一致；clipboard-read 仍拒绝）
 *   3. crashReporter 只做本地转储（uploadToServer:false + 空 submitURL）
 *   4. 启动耗时日志 [perf] app-ready / [perf] window-ready 仍在
 *   5. session-created 给登录窗口的独立 partition 会话装同一护栏
 *   6. LY_RENDERER_DIR 只允许 dist 内入口，非法值回退默认且告警
 *
 * 写法沿用 navigation-guard / open-folder-sandbox 的惯例：源码静态断言负责
 * 「结构在」；permissions.js 与 crash.js 的「行为对」用假 session / 假 electron
 * 实测（这两个模块可在 Node 里直接加载，不需要真的起 Electron）。
 * 所有扫描前先 stripComments：注释里提到 sandbox:true 不算证据。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const INDEX = stripComments(read('src/main/index.js'));
const PERMISSIONS = stripComments(read('src/main/permissions.js'));
const CRASH = stripComments(read('src/main/crash.js'));

/** 截取 createWindow 函数体（用于把 webPreferences 断言限定在主窗口） */
function createWindowBody(src) {
  const m = /function createWindow\(\)\s*\{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'index.js 必须仍有 createWindow()');
  return m[1];
}

/** 截取 resolveRendererEntry 函数体（LY_RENDERER_DIR 校验断言用） */
function resolveRendererEntryBody(src) {
  const m = /function resolveRendererEntry\(\)\s*\{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'index.js 必须仍有 resolveRendererEntry()');
  return m[1];
}

/**
 * 抽取 index.js 的入口解析实现，在 vm 沙箱里真跑（fs 打桩）。
 * 用于证明「白名单之外即使存在 index.html 也回退」，而不是只看源码字符串。
 */
function loadRendererResolver() {
  const src = stripComments(read('src/main/index.js'));
  const declarations = [
    [/const DIST_ROOT = [^\n]*\n/, 'DIST_ROOT'],
    [/const RENDERER_DIR_WHITELIST = Object\.freeze\(\[[\s\S]*?\]\);\n/, 'RENDERER_DIR_WHITELIST'],
    [/function isStrictlyInside\([\s\S]*?\n\}\n/, 'isStrictlyInside'],
    [/function resolveRendererEntry\(\) \{[\s\S]*?\n\}\n/, 'resolveRendererEntry'],
  ].map(([re, label]) => {
    const m = re.exec(src);
    assert.ok(m, `index.js 缺少 ${label}（入口解析实现被改动了？）`);
    return m[0];
  }).join('\n');

  const distMain = path.join(ROOT, 'dist', 'main');
  return {
    defaultEntry: path.join(ROOT, 'dist', 'renderer', 'index.html'),
    /**
     * @param {string|undefined} dir 模拟 LY_RENDERER_DIR
     * @param {{realpath?: Record<string, string>}} [opts] realpath 重映射（造 symlink 逃逸）
     * @returns {{entry: string, warnings: string[]}}
     */
    resolveWith(dir, opts = {}) {
      const warnings = [];
      const sandbox = {
        path,
        // statSync 一律宣称 index.html 存在：能拦住 dist/other 的只可能是白名单判定
        fs: {
          realpathSync: (p) => (opts.realpath && opts.realpath[p]) || p,
          statSync: () => ({ isFile: () => true }),
        },
        logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
        process: { env: dir === undefined ? {} : { LY_RENDERER_DIR: dir } },
        __dirname: distMain,
      };
      const resolver = vm.runInNewContext(`${declarations}\nresolveRendererEntry`, sandbox);
      return { entry: resolver(), warnings };
    },
  };
}

// ─── 1. index.js 结构 ────────────────────────────────────────────────
test('主窗口 webPreferences 显式开启 sandbox: true', () => {
  const body = createWindowBody(INDEX);
  assert.match(body, /webPreferences\s*:\s*\{/, '主窗口必须有 webPreferences');
  assert.match(
    body,
    /webPreferences\s*:\s*\{[\s\S]{0,600}?sandbox\s*:\s*true/,
    '主窗口 webPreferences 必须显式 sandbox: true（preload 只 require electron 内置模块）',
  );
  assert.doesNotMatch(INDEX, /sandbox\s*:\s*false/, '主进程不得重新关掉 sandbox');
});

test('app ready 后安装权限护栏（session.defaultSession）', () => {
  assert.match(
    INDEX,
    /installPermissionGuards\(\s*session\.defaultSession\s*,\s*logger\s*\)/,
    '必须在 ready 后调用 installPermissionGuards(session.defaultSession, logger)',
  );
  const ready = INDEX.indexOf('app.whenReady()');
  const call = INDEX.indexOf('installPermissionGuards(session.defaultSession');
  assert.ok(ready >= 0 && call > ready, '权限护栏必须装在 app ready 之后');
  assert.match(INDEX, /require\('electron'\)[\s\S]*?\bsession\b/, 'session 必须从 electron 解构');
});

test('session-created 覆盖登录窗口的独立分区会话', () => {
  assert.match(
    INDEX,
    /app\.on\('session-created',\s*\(s\)\s*=>\s*installPermissionGuards\(s,\s*logger\)\)/,
    "必须注册 app.on('session-created')，否则 login-<platform> 独立会话没有权限护栏",
  );
  const handler = INDEX.indexOf("app.on('session-created'");
  const ready = INDEX.indexOf('app.whenReady()');
  assert.ok(handler >= 0 && handler < ready,
    'session-created 必须在 ready 之前注册（登录窗口创建时才会创建该分区会话）');
  assert.match(INDEX, /installPermissionGuards\(session\.defaultSession/,
    'defaultSession 的安装必须保留（幂等，两条路径互不替代）');
});

test('crashReporter 在 app ready 之前初始化', () => {
  assert.match(INDEX, /const \{ initCrashReporter \} = require\('\.\/crash'\)/,
    'index.js 必须从 ./crash 引入 initCrashReporter');
  const call = INDEX.indexOf('initCrashReporter(app');
  const ready = INDEX.indexOf('app.whenReady()');
  assert.ok(call >= 0, '必须调用 initCrashReporter(app)');
  assert.ok(ready > call, 'initCrashReporter 必须早于 app.whenReady()（Electron 只在此之前挂载崩溃处理器）');
});

test('启动耗时日志：bootT0 / app-ready / window-ready', () => {
  assert.match(INDEX, /const bootT0\s*=\s*Date\.now\(\)/, '模块顶部必须有 bootT0');
  assert.match(
    INDEX,
    /app\.whenReady\(\)[\s\S]{0,300}\[perf\] app-ready \$\{Date\.now\(\) - bootT0\}ms/,
    'app ready 时必须记录 [perf] app-ready',
  );
  assert.match(
    INDEX,
    /did-finish-load'[\s\S]{0,400}\[perf\] window-ready \$\{Date\.now\(\) - bootT0\}ms/,
    '主窗口 did-finish-load 时必须记录 [perf] window-ready',
  );
});

test('LY_RENDERER_DIR 入口必须校验，非法值回退默认', () => {
  const body = resolveRendererEntryBody(INDEX);
  assert.match(body, /process\.env\.LY_RENDERER_DIR/, '必须读取环境变量');
  assert.match(body, /path\.resolve\(requested\)/, '必须先 path.resolve 再判定，不能直接用原始字符串');
  assert.match(body, /RENDERER_DIR_WHITELIST\.includes\(dir\)/, '只认白名单目录（resolved 路径相等）');
  assert.match(body, /isStrictlyInside\(DIST_ROOT, dir\)/, '仍要限定在 dist 根之下（纵深防御）');
  assert.doesNotMatch(body, /isStrictlyInside\(DIST_ROOT, dir\)\s*\|\|/,
    '不得保留「dist 内任意子目录」的放行分支');
  assert.match(body, /isStrictlyInside\(fs\.realpathSync\(DIST_ROOT\), fs\.realpathSync\(dir\)\)/,
    'realpath 判定必须仍以 dist 根为边界（防 symlink 逃逸）');
  assert.match(INDEX, /path\.join\(DIST_ROOT, 'renderer-legacy'\)/,
    '白名单必须含 dist/renderer-legacy（旧层显式回退）');
  assert.match(body, /return defaultEntry/, '非法值必须回退默认入口，不得阻断启动');
  assert.match(body, /logger\.warn\(/, '回退必须告警');

  // 裸拼接 / 未校验路径直送 loadFile 都是这次评审的原始缺陷，必须钉死
  assert.doesNotMatch(INDEX, /path\.join\(\s*process\.env\.LY_RENDERER_DIR/,
    '不得把 LY_RENDERER_DIR 直接 path.join 拼接');
  assert.doesNotMatch(INDEX, /loadFile\(\s*process\.env\.LY_RENDERER_DIR/,
    '不得把未校验的环境变量路径直接交给 loadFile');
  assert.match(INDEX, /const rendererEntry = resolveRendererEntry\(\)/,
    'createWindow 必须经 resolveRendererEntry 取入口');
});

test('LY_RENDERER_DIR 只认两个白名单目录：dist/other 有 index.html 也回退', () => {
  const { resolveWith, defaultEntry } = loadRendererResolver();

  // 白名单目录仍可用（新层 + 旧层显式回退）
  for (const name of ['renderer', 'renderer-legacy']) {
    const dir = path.join(ROOT, 'dist', name);
    const r = resolveWith(dir);
    assert.strictEqual(r.entry, path.join(dir, 'index.html'), `${name} 必须在白名单内且可用`);
    assert.deepStrictEqual(r.warnings, [], `${name} 是合法入口，不应告警`);
  }

  // dist/other：fs 打桩宣称 index.html 存在；能拦住它的只剩白名单判定
  const other = path.join(ROOT, 'dist', 'other');
  const rejected = resolveWith(other);
  assert.strictEqual(rejected.entry, defaultEntry,
    'dist/other 即使存在 index.html 也必须回退默认入口（穷举白名单）');
  assert.strictEqual(rejected.warnings.length, 1, '拒绝必须 logger.warn 一次');
  assert.match(rejected.warnings[0], /回退默认入口/);

  // dist 根自身也不是白名单项（白名单是它的两个子目录）
  assert.strictEqual(resolveWith(path.join(ROOT, 'dist')).entry, defaultEntry,
    'dist 根自身不得被当成渲染层目录');

  // symlink 逃逸：白名单目录的 realpath 若落到 dist 之外，必须回退
  const renderer = path.join(ROOT, 'dist', 'renderer');
  const escaped = resolveWith(renderer, {
    realpath: { [renderer]: path.join(ROOT, 'src', 'renderer') },
  });
  assert.strictEqual(escaped.entry, defaultEntry,
    '白名单目录若是指向 dist 外的 symlink，必须回退');
  assert.strictEqual(escaped.warnings.length, 1, 'symlink 逃逸同样要告警');
});

// ─── 2. permissions.js 行为 ─────────────────────────────────────────
const { installPermissionGuards, ALLOWED_PERMISSIONS } = require(path.join(
  ROOT, 'src/main/permissions.js',
));

function makeFakeSession() {
  const handlers = {};
  return {
    handlers,
    setPermissionRequestHandler(fn) { handlers.request = fn; },
    setPermissionCheckHandler(fn) { handlers.check = fn; },
  };
}

function makeLogger() {
  const warns = [];
  return { warns, warn: (...args) => warns.push(args.map(String).join(' ')) };
}

/** 以 preload 的方式调 request handler，返回是否放行 */
function requestPermission(session, permission, url) {
  let granted = null;
  const webContents = { getURL: () => url };
  session.handlers.request(webContents, permission, (v) => { granted = v; }, {});
  return granted;
}

test('权限白名单 = fullscreen + clipboard-sanitized-write（其余默认拒绝）', () => {
  assert.deepStrictEqual([...ALLOWED_PERMISSIONS], ['fullscreen', 'clipboard-sanitized-write'],
    '白名单扩大必须在测试里显式改，防止静默放行新权限');
  assert.match(PERMISSIONS, /callback\(false\)/, '必须保留显式 callback(false) 的拒绝路径');
});

test('request handler：默认拒绝，拒绝时记 permission + 来源（不含路径）', () => {
  const session = makeFakeSession();
  const logger = makeLogger();
  assert.strictEqual(installPermissionGuards(session, logger), true);

  const denied = requestPermission(session, 'media', 'https://evil.example/page?token=SECRET');
  assert.strictEqual(denied, false, 'media 必须被拒绝');

  assert.strictEqual(logger.warns.length, 1, '每次拒绝恰好记一条 warn');
  assert.match(logger.warns[0], /\[permission\]/, '拒绝日志必须带 [permission] 前缀');
  assert.match(logger.warns[0], /media/, '拒绝日志必须记录权限名');
  assert.match(logger.warns[0], /https:\/\/evil\.example/, '拒绝日志必须记录窗口来源');
  assert.ok(!logger.warns[0].includes('/page'), '不得记录路径/query（可能带敏感信息）');
  assert.ok(!logger.warns[0].includes('SECRET'), '不得把 token 写进日志');
});

test('request handler：放行 fullscreen / clipboard-sanitized-write，且不产生拒绝日志', () => {
  const session = makeFakeSession();
  const logger = makeLogger();
  installPermissionGuards(session, logger);

  assert.strictEqual(requestPermission(session, 'fullscreen', 'file:///C:/Users/a/app/index.html'), true);
  assert.strictEqual(
    requestPermission(session, 'clipboard-sanitized-write', 'file:///C:/Users/a/app/index.html'),
    true,
    'navigator.clipboard.writeText 需要该权限（M3U / MCP 配置复制）',
  );
  assert.strictEqual(logger.warns.length, 0, '放行不应被当成拒绝记录');
});

test('check handler：与 request handler 同一白名单', () => {
  const session = makeFakeSession();
  const logger = makeLogger();
  installPermissionGuards(session, logger);

  const webContents = { getURL: () => 'https://music.example/song/1' };
  assert.strictEqual(session.handlers.check(webContents, 'notifications', 'https://music.example', {}), false);
  assert.strictEqual(session.handlers.check(webContents, 'fullscreen', 'file://app', {}), true);
  assert.strictEqual(
    session.handlers.check(webContents, 'clipboard-sanitized-write', 'file://app', {}),
    true,
    'check handler 必须与 request handler 口径一致',
  );
  assert.strictEqual(session.handlers.check(webContents, 'clipboard-read', 'file://app', {}), false,
    '只允许写剪贴板，不允许读（clipboard-read 会泄露用户剪贴内容）');
  assert.match(logger.warns[0] || '', /notifications/, 'check 拒绝同样要记日志');
});

test('file: 来源只记协议标签，不泄露本机路径', () => {
  const session = makeFakeSession();
  const logger = makeLogger();
  installPermissionGuards(session, logger);

  requestPermission(session, 'geolocation', 'file:///C:/Users/alice/secret.html');
  assert.match(logger.warns[0], /file:\/\/app/, 'file: 来源用固定标签');
  assert.ok(!logger.warns[0].includes('alice'), '不得把用户目录名写进日志');
});

test('session 接口缺失时只告警不抛错', () => {
  const logger = makeLogger();
  assert.strictEqual(installPermissionGuards(null, logger), false);
  assert.match(logger.warns[0] || '', /session/);
  assert.doesNotThrow(() => installPermissionGuards({}, logger));
});

// ─── 3. crash.js 行为 ───────────────────────────────────────────────
/** 用假 electron 加载 crash.js（每次重新加载，避免缓存串味） */
function loadCrashWithMock(electronMock) {
  const target = path.join(ROOT, 'src/main/crash.js');
  const originalLoad = Module._load;
  Module._load = function intercepted(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(target)];
    return require(target);
  } finally {
    Module._load = originalLoad;
  }
}

test('crash.js 静态配置：本地转储、不上传', () => {
  assert.match(CRASH, /uploadToServer\s*:\s*false/, 'uploadToServer 必须为 false');
  assert.match(CRASH, /submitURL\s*:\s*''/, 'submitURL 必须为空字符串');
  assert.doesNotMatch(CRASH, /submitURL\s*:\s*['"`][^'"`]*https?:/,
    '不得把 submitURL 指向任何 http(s) 外发地址');
  assert.match(CRASH, /crashReporter\.start\(/, '必须调用 crashReporter.start');
  assert.match(CRASH, /'CrashDumps'/, '转储目录必须是 userData/CrashDumps');
});

test('crash.js 行为：转储目录指向 userData/CrashDumps 且 start 参数正确', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lanyue-crash-'));
  const userData = path.join(tmp, 'userdata');
  const startCalls = [];
  const setPathCalls = [];
  const electronMock = {
    crashReporter: { start: (opts) => startCalls.push(opts) },
    app: {
      getPath: (name) => {
        assert.strictEqual(name, 'userData');
        return userData;
      },
      setPath: (name, p) => setPathCalls.push([name, p]),
    },
  };

  try {
    const { initCrashReporter } = loadCrashWithMock(electronMock);
    const dumpsDir = initCrashReporter(electronMock.app, makeLogger());

    const expected = path.join(userData, 'CrashDumps');
    assert.strictEqual(dumpsDir, expected, '必须返回转储目录');
    assert.strictEqual(fs.existsSync(expected), true, '转储目录必须被创建（setPath 要求目录已存在）');
    assert.deepStrictEqual(setPathCalls, [['crashDumps', expected]], '必须设置 crashDumps 路径');

    assert.strictEqual(startCalls.length, 1, 'crashReporter.start 必须被调用一次');
    const opts = startCalls[0];
    assert.strictEqual(opts.productName, 'Lanyue');
    assert.strictEqual(opts.companyName, 'Lanyue');
    assert.strictEqual(opts.uploadToServer, false);
    assert.strictEqual(opts.submitURL, '');
    assert.strictEqual(opts.compress, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('crash.js 异常不阻断启动：getPath / start 抛错只记日志', () => {
  const startCalls = [];
  const logger = makeLogger();
  const throwingPathMock = {
    crashReporter: { start: (opts) => startCalls.push(opts) },
    app: {
      getPath: () => { throw new Error('no userData'); },
      setPath: () => {},
    },
  };

  const { initCrashReporter: init1 } = loadCrashWithMock(throwingPathMock);
  assert.doesNotThrow(() => init1(throwingPathMock.app, logger));
  assert.strictEqual(startCalls.length, 1, '目录失败后仍要尝试启动 crashReporter');
  assert.match(logger.warns[0] || '', /\[crash\]/);

  const throwingStartMock = {
    crashReporter: { start: () => { throw new Error('start failed'); } },
    app: {
      getPath: () => os.tmpdir(),
      setPath: () => {},
    },
  };
  const logger2 = makeLogger();
  const { initCrashReporter: init2 } = loadCrashWithMock(throwingStartMock);
  assert.doesNotThrow(() => init2(throwingStartMock.app, logger2));
  assert.strictEqual(logger2.warns.length, 1, 'start 失败必须记录日志而不是抛出');
});

// ─── 4. 语法门禁（等价于 node --check）────────────────────────────────
test('主进程文件语法可被 node --check 通过', () => {
  const files = ['src/main/index.js', 'src/main/permissions.js', 'src/main/crash.js'];
  for (const rel of files) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], {
      encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, `${rel} 语法检查失败：${r.stderr}`);
  }
});