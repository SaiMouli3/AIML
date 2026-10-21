import { env } from "../../env";
import { ProviderError } from "../errors";

/**
 * LLM provider abstraction. The default implementation targets any OpenAI-compatible
 * `/chat/completions` endpoint (Experiential Labs gateway by default), using JSON-schema structured
 * output. Outputs are always re-validated with zod by the caller: model output is untrusted.
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  content: string;
  model: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  /** USD as reported by the gateway when available; otherwise estimated from list price. */
  costUsd: number;
  costEstimated: boolean;
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly mode: "live" | "mock";
  complete(req: LlmRequest): Promise<LlmResponse>;
}

// List prices (USD per 1M tokens) as published by the gateway's /models endpoint (Oct 2026). Used only
// when a response does not include `usage.cost`.
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5.5": [2, 10],
  "claude-haiku-5.5": [0.1, 0.5],
  "claude-opus-5.5": [4, 20],
  "gpt-5.4-mini": [0.75, 4.5],
};

export class OpenAICompatibleProvider implements LlmProvider {
  readonly mode = "live" as const;
  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          max_tokens: req.maxTokens,
          temperature: req.temperature ?? 0.4,
          response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: false, schema: req.jsonSchema } },
        }),
        signal: req.signal ?? AbortSignal.timeout(req.timeoutMs ?? env().LLM_TIMEOUT_MS),
      });
    } catch (e) {
      const aborted = (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError";
      throw new ProviderError("transient", "llm", aborted ? "LLM request timed out" : `LLM network error: ${(e as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      model?: string;
      error?: { message?: string };
    };
    if (!res.ok) {
      const kind = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate_limit" : res.status >= 500 ? "transient" : "invalid";
      throw new ProviderError(kind, "llm", `LLM HTTP ${res.status}: ${json.error?.message ?? ""}`.slice(0, 300), { status: res.status });
    }
    const choice = json.choices?.[0];
    if (choice?.message?.refusal) throw new ProviderError("policy", "llm", "Model refused the request");
    const content = choice?.message?.content ?? "";
    const tokensIn = json.usage?.prompt_tokens ?? 0;
    const tokensOut = json.usage?.completion_tokens ?? 0;
    const price = PRICES[req.model];
    const reported = typeof json.usage?.cost === "number";
    const costUsd = reported ? json.usage!.cost! : price ? (tokensIn * price[0] + tokensOut * price[1]) / 1e6 : 0;
    return { content, model: json.model ?? req.model, provider: this.name, tokensIn, tokensOut, costUsd, costEstimated: !reported, latencyMs: Date.now() - started };
  }
}

/** Deterministic development mock. The caller supplies the mock output; it is always labelled provider "mock". */
export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";
  readonly mode = "mock" as const;
  constructor(private readonly respond: (req: LlmRequest) => unknown) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const out = this.respond(req);
    return { content: JSON.stringify(out), model: "mock-deterministic", provider: "mock", tokensIn: 0, tokensOut: 0, costUsd: 0, costEstimated: false, latencyMs: 1 };
  }
}

export function liveLlmProvider(): LlmProvider | null {
  const e = env();
  if (!e.LLM_API_KEY) return null;
  return new OpenAICompatibleProvider(new URL(e.LLM_BASE_URL).hostname, e.LLM_BASE_URL, e.LLM_API_KEY);
}
