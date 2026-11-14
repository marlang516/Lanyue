# Bees House Rules — Lanyue (揽乐)

## 项目概要
Electron 多平台音乐下载器，8 个音源（网易云/QQ/B站/酷狗/酷我/咪咕/汽水/5sing）。
技术栈：Electron + Vite + 原生 ES Module 渲染层 + node:sqlite。

## 铁律
- 只改 brief 里指定的文件，不碰其他文件
- 改完跑 `npm test` 确认不破坏现有测试
- 改完跑 `npm run lint` 确认没有新 warning
- commit message 格式：`feat(deps):` / `fix:` / `refactor:` 开头，简洁描述
- 不要引入新依赖，除非 brief 明确要求

## 项目约定
- 渲染层是原生 ES Module（无框架），不是 React/Vue
- 数据库用 `node:sqlite`（Electron 内嵌 Node 24+）
- IPC 处理器按域拆分在 `src/main/ipc/` 下
- 平台插件在 `src/api/platforms/`，每个插件有自描述 manifest
- 测试用 `node:test`，文件在 `test/` 目录，命名 `*.test.js`

## 自检命令
```bash
npm test           # 全量测试（380 个文件）
npm run lint       # ESLint
npm run build      # Vite 构建
```
