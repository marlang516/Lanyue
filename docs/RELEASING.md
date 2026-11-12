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

### 接线已就绪（2026-11-12）——证书到位即自动生效

签名接线已落地，**不需要改 `build/config.cjs`**：electron-builder 原生读取
`WIN_CSC_LINK` / `CSC_KEY_PASSWORD` 环境变量，`.github/workflows/release.yml`
已把仓库 Secrets 映射过去，并配了三道护栏：

- **成对闸门**（build job，打包前）：`WIN_CSC_LINK` 与 `WIN_CSC_KEY_PASSWORD`
  要么都配、要么都不配，半配置直接失败 —— 不会拿空口令去签带口令的 pfx，
  在打包几分钟后才炸出一个指向 signtool 的误导报错；
- **事实钉触发器**（quality job）：单测步骤注入 `WIN_CSC_LINK`（只注入证书、
  不注入口令），证书到位时 `test/update-signature-guard.test.js` 的
  `RECORDED_STATE` 与 `test/update-trust-wording.test.js` 的措辞钉会**变红
  逼停发版** —— 这是设计，不是故障：先把下面清单里的「未启用」措辞全部
  同步，再放行；
- **notes 随事实分支**：草稿 Release 的签名表述按 build job 的 `signed` 输出
  分支，不会在签名生效后继续宣称「未做代码签名」。

未配置 secrets 时一切照旧：环境变量展开为空串，electron-builder 显式按
「无证书」跳过签名，行为与接线前完全一致。

### 采购到证书后要做的事

1. **买证书**：Authenticode 代码签名证书（OV 或 EV，**不是** SSL 证书）。
   OV 便宜但 SmartScreen 信誉要慢慢攒；EV 贵但立即获得 SmartScreen 信誉。
   Azure Trusted Signing（按月订阅）也可行，但需改配置走 `azureSignOptions`，
   不适用本节的环境变量接线。

2. **导出并上传 Secrets**（仓库 Settings → Secrets and variables → Actions）：

   | Secret | 值 |
   |---|---|
   | `WIN_CSC_LINK` | pfx 文件的 base64（PowerShell：`[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))`） |
   | `WIN_CSC_KEY_PASSWORD` | pfx 的导出口令 |

   证书与口令**只放 Secrets，绝不提交进仓库**（`test/release-signing-wiring.test.js`
   钉住 pfx/p12 零入库，secret 只经 env 注入、不进脚本体）。

3. **下一次发版会被事实钉逼停 —— 按清单在一个 PR 内同步全部措辞**：

   - `test/update-signature-guard.test.js`：`RECORDED_STATE` 改为
     `codeSigningConfigured: true`、`verificationEffective: true`（开关保持 true）
   - `test/update-trust-wording.test.js`：设置页提示判据从「必须写未启用」
     翻转为「必须写已启用」，否定对照同步
   - `src/renderer/js/lang/zh.json` / `src/renderer/js/lang/en.json`：
     `settings.about.updateSecurityHint` 改为如实的「已启用」表述
   - `build/config.cjs`：`verifyUpdateCodeSignature` 旁的「当前未启用安装包
     签名校验」注释段改为已生效
   - `SECURITY.md` 第四节第 1 条：从「已知未闭合」改写为已闭合
   - `docs/CODE_REVIEW_2026-09-28.md` 的 P1-1 结论追记闭合
   - `CHANGELOG.md` 的「安全」小节

4. **验证签名真的生效**（关键：不要只看配置写了什么）：

   ```powershell
   # 产物必须带 publisherName —— 它是 electron-updater 唯一的校验对象
   Get-Content release\win-unpacked\resources\app-update.yml
   # 安装包签名状态必须是 Valid
   Get-AuthenticodeSignature 'release\Lanyue-Setup-<版本>.exe' | Format-List Status,SignerCertificate
   ```

   时戳不用配：electron-builder 默认 DigiCert RFC3161 时戳（sha256 嵌套签名），
   证书过期后签名仍有效。

5. **镜像兜底闸门会自动放行**（`src/main/updateMirror.js` 的 `isMirrorFeedTrusted`
   读的就是 `publisherName`），可按需决定是否恢复镜像兜底。

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
