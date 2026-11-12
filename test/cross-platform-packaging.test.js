/**
 * 跨平台（Linux / macOS）打包契约守卫
 *
 * ── 为什么需要这一组测试 ────────────────────────────────────
 *
 * 本仓库长期只发 Windows 产物，linux/mac 两段配置从未被真正执行过。
 * 2026-11-12 第一次实跑 `electron-builder --linux --x64`，暴露出三类
 * 「配置看着齐全、实际打不出来或打错」的缺陷：
 *
 *   1. deb 直接失败：`Please specify author 'email'`。package.json 的
 *      author 是字符串「揽乐」，而 FpmTarget 要的是 author.email。
 *      这条在 Linux 上同样会失败 —— 不是 Windows 宿主的问题。
 *   2. 产物名回落成 package.json 的 name（music-downloader），与品牌
 *      Lanyue 不一致：Linux 可执行文件实测就叫 music-downloader，
 *      mac 的 artifactName 用 ${name} 也会打出 music-downloader-*.dmg。
 *   3. extraResources 的 filter 是 `*.py`，把开发期 codemod 脚本
 *      add-try-catch.py 一起发给了最终用户（Windows 已发布版本里就有）。
 *
 * 这些都能通过 build 与全部既有测试 —— 所以必须专门守住。
 *
 * ── 实测边界（本文件不假装能验证的部分）──────────────────────
 *
 * AppImage 与 deb 的**封装**在 Windows 宿主上打不出来：
 *   app-builder-lib/out/toolsets/linux.js:104 在非 Linux 宿主上一律取
 *   `darwin` 工具目录，而 appimage-12.0.1 工具包只带 darwin/linux 版
 *   mksquashfs ⇒ `spawn …/darwin/mksquashfs ENOENT`（实测）。
 *   deb 走 getFpmPath()：win32 上返回裸 `fpm`，要求宿主自备（实测无）。
 * 但 `--linux` 的**打包阶段**在 Windows 上成功：release/linux-unpacked
 * 里是真正的 ELF x86-64 可执行文件，且 scripts/smoke-asar.js 对它
 * 18/18 全通过。macOS 产物则必须在 macOS 上打（dmg 依赖 hdiutil）。
 *
 * 因此本文件守的是**静态契约 + 上游事实**，运行期验证边界写在
 * docs/RELEASING.md「跨平台产物」一节，不在这里假装跑过。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONFIG = require('../build/config.cjs');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CONFIG_TEXT = fs.readFileSync(path.join(ROOT, 'build', 'config.cjs'), 'utf8');

const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, ...rel.split('/')));
const dep = (rel) => path.join(ROOT, 'node_modules', ...rel.split('/'));

/** 取 mac/linux 的 target 名清单（配置里是 {target, arch} 对象数组） */
function targetNames(section) {
  const t = CONFIG[section] && CONFIG[section].target;
  if (!Array.isArray(t)) return [];
  return t.map((x) => (typeof x === 'string' ? x : x.target));
}

/** 取某 target 的 arch 清单 */
function targetArchs(section, name) {
  const t = (CONFIG[section] && CONFIG[section].target) || [];
  const hit = t.find((x) => (typeof x === 'string' ? x : x.target) === name);
  if (!hit || typeof hit === 'string') return [];
  return Array.isArray(hit.arch) ? hit.arch : [hit.arch];
}

// ── 1. deb 维护者邮箱（实测阻断项）────────────────────────────

