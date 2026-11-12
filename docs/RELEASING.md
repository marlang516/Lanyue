# 发版与仓库运维手册

面向维护者。覆盖：远端初始化、分支保护、发版、代码签名接入。

---

## 一、远端状态（2026-10-23 已核实）

> 本节曾写作「只有本地 3 个提交，没有远端」，那是更早的事实。现已接入，实测状态如下：

| 项 | 实测值 |
|---|---|
| 远端 | `origin` = `https://github.com/maliang04110233-dot/Lanyue.git`（与 `build/config.cjs` 的 publish 段一致） |
| 远端默认分支 | `main` |
| 本地分支 | `master`、`backup/local-1.0.36`（均指向 `a462edc`）、`release/1.0.36`（当前，跟踪 `origin/main`，**ahead 21**） |
| CI 反馈 | `.github/workflows/` 已就位，但是否真正产出过结果需在仓库 Actions 页核对——**本地流程不以 CI 为前提** |

**分支名不一致是既有事实**（本地 `master` vs 远端 `main`）。推送时显式指定跟踪分支，不要依赖默认：

```bash
git push -u origin release/1.0.36:main      # 明确「本地分支 → 远端分支」
```

> 为什么不再用 `git push -u origin master`：远端没有 `master`，那样推会新建一个平行分支，
> 于是同一份历史出现两个「主线」，后续所有 tag 与 PR 的基线都会分叉。

### 首次接入时的原始步骤（留档，已执行过，勿重复执行）

```bash
# 1. 加远端（仓库名与 build/config.cjs 的 publish 段一致，改名会让
#    已装客户端的 app-update.yml 指向旧地址，靠 GitHub 重定向续命）
git remote add origin git@github.com:maliang04110233-dot/Lanyue.git

# 2. 推历史（不要用 --depth：浅历史会让 tag 无法正确解析）
git push -u origin master

# 3. 确认 CI 真的跑起来了
#    GitHub 仓库页 → Actions → CI workflow
```

> **为什么强调「不要浅推」**：tag 指向的是具体提交，浅克隆拿不到完整对象图时，
> `git push --tags` 会失败，而发布流程的一切都建立在 tag 上。

远端默认分支已是 `main`；本地 `master` 是历史遗留名字，二者不是同一分支。统一口径：
**以 `origin/main` 为唯一主线**，本地提交用「本地分支 → 远端 main」的显式映射推送，
不要再 `git branch -M`（重命名已跟踪分支会让 21 个既有提交的 upstream 记录失效）。

```bash
git fetch origin
git log --oneline HEAD..origin/main    # 先看远端有没有你不知道的提交
```

---

## 二、分支保护（推远端后立刻配）

仓库设置 → Branches → Add rule，对 `main`（或 `master`）：

| 项 | 建议值 | 理由 |
|---|---|---|
| Require a pull request | ✅ | 至少 1 位 reviewer（单人项目可开 "Dismiss stale reviews"） |
| Require status checks | ✅ `CI / Lint & Unit Tests`、`CI / Build & Asar Smoke` | 状态检查不过不许合 |
| Require branches to be up to date | ✅ | 避免合入时又落后主分支 |
| Block force pushes | ✅ | 本项目的历史里有 2026-09 的重命名事故，重写会让 bisect 失效 |
| Allow deletions | ❌ | 删主分支等于删项目 |
| Restrict who can push | ✅ | 含 tag 推送权限（发版只有一个人做） |

**关于 tag 保护**：Rulesets 里可限制 tag 匹配 `v*` 的创建权限。这一条比分支保护更重要
—— 发布出去的版本无法撤回。

---

## 三、发版流程

### 自动（tag 驱动，推荐）

```bash
# 1. 改版本号（同时同步 package-lock.json 的 version）
node scripts/version-bump.js            # patch；也可手改 package.json 后
                                       # npm install --package-lock-only 同步 lock

# 2. 写 CHANGELOG（本仓库强制：workflow 会检查 "## [版本]" 条目是否存在）
$EDITOR CHANGELOG.md

# 3. 提交 + 打 tag（tag 版本必须等于 package.json version，workflow 会硬校验）
git add -A && git commit -m "release: v1.0.37"
git tag -a v1.0.37 -m "v1.0.37"
git push origin HEAD:main --follow-tags      # 本地当前分支 → origin/main，带 tag
```

流水线随后会：校验 tag ↔ package.json ↔ package-lock 三方一致 → 检查 CHANGELOG 条目
→ 跑 lint/audit/单测 → 真实打 NSIS + 便携版 → asar 冒烟 → **生成草稿 Release**。

