import assert from "node:assert/strict";
import test from "node:test";
import {
  buildParserOutput,
  deriveSourceId,
  extractBilibiliSnapshot,
  extractXiaohongshuSnapshot,
  isXiaohongshuUrl,
} from "./parser.js";

function setGlobal(name: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (previous) {
      Object.defineProperty(globalThis, name, previous);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  };
}

function fakeElement(text = "", attributes: Record<string, string> = {}): Element {
  return {
    innerText: text,
    textContent: text,
    getAttribute: (name: string) => attributes[name] ?? null,
  } as unknown as Element;
}

function fakeDocument(entries: Record<string, Element[]>, title = ""): Document {
  return {
    title,
    querySelectorAll: (selector: string) => entries[selector] ?? [],
    querySelector: (selector: string) => entries[selector]?.[0] ?? null,
  } as unknown as Document;
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Uint8Array.from(bytes);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function lengthDelimitedField(fieldNumber: number, payload: Uint8Array): Uint8Array {
  return concatBytes(encodeVarint((fieldNumber << 3) | 2), encodeVarint(payload.length), payload);
}

function stringField(fieldNumber: number, value: string): Uint8Array {
  return lengthDelimitedField(fieldNumber, new TextEncoder().encode(value));
}

function subtitleViewFixture(entries: { lan: string; lanDoc: string; subtitleUrl: string }[]): Uint8Array {
  const items = entries.map((entry) =>
    lengthDelimitedField(
      3,
      concatBytes(
        stringField(3, entry.lan),
        stringField(4, entry.lanDoc),
        stringField(5, entry.subtitleUrl),
      ),
    ),
  );
  return lengthDelimitedField(1, concatBytes(...items));
}

function obfuscatedBilibiliSubtitleUrl(path: string, query: string): string {
  const prefix = 'nP](wOFRvU.+<fjS{jn-!$D|Dz&",zT`';
  const key = "=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`bilibili";
  const plain = `${prefix}${path}`;
  let encoded = "";
  for (let index = 0; index < plain.length; index += 1) {
    encoded += String.fromCharCode(plain.charCodeAt(index) ^ key.charCodeAt(index % key.length));
  }
  return `//subtitle.bilibili.com/${encodeURIComponent(encoded)}?${query}`;
}

test("uses Bilibili's protobuf subtitle API when hydration globals are missing", async () => {
  const pageUrl = "https://www.bilibili.com/video/BV1TEST12345?p=2";
  const subtitleViewUrl =
    "https://api.bilibili.com/x/v2/subtitle/web/view?oid=202&pid=1001&context_ext=%7B%22video_type%22%3A1%7D&type=1&cur_production_type=0&preferred_language=ai-zh&playlist_switch=0";
  const subtitleFileUrl = "https://aisubtitle.hdslb.com/bfs/ai_subtitle/test.json?auth_key=test";
  const requests: string[] = [];
  let subtitleFileCredentials: RequestCredentials | undefined;
  const restore = [
    setGlobal("window", {}),
    setGlobal("document", { title: "页面标题_哔哩哔哩_bilibili" }),
    setGlobal("location", new URL(pageUrl)),
    setGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);

      if (url === "https://api.bilibili.com/x/web-interface/view?bvid=BV1TEST12345") {
        return Response.json({
          code: 0,
          data: {
            aid: 1001,
            title: "API 返回的视频标题",
            desc: "API 返回的视频简介",
            cid: 101,
            owner: { name: "测试 UP 主" },
            pages: [
              { cid: 101, page: 1 },
              { cid: 202, page: 2 },
            ],
          },
        });
      }

      if (url === subtitleViewUrl) {
        return new Response(
          subtitleViewFixture([
            {
              lan: "ai-zh",
              lanDoc: "中文",
              subtitleUrl: obfuscatedBilibiliSubtitleUrl("/bfs/ai_subtitle/test.json", "auth_key=test"),
            },
          ]),
        );
      }

      if (url === subtitleFileUrl) {
        subtitleFileCredentials = init?.credentials;
        return Response.json({
          body: [{ from: 1.25, to: 2.5, content: "缺失 hydration global 时仍能提取字幕。" }],
        });
      }

      return new Response(null, { status: 404 });
    }),
  ];

  try {
    const result = await extractBilibiliSnapshot();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.title, "API 返回的视频标题");
    assert.equal(result.author, "测试 UP 主");
    assert.deepEqual(result.cues, [
      {
        startMs: 1250,
        endMs: 2500,
        text: "缺失 hydration global 时仍能提取字幕。",
      },
    ]);
    assert.deepEqual(requests, [
      "https://api.bilibili.com/x/web-interface/view?bvid=BV1TEST12345",
      subtitleViewUrl,
      subtitleFileUrl,
    ]);
    assert.equal(subtitleFileCredentials, "omit");
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("surfaces when Bilibili subtitles require a logged-in page session", async () => {
  const pageUrl = "https://www.bilibili.com/video/BV1LOGIN1234";
  const subtitleViewUrl =
    "https://api.bilibili.com/x/v2/subtitle/web/view?oid=303&pid=2002&context_ext=%7B%22video_type%22%3A1%7D&type=1&cur_production_type=0&preferred_language=ai-zh&playlist_switch=0";
  const requests: string[] = [];
  const restore = [
    setGlobal("window", {
      __INITIAL_STATE__: {
        videoData: {
          aid: 2002,
          title: "登录字幕测试",
          desc: "公开视频简介",
          cid: 303,
          owner: { name: "测试 UP 主" },
        },
      },
    }),
    setGlobal("document", { title: "登录字幕测试_哔哩哔哩_bilibili" }),
    setGlobal("location", new URL(pageUrl)),
    setGlobal("fetch", async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      if (url === subtitleViewUrl) {
        return new Response(new Uint8Array());
      }
      if (url === "https://api.bilibili.com/x/player/wbi/v2?bvid=BV1LOGIN1234&cid=303") {
        return Response.json({
          code: 0,
          data: {
            need_login_subtitle: true,
            subtitle: { subtitles: [] },
          },
        });
      }
      return new Response(null, { status: 404 });
    }),
  ];

  try {
    const result = await extractBilibiliSnapshot();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.degraded, "subtitle-login-required");
    assert.match(result.degradedDetail ?? "", /logged-in Bilibili session/i);
    assert.deepEqual(requests, [
      subtitleViewUrl,
      "https://api.bilibili.com/x/player/wbi/v2?bvid=BV1LOGIN1234&cid=303",
    ]);
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("preserves Bilibili subtitle discovery API failures", async () => {
  const pageUrl = "https://www.bilibili.com/video/BV1ERROR1234";
  const restore = [
    setGlobal("window", {
      __INITIAL_STATE__: {
        videoData: {
          title: "字幕错误测试",
          cid: 404,
        },
      },
    }),
    setGlobal("document", { title: "字幕错误测试_哔哩哔哩_bilibili" }),
    setGlobal("location", new URL(pageUrl)),
    setGlobal("fetch", async () =>
      Response.json({
        code: -403,
        message: "访问权限不足",
      }),
    ),
  ];

  try {
    const result = await extractBilibiliSnapshot();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.degraded, "subtitle-fetch-failed");
    assert.match(result.degradedDetail ?? "", /player WBI API code -403: 访问权限不足/);
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("extracts a public Xiaohongshu note from conservative DOM selectors", () => {
  const pageUrl = "https://www.xiaohongshu.com/explore/64abcdef1234567890?xsec_token=secret#comments";
  const restore = [
    setGlobal("location", new URL(pageUrl)),
    setGlobal(
      "document",
      fakeDocument({
        "#detail-title": [fakeElement(" 一份真正能复用的收藏方法 ")],
        "#detail-desc .note-text": [fakeElement("收藏之后，要能检索、引用，也要回到原文。")],
        ".info .username": [fakeElement("测试作者")],
        ".slider-container img": [fakeElement(), fakeElement()],
      }),
    ),
  ];

  try {
    const result = extractXiaohongshuSnapshot();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.canonicalUrl, "https://www.xiaohongshu.com/explore/64abcdef1234567890");
    assert.equal(result.title, "一份真正能复用的收藏方法");
    assert.equal(result.author, "测试作者");
    assert.equal(result.contentType, "image_post");
    assert.equal(result.mediaCount, 2);
    assert.deepEqual(result.blocks, [
      {
        kind: "heading",
        text: "一份真正能复用的收藏方法",
        selector: "#detail-title",
      },
      {
        kind: "caption",
        text: "收藏之后，要能检索、引用，也要回到原文。",
        selector: "#detail-desc .note-text",
      },
    ]);
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("falls back to public Xiaohongshu JSON-LD metadata", () => {
  const pageUrl = "https://www.xiaohongshu.com/discovery/item/65abcdef1234567890";
  const jsonLd = JSON.stringify({
    "@type": "SocialMediaPosting",
    headline: "JSON-LD 标题",
    articleBody: "JSON-LD 正文",
    author: { name: "结构化作者" },
    datePublished: "2026-07-24T12:30:00+08:00",
    image: ["https://example.invalid/public-image.jpg"],
  });
  const restore = [
    setGlobal("location", new URL(pageUrl)),
    setGlobal(
      "document",
      fakeDocument({
        'script[type="application/ld+json"]': [fakeElement(jsonLd)],
      }),
    ),
  ];

  try {
    const result = extractXiaohongshuSnapshot();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.title, "JSON-LD 标题");
    assert.equal(result.author, "结构化作者");
    assert.equal(result.publishedAt, "2026-07-24T04:30:00.000Z");
    assert.equal(result.contentType, "image_post");
    assert.equal(result.blocks[0]?.selector, 'script[type="application/ld+json"]');
    assert.equal(result.blocks.at(-1)?.text, "JSON-LD 正文");
    assert.equal(result.blocks.at(-1)?.selector, 'script[type="application/ld+json"]');
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("fails explicitly when Xiaohongshu note body is not publicly visible", () => {
  const restore = [
    setGlobal("location", new URL("https://www.xiaohongshu.com/explore/64abcdef1234567890")),
    setGlobal("document", fakeDocument({}, "登录后查看 - 小红书")),
  ];

  try {
    assert.deepEqual(extractXiaohongshuSnapshot(), {
      ok: false,
      code: "XHS_NOTE_EMPTY",
      message: "小红书笔记正文不可见或尚未加载；未读取登录态接口，也不会用页面杂项文本兜底。",
    });
  } finally {
    for (const restoreGlobal of restore.reverse()) restoreGlobal();
  }
});

test("uses a stable Xiaohongshu note id and marks incomplete media capture as partial", async () => {
  assert.equal(isXiaohongshuUrl("https://xhs.cn/example"), true);
  assert.equal(isXiaohongshuUrl("https://example.com/post"), false);
  assert.equal(
    deriveSourceId("https://www.xiaohongshu.com/explore/64abcdef1234567890?xsec_token=secret", "xiaohongshu"),
    "xiaohongshu:64abcdef1234567890",
  );

  const output = await buildParserOutput({
    originalUrl: "https://xhs.cn/example",
    finalUrl: "https://www.xiaohongshu.com/explore/64abcdef1234567890",
    title: "公开笔记",
    platform: "xiaohongshu",
    contentType: "image_post",
    blocks: [
      {
        kind: "caption",
        text: "公开可见的正文",
        locator: { kind: "dom", selector: "#detail-desc .note-text" },
      },
    ],
    jobId: "job:test:xhs",
    author: "公开作者",
    publishedAt: "2026-07-24T04:30:00.000Z",
    warnings: [
      {
        code: "XHS_MEDIA_NOT_CAPTURED",
        message: "图片尚未抓取。",
        stage: "extract",
        recoverable: false,
      },
    ],
  });

  assert.equal(output.source.source_id, "xiaohongshu:64abcdef1234567890");
  assert.equal(output.source.content_type, "image_post");
  assert.equal(output.source.author, "公开作者");
  assert.equal(output.source.published_at, "2026-07-24T04:30:00.000Z");
  assert.equal(output.parse.status, "partial");
  assert.equal(output.parse.warnings[0]?.code, "XHS_MEDIA_NOT_CAPTURED");
});

test("carries OCR assets and asset_ids through the Parser Output boundary", async () => {
  const output = await buildParserOutput({
    originalUrl: "https://www.xiaohongshu.com/explore/64abcdef1234567890",
    finalUrl: "https://www.xiaohongshu.com/explore/64abcdef1234567890",
    title: "带图笔记",
    platform: "xiaohongshu",
    contentType: "image_post",
    blocks: [
      {
        kind: "caption",
        text: "公开可见的正文",
        locator: { kind: "dom", selector: "#detail-desc .note-text" },
      },
      {
        kind: "ocr",
        text: "收纳流程图\n第一步：全部倒出来",
        locator: { kind: "unknown" },
        asset_ids: ["asset:image:001"],
      },
    ],
    assets: [
      {
        asset_id: "asset:image:001",
        kind: "image",
        url: "https://sns-img.example.com/cover.webp",
        blob_ref: null,
        ocr_text: "第一步：全部倒出来",
        caption: "收纳流程图",
        metadata: {},
      },
    ],
    jobId: "job:test:ocr",
  });

  assert.equal(output.assets.length, 1);
  assert.equal(output.assets[0]?.ocr_text, "第一步：全部倒出来");
  assert.equal(output.assets[0]?.caption, "收纳流程图");
  const ocrBlock = output.blocks.find((block) => block.kind === "ocr");
  assert.deepEqual(ocrBlock?.asset_ids, ["asset:image:001"]);
  // 非 OCR block 不带 asset 引用
  assert.deepEqual(output.blocks[0]?.asset_ids, []);
});

test("deduplicates repeated parser blocks at the Parser Output boundary", async () => {
  const output = await buildParserOutput({
    originalUrl: "https://example.com/repeated",
    finalUrl: "https://example.com/repeated",
    title: "重复正文",
    platform: "example.com",
    contentType: "article",
    blocks: [
      {
        kind: "paragraph",
        text: "同一段正文",
        locator: { kind: "paragraph", paragraph_index: 0 },
      },
      {
        kind: "paragraph",
        text: "  同一段正文  ",
        locator: { kind: "paragraph", paragraph_index: 1 },
      },
      {
        kind: "paragraph",
        text: "同一段正文",
        locator: { kind: "paragraph", paragraph_index: 2 },
      },
      {
        kind: "paragraph",
        text: "另一段正文",
        locator: { kind: "paragraph", paragraph_index: 3 },
      },
    ],
    jobId: "job:test:dedupe",
  });

  assert.deepEqual(
    output.blocks.map((block) => block.text),
    ["同一段正文", "另一段正文"],
  );
  assert.deepEqual(
    output.blocks.map((block) => block.order),
    [0, 1],
  );
  assert.equal(output.parse.status, "partial");
  assert.deepEqual(output.parse.warnings.at(-1), {
    code: "DUPLICATE_BLOCKS_REMOVED",
    message: "Parser normalize 移除了 2 个重复 block。",
    stage: "normalize",
    recoverable: false,
    details: { removed_count: 2 },
  });
});

test("preserves repeated transcript text at different timestamps", async () => {
  const output = await buildParserOutput({
    originalUrl: "https://www.bilibili.com/video/BV1REPEAT",
    finalUrl: "https://www.bilibili.com/video/BV1REPEAT",
    title: "重复台词",
    platform: "bilibili",
    contentType: "video",
    blocks: [
      {
        kind: "transcript",
        text: "谢谢大家",
        locator: { kind: "timestamp", start_ms: 1_000, end_ms: 2_000 },
      },
      {
        kind: "transcript",
        text: "谢谢大家",
        locator: { kind: "timestamp", start_ms: 5_000, end_ms: 6_000 },
      },
      {
        kind: "transcript",
        text: "谢谢大家",
        locator: { kind: "timestamp", start_ms: 5_000, end_ms: 6_000 },
      },
    ],
    jobId: "job:test:transcript-dedupe",
  });

  assert.equal(output.blocks.length, 2);
  assert.deepEqual(
    output.blocks.map((block) => block.locator.start_ms),
    [1_000, 5_000],
  );
  assert.equal(output.parse.warnings.at(-1)?.code, "DUPLICATE_BLOCKS_REMOVED");
});
