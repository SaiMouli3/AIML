import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import { env } from "../../env";
import { ProviderError } from "../errors";
import { NanoBananaProvider } from "./nano-banana";

/**
 * Media generation provider abstraction with a Higgsfield implementation.
 * Verified against https://docs.higgsfield.ai (Oct 2026):
 *  - Auth header: `Authorization: Key <api_key_id>:<api_key_secret>`; base https://api.higgsfield.ai
 *  - Submit: POST /<model-path> (JSON body per model) with optional `Idempotency-Key` and `?hf_webhook=` →
 *    { status: "queued", request_id, status_url, cancel_url }
 *  - Status: GET /requests/{id}/status → queued | in_progress | completed | failed | nsfw | canceled,
 *    with images[].url / video.url on completion. Poll 2s → 10s with jitter.
 *  - Cancel: POST /requests/{id}/cancel → 202, or 400 once processing started.
 *  - Estimate: POST /estimate/<model-path> → { credits, usd }. Failed/NSFW requests are not charged.
 *  - Outputs retained ≥ 7 days: copy to tenant storage.
 */

export type GenStatus = "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled";
export const TERMINAL: GenStatus[] = ["completed", "failed", "nsfw", "canceled"];

export interface ModelInfo {
  id: string;
  label: string;
  kind: "image" | "video";
  path: string; // provider endpoint path
  docs: string;
  params: z.ZodType<Record<string, unknown>>;
  defaultParams: Record<string, unknown>;
}

const aspect = z.enum(["1:1", "4:5", "9:16", "16:9", "3:4"]);

/**
 * Curated catalog of models whose request schemas were read from the official docs. Availability is per
 * account: the console (https://console.higgsfield.ai) is authoritative, and unknown models are rejected.
 */
export const HIGGSFIELD_MODELS: ModelInfo[] = [
  {
    id: "higgsfield-soul-v2",
    label: "Higgsfield SOUL 2 (image)",
    kind: "image",
    path: "/higgsfield-ai/soul/v2/standard",
    docs: "https://docs.higgsfield.ai/docs/models/soul-2",
    params: z.object({ aspect_ratio: aspect.optional() }).strict(),
    defaultParams: { aspect_ratio: "4:5" },
  },
  {
    id: "kling-3-std-t2v",
    label: "Kling 3.0 Standard (text → video)",
    kind: "video",
    path: "/kling-video/v3.0/std/text-to-video",
    docs: "https://docs.higgsfield.ai/docs/models/kling-3/standard-text-to-video.md",
    params: z
      .object({
        duration: z.number().int().min(3).max(15).optional(),
        aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional(),
        sound: z.enum(["on", "off"]).optional(),
      })
      .strict(),
    defaultParams: { duration: 5, aspect_ratio: "9:16", sound: "off" },
  },
];

export interface SubmitResult {
  requestId: string;
  status: GenStatus;
}
export interface StatusResult {
  status: GenStatus;
  error?: string | null;
  outputs: Array<{ url: string; kind: "image" | "video" }>;
}

export interface MediaProvider {
  readonly name: string;
  readonly mode: "live" | "mock";
  models(): ModelInfo[];
  estimate(
    model: ModelInfo,
    prompt: string,
    params: Record<string, unknown>,
  ): Promise<{ credits: number | null; usd: number | null }>;
  submit(
    model: ModelInfo,
    prompt: string,
    params: Record<string, unknown>,
    idempotencyKey: string,
    webhookUrl?: string,
  ): Promise<SubmitResult>;
  status(requestId: string): Promise<StatusResult>;
  cancel(requestId: string): Promise<{ canceled: boolean; reason?: string }>;
  download(url: string): Promise<{ data: Buffer; contentType: string }>;
}