### 最后一步是人工的，且必须人工

草稿 Release 建好后，去 Releases 页面确认三件事再点 Publish：

1. 安装包能正常安装并启动（别只看上传成功）
2. 包内版本号与 tag 一致
3. `latest.yml` 里的 `sha512` 与实际文件匹配 —— electron-updater 完全依赖它

**Publish 之后自动更新会立刻把这个版本推给所有已装用户，没有反悔余地。**

### 回滚

已发布版本无法回滚（用户已下载）。能做的是：

- **功能出问题**：立刻发一个新版本修（patch 或 minor）
- **发现签名/校验问题**：把 `useMirrorFeed` 的闸门收紧（fail-closed 已默认开启）
- **Release 本身出问题**：删除 Release 草稿（未 publish 前可随意删）

---

## 四、代码签名接入（当前未启用）

### 现状与后果

安装包**未做代码签名**，因此：

- `verifyUpdateCodeSignature: true` 这个开关**不产生实际约束**（产物无 `publisherName`，
  electron-updater 的校验逻辑读不到信任锚就按「放行」处理）
- 第三方镜像兜底已被 `src/main/updateMirror.js` 的 fail-closed 闸门拦下（检测到无
  `publisherName` 直接拒绝切换 feed），所以最危险的路径已经堵住
- 但走 GitHub 直连时，安装包仍是在「没有签名校验」的状态下被安装的
- Windows 会显示 SmartScreen 提示（影响首次安装体验）

### 采购到证书后要做的事

1. **配置签名**（`build/config.cjs` 的 `win` 段）：

   ```js
   win: {
     // ...已有配置
     certificateFile: process.env.WIN_CERT_PFX || undefined,      // 或直接写路径
     certificateSubjectName: process.env.WIN_CERT_SUBJECT || undefined,
     // 时戳服务器：没有它签名虽有效但会被「未做可信时间戳」质疑
     timeStampServer: 'http://timestamp.digicert.com',
   }
   ```

   建议走环境变量而不是把路径写进配置：证书路径是本机事实，不该进仓库。

2. **CI 里注入证书**（`release.yml` 的 build 步骤）：

   ```yaml
   - name: 还原证书
     run: echo "${{ secrets.WIN_CERT_PFX_BASE64 }}" | base64 -d > $RUNNER_TEMP\cert.pfx
   - name: Package
     run: npx electron-builder --config build/config.cjs --win --x64 --publish never
     env:
       CSC_LINK: ${{ runner.temp }}\cert.pfx
       CSC_KEY_PASSWORD: ${{ secrets.WIN_CERT_PASSWORD }}
   ```

   证书与口令放仓库 Secrets，**不要**提交进仓库。

3. **验证签名真的生效**（关键：不要只看配置写了什么）

   ```powershell
   # 产物必须带 publisherName —— 它是 electron-updater 唯一的校验对象
   Get-Content release\win-unpacked\resources\app-update.yml
   # 安装包签名状态必须是 Valid
   Get-AuthenticodeSignature 'release\Lanyue-Setup-1.0.36.exe' | Format-List Status,SignerCertificate
   ```

4. **同步更新**：

   - `test/update-signature-guard.test.js` 的 `RECORDED_STATE`
   - `SECURITY.md` 第四节的「已知未闭合项」
   - `CHANGELOG.md` 的「安全」小节
   - 确认后镜像兜底闸门会自动放行（`isMirrorFeedTrusted` 读的就是 `publisherName`），
     可按需决定是否恢复镜像兜底

5. **顺带摘掉一处**：现在更新页常驻显示「当前更新包未启用安装包签名校验」
   （`settings.about.updateSecurityHint`），签名生效后应改文案或隐藏。

---

## 五、日常维护

### 依赖更新

`.github/dependabot.yml` 已配置（周更 runtime / 月更 dev+CI，分组提交）。
合并前必跑：

```bash
npm run verify     # 含 lint / 单测 / dead-deps / icons / build / asar 冒烟
```

特别注意 **electron 大版本升级**：可能让 `build/config.cjs` 里那批「死依赖排除」的
假设失效（jade 链等），那只在打包后才暴露，所以 electron 组单独成 PR、人工验证。

### 本机钩子

```bash
npm run setup:hooks          # 安装 pre-commit 质量闸门
npm run setup:hooks -- --check   # 只看状态
SKIP_HOOKS=1 git commit ...      # 紧急绕过
```

