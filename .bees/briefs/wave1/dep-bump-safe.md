# 升级 6 个安全的 patch/minor 依赖

## 目标
把 package.json 中 6 个安全可升级的依赖升到最新 patch/minor 版本，然后跑测试确认不破坏现有功能。

## 需要改的文件
- `package.json`

## 升级清单
| 包名 | 当前版本 | 目标版本 | 类型 |
|---|---|---|---|
| electron | 44.4.1 | 44.11.3 | patch |
| electron-updater | 6.8.9 | 6.8.11 | patch |
| music-metadata | 12.2.1 | 12.5.0 | minor |
| @vitejs/plugin-vue | 6.0.10 | 6.0.11 | patch |
| vue | 3.5.44 | 3.5.45 | patch |
| vite-plugin-electron | 1.0.4 | 1.2.0 | minor |

## 操作步骤
1. 修改 `package.json` 中以上 6 个包的版本号
2. 运行 `npm install` 更新 lock file 和 node_modules
3. 运行 `npm test` 确认所有 380 个测试通过
4. 运行 `npm run lint` 确认无新增 warning
5. commit

## 验收检查
```bash
npm test && npm run lint
```

## 不要做
- 不要升级以下大版本包（有 breaking risk，留给后续 wave）：
  - @eslint/js (9→10)
  - eslint (9→10)
  - globals (16→17)
  - typescript (5.9→7.0)
  - vite (5→8)
  - vue-tsc (2→3)
  - @types/node (22→26)
- 不要修改任何源码文件
- 不要引入新依赖
