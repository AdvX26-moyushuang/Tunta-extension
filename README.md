
<p align="center">
  <img src="apps/frontend/assets/logo-big.png" alt="屯獭 Tunta" width="420">
</p>

<h1 align="center">屯獭 Tunta</h1>

<p align="center">
  <strong>让积灰的收藏重新可用。</strong><br>
  Capture it. Find it. Use it.
</p>

Tunta 把散落在视频、文章和网页里的收藏，变成可以回看、检索、引用，并且能回到原始证据的本地知识库。

收藏动作很轻，价值发生在之后：需要某条信息时，系统不仅要帮你找回来，还要保留原文、时间戳、页面位置和原始 URL，让你能判断它是否可信、是否真的有用。

## 产品闭环

- **收藏 Capture：** 主动保存当前页或粘贴板 URL，并记录「待消化 / 常用」意图。
- **回看 Review：** 把收藏重新呈现为证据卡片，支持打开原文、跳过与归档。
- **调用 Recall：** 用关键词或自然语言检索收藏库，回答必须附带能回到来源的 citation。

AI 负责提取、策展和检索，不替代人的判断。证据不足时应该明确说没找到，而不是用通用知识补出一段看似合理的答案。

## 数据与隐私

- 扩展只在用户主动收藏时读取当前页面，不扫描浏览历史，也不注入常驻 content script。
- 新站点与 provider 域名按 origin 请求 optional host permission，用户可以在浏览器扩展页撤销。
- 收藏状态与本地知识库默认留在浏览器内。
- **Local-first 不等于 offline-only：** 卡片策展、问答和可选 embedding 会把相关文本发送给用户配置的模型服务。
- 清空知识库会删除收藏、原文快照、卡片、问答历史和关系边；provider 设置会保留。
- 失败会保留 source、stage、status 与 error code，不用空卡片或伪摘要隐藏问题。