### 性能基线

```bash
npm run bench -- --save      # 生成基线（不入库，见 .gitignore）
npm run bench -- --check     # 与基线对比，劣化超阈值则退出码 1
```

---

## 六、检查清单（发版前）

- [ ] `node scripts/version-bump.js` 后 `package.json` 与 `package-lock.json` 版本一致
- [ ] `CHANGELOG.md` 有本次 `## [版本]` 条目，且「安全」小节与实际改动一致
- [ ] `npm run verify` 全绿
- [ ] `npm run bench -- --check` 无显著劣化
- [ ] 真机冒烟**裸跑一次**（等同用户双击，不加任何旗标）：
      `SMOKE_LAUNCH_VIA_SHELL=1 node scripts/smoke-test-manual.js "<安装目录>\Lanyue.exe"`
      必须 **8/8** 且汇总行显示「渲染层: 已加载（loadFile done）」——该模式经 `explorer.exe` 代理启动，
      父子链落在真实桌面会话，渲染进程沙箱可正常初始化（直启在受限环境下必然白屏，见 `docs/process/QA.md` §四）
- [ ] 本地跑一次安装包（Windows）：安装、启动、搜索、入队、下载、播放、更新检查
- [ ] tag 与版本一致，且 tag 推送权限受保护

---

## 七、跨平台产物（Linux / macOS）：现状与验证边界

### 结论先说

**只发 Windows。** `build/config.cjs` 里的 linux / mac 两段配置已修正到「能打出
品牌正确、内容完整的产物」，但**运行期从未在非 Windows 上验证过**。
配置齐全 ≠ 验证过 —— 这两件事必须分开说。

要验证就手动跑 **Cross-Platform Build** 流水线
（`.github/workflows/cross-platform-build.yml`，只手动触发、`--publish never`、
不引用任何 secrets、产物只留 Action artifact 14 天）。它不会进 GitHub Releases，
也就不会被 electron-updater 推给已装用户。

### 已实测（2026-11-12，Windows 宿主，electron-builder 26.15.3）

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| `npm run build` | ✅ 通过 | Vite 双配置 + postbuild 全部完成 |
| `--linux --x64` **打包阶段** | ✅ 通过 | `release/linux-unpacked/` 里是真正的 ELF x86-64 可执行文件（`od -c` 验过魔数），含 `app.asar`、`resources/scripts/`、`app-update.yml` |
| asar 冒烟（对 **Linux** 产物） | ✅ 18/18 | `node scripts/smoke-asar.js release/linux-unpacked/resources/app.asar` —— 8 个平台模块齐备、249 个生产依赖全在、渲染层 bundle 锚点齐、图标无水印 |
| AppImage **封装阶段** | ❌ 失败 | `spawn …/appimage-12.0.1/darwin/mksquashfs ENOENT` |
| deb **封装阶段** | ❌ 失败（宿主限制） | 修 author 前报 `Please specify author 'email'`；**修后复跑已越过该阻断**，日志为 `building target=deb arch=x64 file=release\Lanyue-1.1.2-amd64.deb`，只剩 `spawn fpm ENOENT` —— Windows 宿主没有 fpm，需在 Linux 上打 |
| macOS 产物 | ⛔ 无法在此宿主验证 | dmg 依赖 macOS 的 `hdiutil`，Windows 上打不出来 |

**AppImage 失败的真实根因**（不是本仓配置问题）：
`app-builder-lib/out/toolsets/linux.js:104` 写的是
`process.platform === "linux" ? \`linux-${hostArch}\` : "darwin"` ——
非 Linux 宿主一律取 `darwin` 工具目录，而 appimage 工具包只带 darwin / linux 版
`mksquashfs`，没有 Windows 版。deb 同理：`getFpmPath()` 在 win32 上返回裸 `fpm`，
要求宿主 PATH 里自备。

⇒ **Linux 产物必须在 Linux 宿主上打，macOS 产物必须在 macOS 上打。**
生产依赖树全是纯 JS（无 `.node` / `binding.gyp`，已由
`test/cross-platform-packaging.test.js` 钉住），所以不需要交叉编译 native 模块 ——
这也是「在 Windows 上能打出 linux-unpacked」的原因。

### 本轮修掉的真实缺陷

1. **`package.json` 的 author 没有 email** → deb 打包在**任何平台**都直接失败
   （`FpmTarget.js:85-93` 要 `author.email` 当 Maintainer）。已改为
   `{ name, email }` 对象形态。
