import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

// 新渲染层（Vue3 · T3 极光玻璃）专用构建入口。
// 与 vite.config.mjs（旧基线）完全隔离：新应用构建到 dist/renderer，即主进程
// 默认加载的入口；旧层由 vite.config.mjs 构建到 dist/renderer-legacy，
// 仅作 LY_RENDERER_DIR 的应急回退（发布包内必须一并携带）。
// 渲染层不碰 Node（只消费 preload 注入的 window.musicAPI），
// 所以这里不需要 vite-plugin-electron-renderer。
const projectRoot = process.cwd();

export default defineConfig({
  root: path.resolve(projectRoot, 'src/renderer/app'),
  base: './',
  plugins: [vue()],
  build: {
    outDir: path.resolve(projectRoot, 'dist/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '#app': path.resolve(projectRoot, 'src/renderer/app'),
      '@': path.resolve(projectRoot, 'src'),
    },
  },
  server: { port: 5181, strictPort: true },
});
