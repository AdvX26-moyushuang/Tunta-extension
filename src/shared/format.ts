import type { ChatLocator, SourceBlock } from "@/shared/api/contracts";

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type AnyLocator = SourceBlock["locator"] | ChatLocator;

function read(locator: AnyLocator, camel: string, snake: string): unknown {
  const record = locator as Record<string, unknown>;
  return record[camel] ?? record[snake];
}

/** 把 timestamp / paragraph / page / dom locator 渲染为可读文本。 */
export function locatorText(locator: AnyLocator | null | undefined): string {
  if (!locator) return "unknown";
  const startMs = read(locator, "startMs", "start_ms") as number | null | undefined;
  const endMs = read(locator, "endMs", "end_ms") as number | null | undefined;
  const pageNumber = read(locator, "pageNumber", "page_number") as number | null | undefined;
  const paragraphIndex = read(locator, "paragraphIndex", "paragraph_index") as
    | number
    | null
    | undefined;
  const selector = read(locator, "selector", "selector") as string | null | undefined;

  switch (locator.kind) {
    case "timestamp":
      return `${Math.round((startMs ?? 0) / 1000)}s–${Math.round((endMs ?? 0) / 1000)}s`;
    case "paragraph":
      return `段落 ${paragraphIndex ?? "?"}`;
    case "page":
      return `第 ${pageNumber ?? "?"} 页`;
    case "dom":
      return selector ?? "DOM";
    default:
      return locator.kind;
  }
}

/** 提取 URL 的 hostname 用于列表展示。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** 校验剪贴板 / 输入是否为可收藏的 http(s) URL。 */
export function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 规范化 URL（去 hash），收藏幂等与 URL 比对的统一口径。 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}
