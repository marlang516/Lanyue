# 前端界面重构：迁移与回退说明（2026-11-07）

## 已完成

以 `src/renderer/app/` 为唯一新前端（Vue 3 + Vite + T3 极光玻璃），覆盖：

- 外壳：图标导航轨、顶栏搜索、窗口控制、命令面板（`Ctrl+K`）、全局 Toast / 确认框
- 发现（平台分区、推荐歌单、播放状态卡；A/B/C 布局切换已移除）
- 搜索（单曲/专辑/歌手、平台与音质、历史、排序、分页、批量选择、专辑/歌手详情）
- 曲库（目录选择/增量扫描、格式/音质/关键词过滤、排序、批量、回收站删除）
- 下载（队列实时进度、暂停/继续/取消/重试/排序、历史分页/筛选/失联标记）
- 最近播放（复用旧 `recentlyPlayed` 偏好键，切换界面不丢）
- 歌单（收藏系统歌单、自建歌单、去重、导出 M3U、回收站恢复）
- 播放器（播放条、播放队列抽屉、倍速/音质/音量、媒体会话、托盘与桌面歌词同步）
- 全屏播放页（封面 + 滚动歌词 + 偏移微调 + 跳转行）
- 设置（外观/播放/下载/账号/高级/关于 六个页签，含 Cookie、模板、更新、数据导入导出；布局与响度归一已移除）

## 构建入口

- 新层：`npm run build:app` → `dist/renderer`
- 旧层（回退）：`npm run build:legacy` → `dist/renderer-legacy`
- 完整构建：`npm run build`（新层 + 旧层 + 主进程 + preload + postbuild）
- 开发预览（浏览器，无 Electron）：`npm run dev:app`（端口 5181）
- 桩数据截图台：`concept/v2-preview.html`（引用 `dist/renderer/assets`）

主进程默认加载 `dist/renderer/index.html`（新层）；旧层源码保留，随时可构建回退。

## 回退

1. `npm run build:legacy`
2. 启动时设置环境变量：
   ```powershell
   $env:LY_RENDERER_DIR = (Resolve-Path 'dist/renderer-legacy')
   npm start
   ```
3. 去掉该变量即恢复新层。

## 门禁

`test/app-renderer-contract.test.js`：

- IPC 只允许经 `core/bridge.js`
- 入口 CSP 必须放行 `lanyue-stream:`
- 导航 id 与 `App.vue` 视图映射一一对应
- CSS 令牌引用必须已定义
- 主视图文件齐全
- 主进程默认入口指向新层
- `new Audio()` 只允许出现在 `stores/player.js`


## 2026-11-07 功能下线

按要求从新界面移除并删除相关实现：

- AI 助手、AI 创作
- 订阅更新（导航、视图、store、命令面板入口全部移除；主进程后台订阅轮询已停，IPC 保留供旧层回退）
- 格式转换（工具页与 store 删除）
- 首页 A/B/C 布局切换（固定为 A 布局，设置页对应选项已删除）

旧渲染层（dist/renderer-legacy）未改动，仅作应急回退。

## 已知边界

- 旧层 7 套主题在新层收敛为浅色/深色两套（T3 极光玻璃）。
- 迷你播放器与桌面歌词仍是独立页面，本次未改其文件，只保证同步事件继续发送。
- 下载队列首次快照由主进程 `did-finish-load` 补发，重启后无需再进入下载页才看到遗留任务。
- 旧层源码与测试暂时保留，待新层稳定运行一个版本后统一删除。