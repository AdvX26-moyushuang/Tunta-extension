import type { ChatProviderConfig, EmbeddingProviderConfig } from "./settings";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export const PROVIDER_NOT_CONFIGURED = "PROVIDER_NOT_CONFIGURED";
export const PROVIDER_TIMEOUT = "PROVIDER_TIMEOUT";

/**
 * 单次 provider 调用的硬上限。没有它，被代理链路黑洞掉的请求会一直挂着——
 * fetch 不 reject、catch 进不去、failure 写不出来，收藏就永久停在 parsing。
 * 这两个值必须小于 pipeline 的 STUCK_THRESHOLD_MS，否则续跑会撞上还活着的调用。
 */
export const CHAT_TIMEOUT_MS = 90_000;
export const EMBEDDING_TIMEOUT_MS = 30_000;

/** AbortSignal.timeout 抛 TimeoutError；手动 abort 抛 AbortError。两者都算超时。 */
function isTimeoutError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

function toNetworkError(cause: unknown, label: string, baseUrl: string, timeoutMs: number): ProviderError {
  if (isTimeoutError(cause)) {
    return new ProviderError(
      `${label} 在 ${Math.round(timeoutMs / 1000)}s 内没有响应（${baseUrl}）：请检查网络，或确认代理链路放行了该地址。`,
      PROVIDER_TIMEOUT,
    );
  }
  return new ProviderError(
    `无法连接 ${label}（${baseUrl}）：${cause instanceof Error ? cause.message : String(cause)}`,
    "PROVIDER_NETWORK",
  );
}

interface AnthropicMessageResponse {
  content?: { type?: string; text?: string }[];
  stop_reason?: string | null;
  error?: { message?: string };
}


export async function callChatCompletion(
  config: ChatProviderConfig,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl || !config.apiKey.trim()) {
    throw new ProviderError("尚未配置 provider：请在工作台「设置」页填写 API key。", PROVIDER_NOT_CONFIGURED);
  }
  let response: Response;
  let payload: AnthropicMessageResponse | null;
  try {
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey.trim(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),

      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    payload = (await response.json().catch(() => null)) as AnthropicMessageResponse | null;
  } catch (cause) {
    throw toNetworkError(cause, "provider", baseUrl, CHAT_TIMEOUT_MS);
  }
  if (!response.ok) {
    throw new ProviderError(
      `provider 返回 HTTP ${response.status}：${payload?.error?.message ?? response.statusText}`,
      `PROVIDER_HTTP_${response.status}`,
    );
  }
  const text = (payload?.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
  if (!text) {
    if (payload?.stop_reason === "max_tokens") {
      throw new ProviderError(
        "provider 输出达到 max_tokens 上限却没有正文：reasoning 模型可能把预算全部耗在思考上。请换非思考型模型，或反馈给我们进一步调大预算。",
        "PROVIDER_TRUNCATED",
      );
    }
    throw new ProviderError(
      `provider 返回了空内容（stop_reason: ${payload?.stop_reason ?? "未知"}）。`,
      "PROVIDER_EMPTY_RESPONSE",
    );
  }
  return text;
}

interface OpenAIEmbeddingResponse {
  data?: { embedding?: number[] }[];
  error?: { message?: string };
}


export async function callEmbedding(config: EmbeddingProviderConfig, inputs: string[]): Promise<number[][]> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl || !config.apiKey.trim()) {
    throw new ProviderError("尚未配置 embedding provider。", PROVIDER_NOT_CONFIGURED);
  }
  if (inputs.length === 0) return [];
  let response: Response;
  let payload: OpenAIEmbeddingResponse | null;
  try {
    response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify({ model: config.model, input: inputs }),
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    });
    payload = (await response.json().catch(() => null)) as OpenAIEmbeddingResponse | null;
  } catch (cause) {
    throw toNetworkError(cause, "embedding provider", baseUrl, EMBEDDING_TIMEOUT_MS);
  }
  if (!response.ok) {
    throw new ProviderError(
      `embedding provider 返回 HTTP ${response.status}：${payload?.error?.message ?? response.statusText}`,
      `PROVIDER_HTTP_${response.status}`,
    );
  }
  const vectors = (payload?.data ?? []).map((item) => item?.embedding ?? []);
  if (vectors.length !== inputs.length || vectors.some((vector) => vector.length === 0)) {
    throw new ProviderError("embedding provider 返回的向量数量与输入不一致。", "PROVIDER_BAD_EMBEDDING");
  }
  return vectors;
}


export async function testChatConnection(config: ChatProviderConfig): Promise<number> {
  const started = Date.now();
  await callChatCompletion(config, "你是连通性测试探针。", "回复 OK 即可。", 1024);
  return Date.now() - started;
}

export async function testEmbeddingConnection(config: EmbeddingProviderConfig): Promise<number> {
  const started = Date.now();
  const [vector] = await callEmbedding(config, ["connectivity probe"]);
  if (!vector || vector.length === 0) {
    throw new ProviderError("embedding 返回空向量。", "PROVIDER_BAD_EMBEDDING");
  }
  return Date.now() - started;
}