function mapHiggsfieldError(status: number, detail: string, mutation: boolean): ProviderError {
  const msg = `Higgsfield HTTP ${status}: ${detail}`.slice(0, 400);
  if (status === 401) return new ProviderError("auth", "higgsfield", msg, { status });
  if (status === 403)
    return new ProviderError("permission", "higgsfield", `${msg} (insufficient credits)`, { status });
  if (status === 404) return new ProviderError("not_found", "higgsfield", msg, { status });
  if (status === 422) return new ProviderError("invalid", "higgsfield", msg, { status });
  if (status === 400)
    return new ProviderError(/concurren/i.test(detail) ? "rate_limit" : "invalid", "higgsfield", msg, {
      status,
      retryAfterMs: 30_000,
    });
  if (status === 423 || status === 503 || status === 429)
    return new ProviderError("rate_limit", "higgsfield", msg, { status, retryAfterMs: 60_000 });
  if (status >= 500)
    return new ProviderError(mutation ? "unknown_outcome" : "transient", "higgsfield", msg, { status });
  return new ProviderError("invalid", "higgsfield", msg, { status });
}

export class HiggsfieldProvider implements MediaProvider {
  readonly name = "higgsfield";
  readonly mode = "live" as const;
  private base = "https://api.higgsfield.ai";
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  models() {
    return HIGGSFIELD_MODELS;
  }
  private headers(extra: Record<string, string> = {}) {
    return {
      Authorization: `Key ${this.keyId}:${this.keySecret}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }
  private async request(
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
    mutation = false,
  ) {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: this.headers(extra),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new ProviderError(
        mutation ? "unknown_outcome" : "transient",
        "higgsfield",
        `Network error: ${(e as Error).message}`,
      );
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const d = (json as { detail?: unknown } | null)?.detail;
      throw mapHiggsfieldError(
        res.status,
        typeof d === "string" ? d : JSON.stringify(d ?? text.slice(0, 200)),
        mutation,
      );
    }
    return { status: res.status, json };
  }
  async estimate(model: ModelInfo, prompt: string, params: Record<string, unknown>) {
    try {
      const { json } = await this.request("POST", `/estimate${model.path}`, { prompt, ...params });
      const j = json as { credits?: string; usd?: string };
      return { credits: j.credits ? Number(j.credits) : null, usd: j.usd ? Number(j.usd) : null };
    } catch {
      return { credits: null, usd: null };
    }
  }
  async submit(
    model: ModelInfo,
    prompt: string,
    params: Record<string, unknown>,
    idempotencyKey: string,
    webhookUrl?: string,
  ) {
    const path = webhookUrl ? `${model.path}?hf_webhook=${encodeURIComponent(webhookUrl)}` : model.path;
    // Idempotency-Key makes an ambiguous timeout safe to retry with identical parameters.
    const { json } = await this.request(
      "POST",
      path,
      { prompt, ...params },
      { "Idempotency-Key": idempotencyKey },
      true,
    );
    const j = json as { request_id?: string; status?: GenStatus };
    if (!j?.request_id)
      throw new ProviderError("unknown_outcome", "higgsfield", "Submission response missing request_id");
    return { requestId: j.request_id, status: j.status ?? "queued" };
  }
  async status(requestId: string): Promise<StatusResult> {
    const { json } = await this.request("GET", `/requests/${encodeURIComponent(requestId)}/status`);
    return parseStatusPayload(json);
  }
  async cancel(requestId: string) {
    try {
      await this.request("POST", `/requests/${encodeURIComponent(requestId)}/cancel`);
      return { canceled: true };
    } catch (e) {
      if (e instanceof ProviderError && e.meta.status === 400)
        return { canceled: false, reason: "Generation already started and can no longer be canceled" };
      throw e;
    }
  }
  async download(url: string) {
    const u = new URL(url);
    if (u.protocol !== "https:") throw new ProviderError("invalid", "higgsfield", "Output URL must be https");
    const res = await this.fetchImpl(u, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new ProviderError("transient", "higgsfield", `Output download failed (${res.status})`);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }
}

export const statusPayloadSchema = z.object({
  status: z.enum(["queued", "in_progress", "completed", "failed", "nsfw", "canceled"]),
  request_id: z.string().optional(),
  error: z.string().nullable().optional(),
  images: z.array(z.object({ url: z.url() })).optional(),
  video: z.object({ url: z.url() }).optional(),
  payload: z
    .object({
      images: z.array(z.object({ url: z.url() })).optional(),
      video: z.object({ url: z.url() }).optional(),
    })
    .nullable()
    .optional(),
});

/** Parses both the status endpoint shape and the webhook envelope (outputs nested under `payload`). */
export function parseStatusPayload(json: unknown): StatusResult {
  const p = statusPayloadSchema.parse(json);
  const images = p.images ?? p.payload?.images ?? [];
  const video = p.video ?? p.payload?.video;
  return {
    status: p.status,
    error: p.error ?? null,
    outputs: [
      ...images.map((i) => ({ url: i.url, kind: "image" as const })),
      ...(video ? [{ url: video.url, kind: "video" as const }] : []),
    ],
  };
}

// ───────────────────────────── Development mock ─────────────────────────────

/**
 * Mock media provider for local development and tests only. Produces a labelled placeholder PNG
 * ("MOCK" stripes). Video models return a storyboard frame image and say so — never a fake video.
 * Prompts containing "[mock:fail]" fail, "[mock:nsfw]" are moderated, "[mock:slow]" never completes.
 */
const mockState = new Map<
  string,
  { polls: number; prompt: string; kind: "image" | "video"; canceled?: boolean }
>();

export class MockMediaProvider implements MediaProvider {
  readonly name = "mock";
  readonly mode = "mock" as const;
  models() {
    return HIGGSFIELD_MODELS;
  }
  async estimate() {
    return { credits: 0, usd: 0 };
  }
  async submit(model: ModelInfo, prompt: string) {
    const id = `mock_req_${randomUUID()}`;
    mockState.set(id, { polls: 0, prompt, kind: model.kind });
    return { requestId: id, status: "queued" as const };
  }
  async status(requestId: string): Promise<StatusResult> {
    const st = mockState.get(requestId) ?? { polls: 2, prompt: "", kind: "image" as const };
    st.polls++;
    mockState.set(requestId, st);
    if (st.canceled) return { status: "canceled", outputs: [] };
    if (st.prompt.includes("[mock:slow]")) return { status: "in_progress", outputs: [] };
    if (st.polls < 2) return { status: "in_progress", outputs: [] };
    if (st.prompt.includes("[mock:fail]"))
      return { status: "failed", error: "Mock generation failed", outputs: [] };
    if (st.prompt.includes("[mock:nsfw]")) return { status: "nsfw", outputs: [] };
    return { status: "completed", outputs: [{ url: `mock://${requestId}.png`, kind: "image" }] };
  }
  async cancel(requestId: string) {
    const st = mockState.get(requestId);
    if (st && st.polls === 0) {
      st.canceled = true;
      return { canceled: true };
    }
    return { canceled: false, reason: "Mock generation already started" };
  }
  async download() {
    return { data: mockPng(1080, 1350), contentType: "image/png" };
  }
}

/** Minimal PNG encoder: diagonal stripes so mock output is visibly not a real asset. */
export function mockPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const stripe = Math.floor((x + y) / 60) % 2 === 0;
      const i = row + 1 + x * 3;
      raw[i] = stripe ? 99 : 129;
      raw[i + 1] = stripe ? 102 : 140;
      raw[i + 2] = stripe ? 241 : 248;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function mediaProvider(): MediaProvider | null {
  const e = env();
  if (e.HIGGSFIELD_API_KEY_ID && e.HIGGSFIELD_API_KEY_SECRET)
    return new HiggsfieldProvider(e.HIGGSFIELD_API_KEY_ID, e.HIGGSFIELD_API_KEY_SECRET);
  if (e.LLM_API_KEY) return new NanoBananaProvider(e.LLM_BASE_URL, e.LLM_API_KEY);
  if (e.mocksAllowed) return new MockMediaProvider();
  return null;
}
