// 全扩展唯一的 offscreen 文档入口。
// 硬规则 2：整个扩展生命周期内只能有一个 offscreen document，
// Phase 4 的 Readability / pdf.js 也必须挂在这里，不要另建。
// 现在只挂 SQLite worker（Task 1.3 接入）。

console.info("[tunta] offscreen 宿主已就绪");
