/**
 * electron-builder 配置 — MusicDL
 *
 * 优化要点：
 * 1. ASAR 压缩打包（比 uncompressed 体积小 40%+）
 * 2. NSIS 安装程序：自定义路径/桌面快捷方式/中英文双语
 * 3. 输出目录独立：release/（避免 dist/ 与 Vite 构建产物冲突）
 * 4. 自动更新：GitHub Releases
 * 5. Linux/macOS 配置
 */
module.exports = {
  appId: 'com.musicdl.app',
  productName: 'Lanyue',
  copyright: 'Copyright © 2026 Lanyue',
  directories: {
    output: 'release',
  },

  // ── 文件包含/排除 ──────────────────────────────────
  // 精确列出 Vite 构建产物，避免递归包含 dist/ 自身
  files: [
    'dist/main/**/*',
    'dist/preload/**/*',
    'dist/renderer/**/*',
    // 旧渲染层回退产物。主进程支持 LY_RENDERER_DIR 显式指回 dist/renderer-legacy，
    // 但开关指向的目录若没打进包，回退就是空头承诺 —— 新层渲染故障时用户无路可退。
    'dist/renderer-legacy/**/*',
    'dist/api/**/*',
    'dist/utils/**/*',
    'dist/shared/**/*',
    // scripts 不进 asar：Python 标签/转码脚本运行时从 resourcesPath/scripts 取
    // （src/utils/downloader.js 的路径解析第二候选），由下方 extraResources 提供
    'assets/**/*',
    'package.json',
    // ⚠️ package-lock.json 无法通过这里打进包 —— app-builder-lib 在
    // fileMatcher 的默认忽略清单里硬编码排除了它（连同 yarn.lock /
    // pnpm-lock.yaml / bun.lock），优先级高于本 files 数组，写了也无效。
    // 故版本号一致性只能靠 scripts/version-bump.js 在源头同步，
    // 并由 scripts/smoke-asar.js 以「缺失即跳过」的方式记录，不当作失败。
    '!**/test/**',
    '!**/__tests__/**',
    '!**/*.map',
    '!**/*.tsbuildinfo',

    // ── 剔除 jade 模版引擎依赖链（asar 减重 3.70 MB / 10.1%）──────
    // 来源：qq-music-api 的 dependencies 声明了 jade ~1.11.0，但该 SDK
    // 被本仓使用的入口是 node/index.js（main 字段），其 require 链为
    //   node/index.js → ./routes、../util/cache、../util/request
    // 全程不碰 jade；jade 只服务于该 SDK 自带的 express web server
    // （server.js，本仓从不加载）。属上游多声明的装饰性依赖。
    //
    // 判定依据（三重验证，均可复现）：
    //   1. 运行时插桩：hook Module._load 遍历 src/ 全部 58 个模块 +
    //      两个 SDK 入口，jade 及下列包**从未被 require**；
    //   2. 静态扫描：全仓（src + 各 SDK + express 等）grep jade 链包的
    //      require 点，jade 链外部命中数为 0；
    //   3. 归属确认：uglify-js / with / clean-css / transformers /
    //      constantinople 仅被 jade 引用，source-map 与 acorn 亦只被
    //      uglify-js 引用，均无旁路依赖。
    //
    // ⚠️ 与 express 的区别：express 虽也只被 server.js 使用，但
    // @neteasecloudmusicapienhanced/api 的 main.js 末尾有一句**无条件的**
    //   Object.assign(module.exports, require('./server'))
    // 会在加载即拉入 express 整棵树 —— 故 express/body-parser/raw-body/
    // finalhandler/serve-static 等**不可删**。切勿照着「server 才用」
    // 的直觉一刀切。
    //
    // 换装后实测（2026-11-12，运行时插桩）：真正被加载的是 express 5.3.0 /
    // body-parser 2.4.0 / path-to-regexp 8.4.2，三者均无 advisory。
    // audit 报 high 的 express 4.16.4 与 4.22.3 分别来自 qq-music-api 与
    // unblockmusic-utils 各自内置的树，从不被加载（qq 入口插桩零命中；
    // unblock 只在从未启动的 server 路由回调里 require）——
    // 见 scripts/audit-allowlist.json 的 upstream_locked_server_never_launched 组。
    //
    // 维护提示：若将来升级 qq-music-api 到改用 jade 渲染的接口，需先
    // 运行 scripts/check-dead-deps.cjs 复验，再移除本段排除项。
    '!node_modules/jade/**',
    '!node_modules/uglify-js/**',
    '!node_modules/with/**',
    '!node_modules/clean-css/**',
    '!node_modules/transformers/**',
    '!node_modules/constantinople/**',
    '!node_modules/character-parser/**',
    // ⚠️ is-promise **故意不在排除清单里**（2026-11-12，换装 enhanced fork 后）：
    // 它曾是 jade 链成员（根副本 2.2.2，运行时不加载），但 express 5 的路由层
    // router@2.2.0 依赖 is-promise@4.0.0，且 SDK main.js 末尾无条件
    // require('./server') 会在启动时就加载它。electron-builder 的
    // !node_modules/is-promise/** 会连嵌套副本一起删 —— 实测排除它之后
    // 打包产物启动即弹「Cannot find module 'is-promise'」、main.log 零增量。
    // 根副本随之进包的体积代价可忽略；回归钉在 test/dead-deps-scanner.test.js。
    '!node_modules/jstransformer/**',
    '!node_modules/promise/**',
    '!node_modules/asap/**',
    '!node_modules/acorn/**',
    '!node_modules/acorn-globals/**',
    '!node_modules/css/**',
    '!node_modules/css-parse/**',
    '!node_modules/css-stringify/**',
    '!node_modules/void-elements/**',
    '!node_modules/align-text/**',
    '!node_modules/center-align/**',
    '!node_modules/right-align/**',
    '!node_modules/longest/**',
    '!node_modules/repeat-string/**',
    '!node_modules/kind-of/**',
    '!node_modules/lazy-cache/**',
    '!node_modules/uglify-to-browserify/**',
    '!node_modules/window-size/**',
    '!node_modules/amdefine/**',
    '!node_modules/optimist/**',
    '!node_modules/wordwrap/**',
    '!node_modules/decamelize/**',
    '!node_modules/source-map/**',
  ],

  // ── ASAR 压缩 ──────────────────────────────────────
  asar: true,
  asarUnpack: ['**/*.node'],
  compression: 'maximum',

  // ── Windows ────────────────────────────────────────
  win: {
    icon: 'assets/icon.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    // ⚠️ 不得关闭（2026-09 审计 P0）。
    // 这一项是 electron-updater 在 Windows 上校验安装包签名的开关，默认即 true。
    // 曾经被显式置为 false：配合 src/main/updateMirror.js 的第三方镜像兜底
    // （ghproxy / gh.ddlc），等于把「更新包由谁提供」的信任根交给网络中间人 ——
    // 镜像或链路被劫持即可静默安装未签名程序。签名校验是镜像兜底能存在的前提。
    //
    // ── 当前未启用安装包签名校验 ──────────────────────────────
    // 上面那句「不得关闭」描述的是**这个开关的意图**，不是当前的实际效果。
    // 现状（2026-09-28 复审 + 2026-09-29 复核，见 test/update-signature-guard.test.js）：
    //   electron-updater/out/NsisUpdater.js:84-99 先读产物 app-update.yml 的
    //   publisherName，取不到就 return null，调用方只在**非 null** 时才抛
    //   ERR_UPDATER_INVALID_SIGNATURE —— null 的语义是「无签名信息 → 放行」。
    //   而 publisherName 只有在配置了代码签名证书时才会被 electron-builder 写入；
    //   本仓库目前无任何证书配置，产物里没有这个字段。
    // ⇒ **这个开关当前不产生实际约束，更新包的真实信任根尚未收敛到自有证书。**
    //
    // 因此：留 true 是为了证书到位那天直接生效，不是为了「现在有防护」。
    // 改证书配置时，请同步核对 test/update-signature-guard.test.js 的 RECORDED_STATE
    // 与设置页的常驻提示（当前显示「未启用安装包签名校验」）。
    verifyUpdateCodeSignature: true,
  },

  // ── NSIS 安装程序 ──────────────────────────────────
  nsis: {
    // 产物名：v1.0.33 及更早发布为 MusicDL-Setup-*（旧品牌），v1.0.34 起改用 Lanyue-*。
    // 此前"钉死旧名"的理由是"已发布的 latest.yml / Release 资产直接引用它们"——
    // 那条约束其实只对**已发布**的版本成立，改名因此是安全的：
    //   ① 每次发版重新生成 latest.yml，它指向的是本次自己的产物名，自洽；
    //   ② 旧资产不会被删除，旧下载 URL 继续可达（v1.0.33 的链接照常有效）；
    //   ③ appId 与包名（→ updaterCacheDirName）都没动 ⇒ 升级链与更新缓存目录不受影响。
    artifactName: 'Lanyue-Setup-${version}.${ext}',
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '揽乐',
    allowElevation: true,
    runAfterFinish: true,
    // 2026-10-24：由 true 改为 false（3cfc2aa 打包初期的随手默认，从未被决策）。
    // userData（%APPDATA%\Lanyue）里是 DPAPI 加密的登录 Cookie（cookies.json）与
    // prefs.json（歌单/播放统计/AI key/全部设置）——assisted 安装器的更新流程是
    // 「卸旧装新」，true 时卸载器把 userData 连根删掉 ⇒ 每次装更新后全平台登录、
    // 歌单、设置全部归零（用户实测反馈「每次安装更新后都需要登录」）。
    // false 后卸载不动用户数据；确要清空的用户手动删 %APPDATA%\Lanyue 即可。
    // ⚠️ 时序提醒：本修复生效的前提是「新版本的卸载器」在跑——从旧版本
    // （1.0.36 及更早，仍是 true）升级到本版本的最后一次更新仍会清一次数据，
    // 从本版本起之后的更新不再清。
    deleteAppDataOnUninstall: false,
    installerHeaderIcon: 'assets/icon.ico',
    installerIcon: 'assets/icon.ico',
    uninstallerIcon: 'assets/icon.ico',
    license: 'LICENSE',
    installerLanguages: ['zh_CN', 'en_US'],
    // 品牌图片（NSIS 2.0 风格：顶部横幅 + 左侧边栏）
    installerHeader: 'build/installerHeader.bmp',
    installerSidebar: 'build/installerSidebar.bmp',
  },

  // ── Linux ──────────────────────────────────────────
  // ⚠️ electron-builder 26 起 schema 已移除 `linux.desktop`（自定义 .desktop 字段）。
  // 校验是全 config 生效的 —— 即使只打 --win，残留该字段也会直接
  // 「Invalid configuration object」打包失败。Name/Categories 由 productName 与 category 自动生成。
  linux: {
    icon: 'assets',
    // 可执行名默认取 package.json 的 name（linuxPackager.js:16 →
    // sanitizedName.toLowerCase()），实测打出的是 music-downloader，与品牌
    // Lanyue 不一致；.desktop 的 Icon 字段也取这个名字，必须显式钉住。
    executableName: 'lanyue',
    // 产物名不用 ${name}：deb 的默认模板是 ${name}_${version}_${arch}.${ext}，
    // ${name} 取 package.json 的 name —— 实测未设时打出
    // music-downloader_1.1.2_amd64.deb，而 AppImage 却叫 Lanyue-1.1.2.AppImage，
    // 同一平台两个产物品牌不一致。故显式钉住（Debian 控制文件里的包名另见下方 deb 块）。
    artifactName: 'Lanyue-${version}-${arch}.${ext}',
    // 与 package.json 的 desktopName（lanyue.desktop）配对：Electron 在 Linux
    // 上用 desktopName 当 app_id / WM_CLASS，.desktop 的 StartupWMClass 必须
    // 与之相同，否则桌面环境无法把运行中的窗口关联到菜单条目（图标错乱/重复）。
    // 不开这项时 electron-builder 会直接 warn（实测 2026-11-12）。
    syncDesktopName: true,
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    category: 'AudioVideo',
  },

  // deb 专属选项必须在**根级** deb 块，不能写进 linux：
  // FpmTarget 构造函数是 deepAssign({}, platformSpecificBuildOptions, config[this.name])，
  // this.name === 'deb' 且 config 是根配置 ⇒ 只认根级 deb。
  // 而 linux 的 schema 里没有 packageName 键，写错层级会让**所有平台**的打包
  // 直接「Invalid configuration object」（2026-11-12 实测踩过）。
  deb: {
    // Debian 控制文件的包名，默认取 appInfo.linuxPackageName（= package.json 的
    // name，即 music-downloader）。必须全小写：Debian 包名只允许小写字母/数字/+/-/.，
    // 大写会被 dpkg 拒绝。
    packageName: 'lanyue',
  },

  // ── macOS ──────────────────────────────────────────
  mac: {
    icon: 'assets/icon.png',
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      // zip 不可删：electron-updater 的 MacUpdater 只认 zip
      // （MacUpdater.js:81 findFile(files,"zip",…)，取不到就报错），
      // 只发 dmg 等于 macOS 自动更新直接失效。
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    category: 'public.app-category.music',
    // 不用 ${name}：它取 package.json 的 name（music-downloader），会打出
    // 旧品牌产物名。与 nsis.artifactName 同一口径，显式写 Lanyue。
    // 含 ${arch} 是硬要求：x64 与 arm64 两个包否则同名互相覆盖。
    artifactName: 'Lanyue-${version}-${os}-${arch}.${ext}',
  },

  // ── 自动更新（GitHub Releases）─────────────────────
  publish: {
    provider: 'github',
    owner: 'maliang04110233-dot',
    repo: 'Lanyue',
    private: false,
    releaseType: 'release',
  },

  // ── 额外资源 ───────────────────────────────────────
  // 只带运行期真正执行的 Python 脚本：write_tags.py（非 MP3 格式的标签写入，
  // 见 src/utils/downloader.js 的 embedTagsWithPython）。
  //
  // ⚠️ 不得用 `*.py` 通配（2026-11-12 实测修正）：scripts/ 下另两个 .py
  // 都是开发期工具，src/ 里零引用，通配会把它们一起发给最终用户 ——
  //   add-try-catch.py  给 JS 源码批量加 try/catch 的 codemod
  //   convert_audio.py  旧转码兜底；转码链路早已直接走 ffmpeg
  //                     （src/utils/audioConvert.js），这个脚本没人调
  // 旧注释曾声称 convert_audio.py 是「应急转码兜底」，与代码事实不符。
  // 17 个开发期 js 脚本同样不随包分发（2026-09 审计产物卫生项）。
  extraResources: [
    { from: 'scripts/', to: 'scripts/', filter: ['write_tags.py'] },
  ],
};
