import type { ContentFormat, SocialChannel } from "../../../lib/channels";
import { ProviderError } from "../errors";
import type { CapabilityResult } from "../meta/instagram";

export type { CapabilityResult };

export interface PublishMedia {
  kind: "image" | "video";
  mimeType: string;
  /** Short-lived signed URL the platform can fetch (pull-based platforms). */
  url: string;
  sizeBytes: number;
  altText?: string;
  /** Raw bytes for upload-based platforms (X). */
  load: () => Promise<Buffer>;
}

export interface PublishInput {
  format: ContentFormat;
  text: string;
  media: PublishMedia[];
  /** TikTok only: privacy level the creator chose for this account. */
  privacyLevel?: string;
}

/**
 * Publishing is a small state machine so slow platforms never block a worker:
 * `publish()` either finishes or returns a `processing` ref that `checkPublish()` advances later.
 * Refs are persisted in the job payload, so a crash resumes instead of re-posting.
 */
export type PublishStep =
  | { state: "published"; id: string; permalink?: string | null }
  | { state: "processing"; ref: Record<string, string | string[]>; checkAfterMs: number };

export interface ChannelProfile {
  id: string;
  name: string;
  username?: string | null;
}

export interface ChannelPublisher {
  readonly mode: "live" | "mock";
  readonly provider: SocialChannel;
  getProfile(): Promise<ChannelProfile>;
  publish(input: PublishInput): Promise<PublishStep>;
  checkPublish(ref: Record<string, string | string[]>, input: PublishInput): Promise<PublishStep>;
  /**
   * Look for a recently published post with this text (used to reconcile ambiguous outcomes).
   * `undefined` means the platform offers no reliable lookup: a human must resolve it.
   */
  findRecent(text: string): Promise<{ id: string; permalink?: string | null } | null | undefined>;
}

/** Comment and DM replies (Instagram and Facebook Pages). */
export interface MessagingAdapter {
  readonly mode: "live" | "mock";
  replyToComment(commentId: string, message: string): Promise<{ id: string }>;
  sendPrivateReply(commentId: string, text: string): Promise<{ messageId: string; recipientId?: string }>;
  sendMessage(recipientId: string, text: string): Promise<{ messageId: string }>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export interface HttpJsonRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  token?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  body?: BodyInit;
  mutation?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * JSON HTTP helper for non-Graph platforms (X, TikTok). Status mapping:
 * 401 → auth, 403 → permission, 429 → rate_limit (honours reset headers), 5xx/network on a
 * mutation → unknown_outcome, otherwise transient/invalid. `errorOf` extracts the platform's error.
 */
export async function httpJson<T>(
  provider: SocialChannel,
  req: HttpJsonRequest,
  errorOf: (status: number, body: unknown) => { kind?: ProviderError["kind"]; message: string } | null,
): Promise<T> {
  const f = req.fetchImpl ?? fetch;
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (req.token) headers.Authorization = `Bearer ${req.token}`;
  let body: BodyInit | undefined = req.body;
  if (req.json !== undefined) {
    headers["Content-Type"] = "application/json; charset=UTF-8";
    body = JSON.stringify(req.json);
  } else if (req.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(req.form).toString();
  }
  let res: Response;
  try {
    res = await f(req.url, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new ProviderError(
      req.mutation ? "unknown_outcome" : "transient",
      provider,
      `Network error: ${(e as Error).message}`,
    );
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const platformErr = errorOf(res.status, parsed);
  if (res.ok && !platformErr) return parsed as T;
  const msg = (platformErr?.message ?? `HTTP ${res.status}`).slice(0, 500);
  const meta = { status: res.status };
  if (platformErr?.kind) {
    const kind = req.mutation && platformErr.kind === "transient" ? "unknown_outcome" : platformErr.kind;
    throw new ProviderError(kind, provider, msg, meta);
  }
  if (res.status === 401) throw new ProviderError("auth", provider, msg, meta);
  if (res.status === 403) throw new ProviderError("permission", provider, msg, meta);
  if (res.status === 404) throw new ProviderError("not_found", provider, msg, meta);
  if (res.status === 429) {
    const reset = Number(res.headers.get("x-rate-limit-reset") ?? 0);
    const retryAfterMs = reset ? Math.max(60_000, reset * 1000 - Date.now()) : 15 * 60_000;
    throw new ProviderError("rate_limit", provider, msg, { ...meta, retryAfterMs });
  }
  if (res.status >= 500)
    throw new ProviderError(req.mutation ? "unknown_outcome" : "transient", provider, msg, meta);
  throw new ProviderError("invalid", provider, msg, meta);
}

/** Mock failure-injection markers shared by every mock channel (see MockInstagramAdapter). */
export function injectMockFailure(provider: SocialChannel, text: string | undefined) {
  if (!text) return;
  if (text.includes("[mock:fail]")) throw new ProviderError("transient", provider, "Mock transient failure");
  if (text.includes("[mock:ambiguous]"))
    throw new ProviderError("unknown_outcome", provider, "Mock ambiguous outcome");
  if (text.includes("[mock:denied]"))
    throw new ProviderError("permission", provider, "Mock permission denied");
}
