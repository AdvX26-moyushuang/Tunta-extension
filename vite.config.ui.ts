import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * UI 专用 dev 配置：纯网页跑工作台，不带 crx 插件。
 *
 * 用 `npm run dev:ui` 启动，配 VITE_TUNTA_API_MODE=mock，
 * 在普通浏览器打开 http://localhost:5273 即可实时调 UI（React HMR）。
 *
 * 为什么不用 npm run dev：
 * crx 插件会把 @crx/inline-script 注入到 index.html，在非扩展上下文里
 * 该脚本返回的是带新时间戳的 HTML 页面本身，浏览器会陷入无限请求循环。
 * mock 层 + browser.ts 的 isExtensionContext() 兜底，就是为了让工作台
 * 能在普通浏览器里独立跑起来做 UI 开发。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // sqlite-wasm 不能被 esbuild 预打包，否则 wasm 路径解析会坏掉
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  // db-worker 用 ESM 独立 chunk 构建，且允许 worker 内的顶层 await
  worker: {
    format: "es",
  },
});