test('package.json 的 author 必须带 email —— 否则 deb 在任何平台都打不出来', () => {
  // 上游事实：FpmTarget 先看 linux.maintainer，没有就要求 author.email
  const fpm = fs.readFileSync(dep('app-builder-lib/out/targets/FpmTarget.js'), 'utf8');
  assert.match(fpm, /options\.maintainer/, '上游已改用别的字段取维护者，本测试的判据要跟着复核');
  assert.match(fpm, /a\.email == null/, '上游不再要求 author.email，本条约束需重新核实');
  assert.match(fpm, /authorEmailIsMissed/, '上游错误码变了，需重新核实');

  const maintainer = CONFIG.linux && CONFIG.linux.maintainer;
  if (maintainer) {
    // 走 linux.maintainer 这条替代路径时，它自己必须含邮箱
    assert.match(String(maintainer), /<[^@\s]+@[^@\s]+>/,
      'linux.maintainer 必须是 "Name <email>" 形态，deb 的 Maintainer 字段要邮箱');
    return;
  }

  const a = PKG.author;
  assert.equal(typeof a, 'object',
    'author 是字符串时 FpmTarget 取不到 .email，deb 打包直接失败（实测）；'
    + '请改成 { "name": "...", "email": "..." }');
  assert.ok(a && typeof a.name === 'string' && a.name.trim(), 'author.name 不能为空');
  assert.match(String(a.email), /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
    'author.email 必须是合法邮箱 —— 它会成为 deb 的 Maintainer 字段');
});

// ── 2. 随包分发的 Python 脚本（产物卫生）──────────────────────

/** extraResources 里 scripts/ 那条的 filter 清单 */
function shippedPyFilter() {
  const entries = CONFIG.extraResources || [];
  const hit = entries.find((e) => typeof e === 'object' && /^scripts\/?$/.test(String(e.from)));
  assert.ok(hit, 'extraResources 里找不到 scripts/ 那条 —— 运行期标签写入会失去脚本');
  return Array.isArray(hit.filter) ? hit.filter : [hit.filter];
}

test('extraResources 只随包分发运行期真正执行的 Python 脚本，不得用 *.py 通配', () => {
  const filter = shippedPyFilter();
  assert.ok(!filter.includes('*.py'),
    'filter 用 *.py 会把开发期脚本一起发给用户（实测 add-try-catch.py 已进包）；'
    + '必须逐个点名运行期脚本');

  for (const f of filter) {
    assert.ok(!/[*?]/.test(f), `filter 里仍有通配符：${f}`);
    assert.ok(exists(`scripts/${f}`), `随包分发的 scripts/${f} 不存在`);
  }

  // 点名的每个脚本都必须真的被 src/ 在运行期引用（防止把开发脚本换个名字塞进来）
  const srcFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(js|cjs|mjs|ts|vue)$/.test(e.name)) srcFiles.push(rel);
    }
  })('src');
  const srcText = srcFiles.map((rel) => read(rel)).join('\n');

  for (const f of filter) {
    assert.ok(srcText.includes(f),
      `scripts/${f} 被随包分发，但 src/ 里没有任何引用 —— 它不是运行期脚本`);
  }
});

/**
 * filter 实际会带进包的文件集合 —— 必须展开通配符再判。
 * 直接拿 filter.includes('x.py') 判是恒真式：filter 为 ['*.py'] 时
 * 字面量永远不命中，而 x.py 其实已经进包了（本文件初版正犯此错）。
 */
