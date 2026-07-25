import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

const extensionIcons = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
} as const;

export default defineManifest({
  manifest_version: 3,
  name: "Tunta 屯獭",
  version: pkg.version,
  description: "让积灰的收藏重新可用：收藏、回看、调用，始终回到原始证据。",
  permissions: ["activeTab", "tabs", "storage", "clipboardRead", "scripting", "alarms"],
  optional_host_permissions: ["https://*/*", "http://*/*"],
  action: {
    default_title: "收藏到 Tunta",
    default_popup: "popup.html",
    default_icon: extensionIcons,
  },
  options_page: "index.html",
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  icons: extensionIcons,
});
