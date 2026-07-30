// Readability 正文解析（计划 §Task4.1）：只在 offscreen 文档里运行。
// HTML 字符串 → DOMParser detached document → Readability → ArticleParseBlock[]。
// Readability 失败或产出过少时退回整页 DOM 扫描（老手写提取的同款规则）。
import { Readability } from "@mozilla/readability";
import type { ArticleParseBlock, ArticleParseResult } from "@/shared/parse-rpc";

const MAX_BLOCKS = 160;
const MIN_BODY_TEXT = 30;

function collectBlocks(root: ParentNode): ArticleParseBlock[] {
  const blocks: ArticleParseBlock[] = [];
  const seen = new Set<string>();
  const push = (kind: ArticleParseBlock["kind"], raw: string) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    blocks.push({ kind, text: text.slice(0, 2000) });
  };
  const nodes = root.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,pre,figcaption");
  for (const node of Array.from(nodes)) {
    const tag = node.tagName.toLowerCase();
    // detached document 没有布局，innerText 不可用，统一走 textContent
    const text = node.textContent ?? "";
    const isHeading = /^h[1-4]$/.test(tag);
    if (!isHeading && text.replace(/\s+/g, " ").trim().length < MIN_BODY_TEXT) continue;
    push(
      isHeading ? "heading"
        : tag === "li" ? "list_item"
        : tag === "blockquote" ? "quote"
        : tag === "pre" ? "code"
        : tag === "figcaption" ? "caption"
        : "paragraph",
      text,
    );
    if (blocks.length >= MAX_BLOCKS) break;
  }
  return blocks;
}

/** 整页扫描兜底：article/main 优先，行级兜底与老提取逻辑一致。 */
function fallbackBlocks(doc: Document): ArticleParseBlock[] {
  const root =
    doc.querySelector("article") ??
    doc.querySelector("main") ??
    doc.querySelector("[role=main]") ??
    doc.body ??
    doc;
  const blocks = collectBlocks(root);
  if (blocks.length < 3 && doc.body) {
    const seen = new Set(blocks.map((block) => block.text));
    for (const line of (doc.body.textContent ?? "").split(/\n+/)) {
      const text = line.replace(/\s+/g, " ").trim();
      if (text.length < MIN_BODY_TEXT || seen.has(text)) continue;
      seen.add(text);
      blocks.push({ kind: "paragraph", text: text.slice(0, 2000) });
      if (blocks.length >= 80) break;
    }
  }
  return blocks;
}

export function parseArticleHtml(html: string, url: string): ArticleParseResult {
  // Readability 会原地改写 DOM，兜底扫描要用一份新解析的 document
  const docForReadability = new DOMParser().parseFromString(html, "text/html");
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(docForReadability, { charThreshold: 250 }).parse();
  } catch (cause) {
    console.warn("[tunta] Readability 解析失败，退回整页扫描:", cause);
  }

  if (article?.content) {
    const contentDoc = new DOMParser().parseFromString(article.content, "text/html");
    const blocks = collectBlocks(contentDoc.body ?? contentDoc);
    if (blocks.length >= 3) {
      return {
        title: article.title?.trim() || null,
        author: article.byline?.trim() || null,
        publishedAt: article.publishedTime?.trim() || null,
        blocks,
        parserName: "readability",
      };
    }
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  console.warn("[tunta] Readability 未识别出正文，退回整页扫描:", url);
  return {
    title: doc.title?.trim() || null,
    author: null,
    publishedAt: null,
    blocks: fallbackBlocks(doc),
    parserName: "dom-fallback",
  };
}
