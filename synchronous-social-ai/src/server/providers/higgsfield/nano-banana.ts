import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderError } from "../errors";
import type { MediaProvider, ModelInfo, StatusResult, SubmitResult } from "./higgsfield";

/**
 * Fallback image provider used when Higgsfield is not configured: Google's Nano Banana
 * (gemini-2.5-flash-image) through the Experiential Labs gateway, which returns the PNG inline.
 * Generation is synchronous, so submit() does the work and status()/download() serve the result.
 */

// ponytail: outputs are held in process memory. A worker restart between submit and download fails that job;
// move outputs to tenant storage if that happens often.
const GATEWAY_MODEL = "gemini-2.5-flash-image";
const EST_USD_PER_IMAGE = 0.04;
const TIMEOUT_MS = 120_000;
const URL_PREFIX = "nano-banana://";

export const NANO_BANANA_MODEL: ModelInfo = {
  id: "nano-banana",
  label: "Nano Banana (Gemini 2.5 Flash Image)",
  kind: "image",
  path: "",
  docs: "https://ai.google.dev/gemini-api/docs/image-generation",
  params: z
    .object({ aspect_ratio: z.enum(["1:1", "4:5", "9:16", "16:9", "3:4"]).optional() })
    .strict(),
  defaultParams: { aspect_ratio: "4:5" },
};

function mapStatusError(status: number, detail: string): ProviderError {
  const msg = `Gateway HTTP ${status}: ${detail}`.slice(0, 400);
  if (status === 401) return new ProviderError("auth", "nano-banana", msg, { status });
  if (status === 403) return new ProviderError("permission", "nano-banana", msg, { status });
  if (status === 429) return new ProviderError("rate_limit", "nano-banana", msg, { status });
  if (status >= 500) return new ProviderError("transient", "nano-banana", msg, { status });
  return new ProviderError("invalid", "nano-banana", msg, { status });
}

export class NanoBananaProvider implements MediaProvider {
  readonly name = "nano-banana";
  readonly mode = "live" as const;
  private outputs = new Map<string, Buffer>();

  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  models(): ModelInfo[] {
    return [NANO_BANANA_MODEL];
  }

  async estimate() {
    return { credits: null, usd: EST_USD_PER_IMAGE };
  }

  async submit(_model: ModelInfo, prompt: string, params: Record<string, unknown>): Promise<SubmitResult> {
    const aspect = typeof params.aspect_ratio === "string" ? ` Aspect ratio ${params.aspect_ratio}.` : "";
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: GATEWAY_MODEL,
          messages: [{ role: "user", content: `${prompt}${aspect}` }],
          modalities: ["image", "text"],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ProviderError("unknown_outcome", "nano-banana", `Gateway request failed: ${String(err)}`.slice(0, 400));
    }
    if (!res.ok) throw mapStatusError(res.status, (await res.text()).slice(0, 300));

    const body = (await res.json()) as {
      choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
    };
    const dataUrl = body.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? "";
    const match = /^data:(image\/[a-z+]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) throw new ProviderError("policy", "nano-banana", "Gateway returned no image (prompt may be blocked)");

    const id = randomUUID();
    this.outputs.set(id, Buffer.from(match[2] ?? "", "base64"));
    return { requestId: id, status: "completed" };
  }

  async status(requestId: string): Promise<StatusResult> {
    if (!this.outputs.has(requestId))
      return { status: "failed", error: "Output no longer available (worker restarted)", outputs: [] };
    return { status: "completed", outputs: [{ url: `${URL_PREFIX}${requestId}`, kind: "image" }] };
  }

  async cancel() {
    return { canceled: false, reason: "Nano Banana generations finish immediately" };
  }

  async download(url: string) {
    const data = this.outputs.get(url.slice(URL_PREFIX.length));
    if (!data) throw new ProviderError("not_found", "nano-banana", "Output no longer available");
    return { data, contentType: "image/png" };
  }
}
