import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
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
  build: {
    outDir: "dist",
    target: "esnext",
    rollupOptions: {
      input: {
        // manifest 没有直接引用 offscreen 页，需要手动声明为入口
        offscreen: fileURLToPath(new URL("./offscreen.html", import.meta.url)),
      },
    },
    // .wasm 必须作为独立 asset 产出，不能被内联成 base64（CSP 与体积都不允许）
    assetsInlineLimit: (filePath) => (filePath.endsWith(".wasm") ? false : undefined),
  },
});