2. **`extraResources` 用 `*.py` 通配** → 把开发期脚本一起发给了最终用户：
   `add-try-catch.py`（给 JS 源码加 try/catch 的 codemod）与 `convert_audio.py`
   （旧转码兜底，`src/` 里零引用 —— 转码链路早已直接走 ffmpeg，见
   `src/utils/audioConvert.js`）。已改为逐个点名，只带 `write_tags.py`。
   ⚠️ 这两项在**已发布的 Windows 版本里就有**，属产物卫生缺陷，不是跨平台专属。
3. **mac `artifactName` 用 `${name}`** → 打出 `music-downloader-*.dmg`（旧品牌）。
   已改为 `Lanyue-${version}-${os}-${arch}.${ext}`，与 nsis 同口径。
4. **Linux 可执行名与产物名回落到包名** → 实测可执行文件叫 `music-downloader`、
   deb 叫 `music-downloader_1.1.2_amd64.deb`，而 AppImage 却叫 `Lanyue-1.1.2.AppImage`
   —— 同一平台产物品牌不一致；且缺 `desktopName` / `syncDesktopName`，`.desktop`
   的 `StartupWMClass` 与 Electron 的 `app_id` 对不上，桌面环境无法关联窗口
   （electron-builder 会直接 warn）。已设 `linux.executableName: 'lanyue'` +
   **根级** `deb.packageName: 'lanyue'`（Debian 包名必须全小写）+
   `linux.artifactName: 'Lanyue-${version}-${arch}.${ext}'` +
   `package.json desktopName: 'lanyue.desktop'` + `linux.syncDesktopName: true`。
   修后实测：可执行文件为 `lanyue`，deb 目标文件名为 `Lanyue-1.1.2-amd64.deb`。
   ⚠️ `packageName` 只能写在**根级 `deb` 块**：`FpmTarget` 读的是
   `config[this.name]`（`this.name === 'deb'`），而 `linux` 的 schema 里没有这个键 ——
   写进 `linux` 会让**所有平台**的打包直接 `Invalid configuration object`。
   `test/cross-platform-packaging.test.js` 第 9 节用上游校验器跑真配置兜住这类层级错误。

### 仍未验证（不得当成已验证）

- **运行期全链路**：Linux / macOS 上的启动、搜索、入队、下载、播放、托盘、
  全局快捷键、本地曲库扫描 —— 一次都没跑过。
- **Linux 凭证存储**：`src/utils/secretStore.js` 走 Electron `safeStorage`，
  Linux 上依赖系统密钥环（libsecret / gnome-keyring / kwallet）。**无密钥环时
  进入 insecure 态，拒绝保存 Cookie 与计费密钥**（fail-closed，不是明文降级）——
  用户会看到「本机安全存储不可用」而无法登录。这是发行 Linux 版前必须写进
  用户文档的前置条件。
- **标签写入**：非 MP3 格式依赖用户自备 python + mutagen
  （`src/utils/downloader.js` 按 `py` / `python3` / `python` 顺序探测）。
  安装包不带 Python，缺失时只 warn 并跳过标签写入，下载本身不受影响。
- **自动更新**：electron-updater 26 在 Linux 支持 AppImage / deb / rpm / pacman
  （按 `resources/package-type` 选更新器），macOS **只认 zip**（`MacUpdater.js:81`，
  所以 mac 的 zip 目标不可删）。但镜像兜底闸门 `src/main/updateMirror.js` 读的
  `publisherName` 是 Windows 签名派生字段，非 Windows 产物里恒为 null ⇒
  **镜像兜底在这些平台上永久停用**（fail-closed，直连仍可用）。
- **关机 / 睡眠**：仅 Windows（`src/main/ipc/window.js` 已有平台判断，
  非 Windows 返回明确错误，不是静默失败）。
- **macOS 签名与公证**：未配置，产物未签名，用户首次打开需手动放行。

### 怎么打（在对应宿主上）

```bash
# Linux 宿主
npm ci && npm run build
npx electron-builder --config build/config.cjs --linux --x64 --publish never
node scripts/smoke-asar.js release/linux-unpacked/resources/app.asar

# macOS 宿主（无证书时关掉自动发现，否则打包会因找不到签名身份而失败）
npm ci && npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --config build/config.cjs --mac --x64 --arm64 --publish never
```

契约守卫：`test/cross-platform-packaging.test.js`（含上游事实钉与变异对照，
防止守卫写成恒真式）。改动 linux / mac 配置或 `extraResources` 后必跑。