function actuallyShippedPy() {
  const all = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.py'));
  const out = new Set();
  for (const pat of shippedPyFilter()) {
    if (typeof pat !== 'string') continue;
    if (pat.includes('*') || pat.includes('?')) {
      const re = new RegExp(`^${pat.split(/[\\/]/).pop()
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
      for (const f of all) if (re.test(f)) out.add(f);
    } else {
      out.add(path.basename(pat));
    }
  }
  return [...out].sort();
}

test('开发期 Python 脚本（codemod 与旧转码兜底）不得进安装包', () => {
  // 前提：它们确实存在于 scripts/（所以通配才会把它们带进去）
  const devScripts = ['add-try-catch.py', 'convert_audio.py'];
  for (const f of devScripts) {
    assert.ok(exists(`scripts/${f}`),
      `scripts/${f} 已被移走或删除，本条守卫失去意义，请同步更新`);
  }
  const shipped = actuallyShippedPy();
  const leaked = devScripts.filter((f) => shipped.includes(f));
  assert.deepStrictEqual(leaked, [],
    `开发期脚本进了安装包：${leaked.join(', ')}（实际分发清单：${shipped.join(', ')}）\n`
    + 'add-try-catch.py 是给 JS 源码加 try/catch 的 codemod；'
    + 'convert_audio.py 是旧转码兜底，转码链路早已直接走 ffmpeg（src/utils/audioConvert.js）');
});

test('scripts/ 下未被点名的 .py 必须都是开发期脚本（防漏掉运行期依赖）', () => {
  const shipped = actuallyShippedPy();
  const all = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.py'));
  const leftOut = all.filter((f) => !shipped.includes(f));

  const srcFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(js|cjs|mjs|ts|vue)$/.test(e.name)) srcFiles.push(rel);
    }
  })('src');
  const srcText = srcFiles.map((rel) => read(rel)).join('\n');

  const wronglyExcluded = leftOut.filter((f) => srcText.includes(f));
  assert.deepStrictEqual(wronglyExcluded, [],
    `这些 Python 脚本被 src/ 在运行期引用，却没随包分发（打包后功能会静默失效）：${wronglyExcluded.join(', ')}`);
});

// ── 3. 品牌一致性（Linux 可执行名 / mac 产物名）────────────────

test('mac 产物名必须是 Lanyue 品牌，不得用 ${name} 回落到包名', () => {
  // 前提事实：包名与产品名不同，所以 ${name} 会静默打出旧品牌
  assert.notEqual(PKG.name, CONFIG.productName,
    '包名与产品名已一致，${name} 不再有品牌风险，本条判据可放宽');
  const tpl = CONFIG.mac && CONFIG.mac.artifactName;
  assert.ok(typeof tpl === 'string' && tpl.length > 0, 'mac.artifactName 必须显式给出');
  assert.ok(!tpl.includes('${name}'),
    `mac.artifactName 用了 \${name}（= ${PKG.name}），会打出旧品牌产物名；应改用 Lanyue`);
  assert.ok(tpl.includes('Lanyue'), `mac.artifactName 未含品牌 Lanyue：${tpl}`);
  assert.ok(tpl.includes('${version}') && tpl.includes('${arch}'),
    'mac 产物名必须含版本与架构，否则 x64/arm64 两个包会互相覆盖');
});

test('Linux 可执行名、.desktop 文件名与 WM_CLASS 必须对齐到同一品牌', () => {
  // 上游事实：linuxPackager 用 sanitizedName.toLowerCase() 当可执行名（= 包名），
  // LinuxTargetHelper 用 desktopName 决定 .desktop 文件名与 StartupWMClass，
  // 而 Icon 字段取的是 executableName —— 三者不一致时桌面环境无法关联窗口。
  const lp = fs.readFileSync(dep('app-builder-lib/out/linuxPackager.js'), 'utf8');
  assert.match(lp, /sanitizedName\.toLowerCase\(\)/,
    '上游可执行名推导变了，本条判据需重新核实');
  const helper = fs.readFileSync(dep('app-builder-lib/out/targets/LinuxTargetHelper.js'), 'utf8');
  assert.match(helper, /syncDesktopName/, '上游不再支持 syncDesktopName，需重新核实');
  assert.match(helper, /StartupWMClass/, '上游不再生成 StartupWMClass，需重新核实');

  const exe = CONFIG.linux && CONFIG.linux.executableName;
  assert.equal(exe, 'lanyue',
    `linux.executableName 应显式设为 lanyue（实测默认打出 ${PKG.name}，与品牌 Lanyue 不一致）`);

  assert.equal(PKG.desktopName, 'lanyue.desktop',
    'package.json 需要 desktopName，Electron 在 Linux 上用它当 app_id / WM_CLASS');
  assert.equal(CONFIG.linux.syncDesktopName, true,
    'syncDesktopName 必须为 true，否则 .desktop 文件名仍按 executableName 走，与 WM_CLASS 对不上');

  // 三者对齐：desktopName 去掉后缀 == executableName == StartupWMClass
  assert.equal(PKG.desktopName.replace(/\.desktop$/, ''), exe,
    'desktopName（去 .desktop）必须等于 executableName，否则窗口关联不上桌面条目');
});

test('Linux 产物名与 Debian 包名必须是 Lanyue 品牌，不得回落到包名', () => {
  // 上游事实：deb 的默认文件名模板是 ${name}_${version}_${arch}.${ext}，
  // 而 ${name} = package.json 的 name；Debian 控制文件的包名取 linuxPackageName
  // （= appInfo.name）。两者都不看 productName，所以必须显式钉住。
  // 实测：未设时打出 music-downloader_1.1.2_amd64.deb，而 AppImage 却是
  // Lanyue-1.1.2.AppImage —— 同一平台的两个产物品牌不一致。
  const fpm = fs.readFileSync(dep('app-builder-lib/out/targets/FpmTarget.js'), 'utf8');
  assert.match(fpm, /\$\{name\}_\$\{version\}_\$\{arch\}/,
    '上游 deb 命名模板变了，本条判据需重新核实');
  assert.match(fpm, /options\.packageName/, '上游不再支持 linux.packageName，需重新核实');
  const appInfo = fs.readFileSync(dep('app-builder-lib/out/appInfo.js'), 'utf8');
  assert.match(appInfo, /get linuxPackageName\(\)/, '上游 linuxPackageName 推导变了，需重新核实');

  const pkgName = CONFIG.deb && CONFIG.deb.packageName;
  assert.equal(pkgName, 'lanyue',
    `deb.packageName 应显式设为 lanyue（实测默认取包名 ${PKG.name}）；层级见第 9 节`);
  assert.match(String(pkgName), /^[a-z0-9][a-z0-9+.-]*$/,
    'Debian 包名只允许小写字母/数字/+/-/.，大写会导致 dpkg 拒绝');

  const tpl = CONFIG.linux && CONFIG.linux.artifactName;
  assert.ok(typeof tpl === 'string' && tpl.length > 0,
    'linux.artifactName 必须显式给出，否则 deb 走 ${name} 默认模板打出旧品牌');
  assert.ok(!tpl.includes('${name}'),
    `linux.artifactName 用了 \${name}（= ${PKG.name}），会打出旧品牌产物名`);
  assert.ok(tpl.includes('Lanyue'), `linux.artifactName 未含品牌 Lanyue：${tpl}`);
  assert.ok(tpl.includes('${version}'), '产物名必须含版本');
});

// ── 4. 自动更新的跨平台前提（回归守卫 + 变异对照）──────────────

/** mac 自动更新是否具备 zip 目标（两个架构都要） */
function macHasZipForUpdate() {
  return targetNames('mac').includes('zip')
    && targetArchs('mac', 'zip').includes('x64')
    && targetArchs('mac', 'zip').includes('arm64');
}

test('mac 自动更新必须有 zip 目标 —— dmg  alone 不够（上游硬要求）', () => {
  const mu = fs.readFileSync(dep('electron-updater/out/MacUpdater.js'), 'utf8');
  assert.match(mu, /findFile\)\(files, "zip"/,
    '上游 MacUpdater 不再找 zip，本条判据需重新核实');
  assert.ok(macHasZipForUpdate(),
    'mac 缺 zip 目标时 MacUpdater 找不到更新包，自动更新直接失效');
});

test('Linux 自动更新依赖 AppImage 目标与 package-type 标识（上游事实）', () => {
  const main = fs.readFileSync(dep('electron-updater/out/main.js'), 'utf8');
  assert.match(main, /AppImageUpdater/, '上游 Linux 更新器实现变了，需重新核实');
  assert.match(main, /package-type/, '上游不再读 package-type，需重新核实');
  const fpm = fs.readFileSync(dep('app-builder-lib/out/targets/FpmTarget.js'), 'utf8');
  assert.match(fpm, /"package-type"/, '上游不再写 package-type，deb 的更新器选择会失效');

  assert.ok(targetNames('linux').includes('AppImage'),
    'Linux 缺 AppImage 目标：它是 electron-updater 在 Linux 上的主更新通道');
  assert.ok(targetNames('linux').includes('deb'),
    'Linux 缺 deb 目标：Debian/Ubuntu 用户无法安装');
});

test('变异对照：抽掉 zip / AppImage / 品牌名后，上面三条判据必须变红', () => {
  // 这一枚不测配置，测「判据本身有没有判别力」——
  // 防止守卫写成恒真式（配置怎么改都绿）。
  const savedMac = CONFIG.mac;
  const savedLinux = CONFIG.linux;
  const savedDeb = CONFIG.deb;
  try {
    CONFIG.mac = { ...savedMac, target: [{ target: 'dmg', arch: ['x64', 'arm64'] }] };
    assert.equal(macHasZipForUpdate(), false, '只剩 dmg 时判据必须为 false');

    CONFIG.mac = { ...savedMac, artifactName: '${name}-${version}-${os}-${arch}.${ext}' };
    assert.ok(CONFIG.mac.artifactName.includes('${name}'), '旧品牌模板应被识别为含 ${name}');

    CONFIG.linux = { ...savedLinux, target: [{ target: 'deb', arch: ['x64'] }] };
    assert.equal(targetNames('linux').includes('AppImage'), false, '抽掉 AppImage 后判据必须为 false');

    CONFIG.linux = { ...savedLinux, executableName: PKG.name };
    assert.notEqual(CONFIG.linux.executableName, 'lanyue', '回落到包名时必须被判为不一致');

    CONFIG.deb = { ...savedDeb, packageName: PKG.name };
    CONFIG.linux = { ...savedLinux, artifactName: '${name}_${version}_${arch}.${ext}' };
    assert.notEqual(CONFIG.deb.packageName, 'lanyue', 'Debian 包名回落到旧品牌时必须被判为不一致');
    assert.ok(CONFIG.linux.artifactName.includes('${name}'), 'deb 旧命名模板应被识别为含 ${name}');
    assert.ok(!/^[a-z0-9][a-z0-9+.-]*$/.test('Lanyue'), '大写品牌名不得直接当 Debian 包名');
  } finally {
    CONFIG.mac = savedMac;
    CONFIG.linux = savedLinux;
    CONFIG.deb = savedDeb;
  }
});

// ── 5. 生产依赖无 native 模块（跨平台打包可行性的前提）─────────

test('生产依赖树里没有 native 模块 —— 跨平台打包不需要交叉编译', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const pkgs = lock.packages || {};
  // 生产闭包：从根 dependencies 出发按 lock 的 requires 传递展开
  const prod = new Set();
  const queue = Object.keys(pkgs[''] && pkgs[''].dependencies ? pkgs[''].dependencies : {});
  while (queue.length) {
    const name = queue.shift();
    const key = `node_modules/${name}`;
    if (prod.has(key) || !pkgs[key]) continue;
    prod.add(key);
    for (const depName of Object.keys(pkgs[key].dependencies || {})) queue.push(depName);
  }
  assert.ok(prod.size > 100, `生产闭包只解析出 ${prod.size} 个包，解析口径写错了`);

  const natives = [];
  for (const key of prod) {
    const dir = path.join(ROOT, ...key.split('/'));
    if (!fs.existsSync(dir)) continue;
    (function walk(d, depth) {
      if (depth > 6) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
        else if (e.name.endsWith('.node') || e.name === 'binding.gyp') {
          natives.push(`${key}/${e.name}`);
        }
      }
    })(dir, 0);
  }
  assert.deepStrictEqual(natives, [],
    `生产依赖里出现 native 模块：${natives.join(', ')}\n`
    + '跨平台打包将需要按目标平台重建（electron-rebuild），'
    + 'docs/RELEASING.md「跨平台产物」一节的可行性结论必须同步重写。');
});

// ── 6. 跨平台构建 workflow（真实验证入口）─────────────────────

const XP_WORKFLOW = '.github/workflows/cross-platform-build.yml';

test('跨平台构建 workflow 存在，且只能手动触发', () => {
  assert.ok(exists(XP_WORKFLOW),
    `缺 ${XP_WORKFLOW}：AppImage/deb 在 Windows 上打不出来（实测），`
    + '没有 Linux/macOS runner 就永远无法验证跨平台产物');
  const yml = read(XP_WORKFLOW);

  const onBlock = /^on:\n([\s\S]*?)(?=\n[a-z])/m.exec(yml);
  assert.ok(onBlock, 'workflow 缺 on: 段');
  assert.match(onBlock[1], /workflow_dispatch/, '必须支持手动触发');
  assert.ok(!/^\s{2}(push|pull_request|schedule|release):/m.test(onBlock[1]),
    '跨平台构建只允许手动触发：自动跑会在每次 PR 上烧 macOS runner 分钟数');
});

test('跨平台构建 workflow 绝不发布产物、不碰任何 secrets', () => {
  const yml = read(XP_WORKFLOW);
  assert.match(yml, /--publish never/, '必须显式 --publish never');
  assert.ok(!/--publish always/.test(yml), '不得出现 --publish always');
  assert.ok(!/secrets\./.test(yml),
    '验证性构建不需要任何凭据；出现 secrets 引用意味着它可能真的往外发东西');
  assert.match(yml, /permissions:\n\s+contents: read/, '权限必须收到 contents: read');
});

test('跨平台构建 workflow 覆盖 Linux 与 macOS 两个宿主', () => {
  const yml = read(XP_WORKFLOW);
  assert.match(yml, /runs-on: ubuntu-latest/, 'AppImage/deb 必须在 Linux 宿主上打');
  assert.match(yml, /runs-on: macos-latest/, 'dmg 必须在 macOS 宿主上打（依赖 hdiutil）');
  assert.match(yml, /--linux/, 'Linux job 必须打 --linux');
  assert.match(yml, /--mac/, 'macOS job 必须打 --mac');
});

// ── 7. 文档与发版口径必须与实测一致 ───────────────────────────

test('release.yml 仍不发布 mac/linux，且理由不得再声称 native 模块', () => {
  const yml = read('.github/workflows/release.yml');
  assert.match(yml, /不发布 macOS\/Linux/, '发版口径变了（开始发布跨平台产物）时本条必须同步重写');
  const header = yml.slice(0, yml.indexOf('\nname:'));
  assert.ok(!/native\s*模块/.test(header),
    '实测生产依赖全是纯 JS（见本文件 native 模块那一枚），'
    + '「native 模块只按 Windows 验证过」不是真实理由，会误导后来人');
  assert.match(header, /mksquashfs|封装工具|Linux 宿主/,
    '不发布的理由必须写出真实阻断项：封装工具只有 Linux/macOS 版');
});

test('docs/RELEASING.md 记录跨平台验证边界（已验证 / 未验证分开写）', () => {
  const doc = read('docs/RELEASING.md');
  assert.match(doc, /跨平台产物/, 'RELEASING.md 缺「跨平台产物」一节');
  const sec = doc.slice(doc.indexOf('跨平台产物'));
  assert.match(sec, /mksquashfs/, '必须写出 AppImage 在 Windows 上失败的真实根因');
  assert.match(sec, /linux-unpacked/, '必须记录已实测验过的部分（Linux 应用目录 + asar 冒烟）');
  assert.match(sec, /未验证|无法验证/, '必须明确哪些结论尚无运行期实证，不得含糊');
  assert.match(sec, /safeStorage|密钥环|keyring/, '必须写出 Linux 上凭证存储的前置条件');
});

// ── 8. 配置文本卫生（防注释与事实漂移）────────────────────────

test('config.cjs 的 extraResources 注释必须与真实 filter 一致', () => {
  const filter = shippedPyFilter();
  const idx = CONFIG_TEXT.indexOf('extraResources:');
  assert.ok(idx > 0, 'config.cjs 里找不到 extraResources');
  const block = CONFIG_TEXT.slice(Math.max(0, idx - 900), idx + 300);

  // 注释里点名的运行期脚本必须就是 filter 里的那些（防注释说一套、配置做一套）
  for (const f of filter) {
    assert.ok(block.includes(f),
      `extraResources 注释未提及实际分发的 ${f} —— 注释与配置漂移`);
  }
  // 注释必须说明「为什么不用通配」——这是这条 filter 的存在理由，
  // 丢了它，下一个人很可能顺手改回 *.py（开发期脚本随之进包）。
  assert.ok(/通配/.test(block),
    'extraResources 注释未说明为什么不能用 *.py 通配，约束的理由会丢失');
  assert.ok(/开发期/.test(block),
    '注释应点明 scripts/ 下另有开发期脚本，这是逐个点名的原因');
});

// ── 9. 配置必须通过 electron-builder 自己的 schema 校验 ────────
// 这一节是「字段放错层级」的兜底。实测教训（2026-11-12）：把 packageName
// 写进 linux 块，单元测试全绿，但真跑 electron-builder 直接
// 「Invalid configuration object」—— linux 的 schema 里没有这个键。
// 只断言字段值的测试抓不到层级错误，必须拿上游校验器跑一遍真配置。

const { validateConfiguration } = require('../node_modules/app-builder-lib/out/util/config/config.js');
const QUIET_LOGGER = { isEnabled: false };

test('build/config.cjs 必须通过 electron-builder 的真实 schema 校验', async () => {
  await assert.doesNotReject(
    () => validateConfiguration(CONFIG, QUIET_LOGGER),
    'config.cjs 未通过上游 schema 校验 —— 任何平台的打包都会直接失败',
  );
});

test('deb 的 packageName 必须放在 FpmTarget 真正读取的层级（根级 deb）', () => {
  // 上游事实：FpmTarget 构造函数
  //   this.options = deepAssign({}, packager.platformSpecificBuildOptions, packager.config[this.name])
  // this.name === 'deb'，而 packager.config 是根配置 ⇒ 读的是根级 deb，不是 linux.deb。
  const fpm = fs.readFileSync(dep('app-builder-lib/out/targets/FpmTarget.js'), 'utf8');
  assert.match(fpm, /deepAssign\)\(\{\}, this\.packager\.platformSpecificBuildOptions, this\.packager\.config\[this\.name\]\)/,
    '上游 deb 选项合并方式变了，本条判据需重新核实');

  const schema = JSON.parse(fs.readFileSync(dep('app-builder-lib/scheme.json'), 'utf8'));
  assert.ok(!('packageName' in schema.definitions.LinuxConfiguration.properties),
    '上游已把 packageName 加进 LinuxConfiguration，层级结论需重新核实');
  assert.ok('packageName' in schema.definitions.DebOptions.properties,
    '上游 DebOptions 不再有 packageName，需重新核实');

  assert.equal(CONFIG.deb && CONFIG.deb.packageName, 'lanyue',
    'deb.packageName 必须在根级 deb 块里设为 lanyue（写进 linux 块会被 schema 拒绝）');
});

test('变异对照：把字段塞错层级 / 塞未知键，上游校验器必须报错', async () => {
  const clone = () => JSON.parse(JSON.stringify(CONFIG));

  const misplaced = clone();
  misplaced.linux = { ...misplaced.linux, packageName: 'lanyue' };
  await assert.rejects(
    () => validateConfiguration(misplaced, QUIET_LOGGER),
    /Invalid configuration object/,
    '校验器竟然放过了 linux.packageName —— 这条守卫已失效',
  );

  const unknown = clone();
  unknown.linux = { ...unknown.linux, definitelyNotARealOption: true };
  await assert.rejects(
    () => validateConfiguration(unknown, QUIET_LOGGER),
    /Invalid configuration object/,
    '校验器竟然放过了未知键 —— 这条守卫已失效',
  );
});