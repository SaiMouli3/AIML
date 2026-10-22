import { createHash, randomUUID } from "node:crypto";
import { env } from "../../env";
import { ProviderError } from "../errors";
import {
  httpJson,
  injectMockFailure,
  type CapabilityResult,
  type ChannelPublisher,
  type OAuthTokens,
  type PublishInput,
  type PublishMedia,
  type PublishStep,
} from "./types";

/**
 * X API v2 (api.x.com), docs Oct 2026:
 *  - Post: POST /2/tweets { text, media: { media_ids } } → { data: { id, text } }
 *  - Media (chunked v2): POST /2/media/upload/initialize { media_type, total_bytes, media_category }
 *    → POST /2/media/upload/{id}/append (multipart: segment_index, media; ≤5 MB per chunk)
 *    → POST /2/media/upload/{id}/finalize → processing_info { state, check_after_secs }
 *    → GET /2/media/upload?command=STATUS&media_id={id} until state=succeeded.
 *  - OAuth 2.0 Authorization Code with PKCE: x.com/i/oauth2/authorize, POST api.x.com/2/oauth2/token
 *    (confidential clients authenticate with HTTP Basic). Access tokens last 2 hours; offline.access
 *    returns a refresh token.
 */

export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"] as const;
const API = () => env().X_API_BASE;
const CHUNK = 4 * 1024 * 1024;

export function xCapabilities(scopes: string[]): CapabilityResult[] {
  const has = (s: string) => scopes.includes(s);
  return [
    has("tweet.write")
      ? { capability: "publish", status: "available" }
      : { capability: "publish", status: "unavailable", reason: "Missing tweet.write" },
    has("media.write")
      ? { capability: "publish_media", status: "available" }
      : { capability: "publish_media", status: "unavailable", reason: "Missing media.write" },
  ];
}

type XErrorBody = {
  title?: string;
  detail?: string;
  errors?: Array<{ message?: string; title?: string; detail?: string }>;
  error?: string;
  error_description?: string;
};

function xError(status: number, body: unknown) {
  const b = (body ?? {}) as XErrorBody;
  const detail =
    b.detail ?? b.errors?.[0]?.detail ?? b.errors?.[0]?.message ?? b.error_description ?? b.title ?? null;
  if (status >= 200 && status < 300) {
    // 2xx with only an `errors` array and no data is a failure on X.
    const d = body as { data?: unknown; errors?: unknown[] } | null;
    if (d && !d.data && Array.isArray(d.errors) && d.errors.length)
      return { kind: "invalid" as const, message: `X: ${detail}` };
    return null;
  }
  if (status === 403 && /duplicate/i.test(detail ?? ""))
    return { kind: "invalid" as const, message: "X rejected a duplicate post" };
  return detail ? { message: `X ${status}: ${detail}` } : null;
}

export class LiveXAdapter implements ChannelPublisher {
  readonly mode = "live" as const;
  readonly provider = "x" as const;
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private req<T>(r: Omit<Parameters<typeof httpJson>[1], "token" | "fetchImpl">) {
    return httpJson<T>("x", { ...r, token: this.token, fetchImpl: this.fetchImpl }, xError);
  }
  async getProfile() {
    const r = await this.req<{ data: { id: string; name: string; username: string } }>({
      method: "GET",
      url: `${API()}/2/users/me`,
    });
    return { id: r.data.id, name: r.data.name, username: r.data.username };
  }
  private async upload(m: PublishMedia) {
    const bytes = await m.load();
    const category =
      m.kind === "video" ? "tweet_video" : m.mimeType === "image/gif" ? "tweet_gif" : "tweet_image";
    const init = await this.req<{ data: { id: string } }>({
      method: "POST",
      url: `${API()}/2/media/upload/initialize`,
      json: { media_type: m.mimeType, total_bytes: bytes.length, media_category: category },
    });
    const id = init.data.id;
    for (let i = 0, seg = 0; i < bytes.length; i += CHUNK, seg++) {
      const form = new FormData();
      form.set("segment_index", String(seg));
      form.set("media", new Blob([new Uint8Array(bytes.subarray(i, i + CHUNK))], { type: m.mimeType }));
      await this.req({ method: "POST", url: `${API()}/2/media/upload/${id}/append`, body: form });
    }
    const fin = await this.req<{
      data: { id: string; processing_info?: { state: string; check_after_secs?: number } };
    }>({ method: "POST", url: `${API()}/2/media/upload/${id}/finalize` });
    return { id, processing: fin.data.processing_info };
  }
  private async createPost(text: string, mediaIds: string[]): Promise<PublishStep> {
    const r = await this.req<{ data: { id: string } }>({
      method: "POST",
      url: `${API()}/2/tweets`,
      json: mediaIds.length ? { text, media: { media_ids: mediaIds } } : { text },
      mutation: true,
    });
    return { state: "published", id: r.data.id, permalink: `https://x.com/i/web/status/${r.data.id}` };
  }
  async publish(i: PublishInput): Promise<PublishStep> {
    // Uploading media has no public side effect; only POST /2/tweets is the consequential mutation.
    const uploads = [];
    for (const m of i.media) uploads.push(await this.upload(m));
    const pending = uploads.filter((u) => u.processing && u.processing.state !== "succeeded");
    if (pending.some((u) => u.processing!.state === "failed"))
      throw new ProviderError("invalid", "x", "X could not process the media");
    const mediaIds = uploads.map((u) => u.id);
    if (pending.length)
      return {
        state: "processing",
        ref: { mediaIds },
        checkAfterMs: Math.max(5, ...pending.map((u) => u.processing!.check_after_secs ?? 5)) * 1000,
      };
    return this.createPost(i.text, mediaIds);
  }
  async checkPublish(ref: Record<string, string | string[]>, i: PublishInput): Promise<PublishStep> {
    const mediaIds = ([] as string[]).concat(ref.mediaIds ?? []);
    let wait = 0;
    for (const id of mediaIds) {
      const u = new URL(`${API()}/2/media/upload`);
      u.searchParams.set("command", "STATUS");
      u.searchParams.set("media_id", id);
      const st = await this.req<{ data: { processing_info?: { state: string; check_after_secs?: number } } }>(
        {
          method: "GET",
          url: u.toString(),
        },
      );
      const p = st.data.processing_info;
      if (p?.state === "failed") throw new ProviderError("invalid", "x", "X could not process the media");
      if (p && p.state !== "succeeded") wait = Math.max(wait, p.check_after_secs ?? 5);
    }
    if (wait) return { state: "processing", ref, checkAfterMs: wait * 1000 };
    return this.createPost(i.text, mediaIds);
  }
  async findRecent(text: string) {
    const me = await this.getProfile();
    const u = new URL(`${API()}/2/users/${me.id}/tweets`);
    u.searchParams.set("max_results", "10");
    const r = await this.req<{ data?: Array<{ id: string; text: string }> }>({
      method: "GET",
      url: u.toString(),
    });
    // X shortens links in returned text, so compare on the text with URLs removed.
    const norm = (s: string) =>
      s
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const hit = (r.data ?? []).find((t) => norm(t.text) === norm(text));
    return hit ? { id: hit.id, permalink: `https://x.com/i/web/status/${hit.id}` } : null;
  }
}

export class MockXAdapter implements ChannelPublisher {
  readonly mode = "mock" as const;
  readonly provider = "x" as const;
  constructor(private readonly userId: string) {}
  async getProfile() {
    return { id: this.userId, name: "Mock X (development)", username: "mock_brand" };
  }
  async publish(i: PublishInput): Promise<PublishStep> {
    injectMockFailure("x", i.text);
    const id = `mock_x_${randomUUID()}`;
    return { state: "published", id, permalink: `https://mock.invalid/x/${id}` };
  }
  async checkPublish(): Promise<PublishStep> {
    const id = `mock_x_${randomUUID()}`;
    return { state: "published", id, permalink: `https://mock.invalid/x/${id}` };
  }
  async findRecent() {
    return null;
  }
}

// ───────────────────────────── OAuth 2.0 + PKCE ─────────────────────────────

export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function xAuthorizeUrl(state: string, redirectUri: string, codeVerifier: string) {
  const u = new URL("https://x.com/i/oauth2/authorize");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", env().X_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", X_SCOPES.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

async function tokenRequest(form: Record<string, string>, fetchImpl: typeof fetch): Promise<OAuthTokens> {
  const e = env();
  const basic = Buffer.from(`${e.X_CLIENT_ID ?? ""}:${e.X_CLIENT_SECRET ?? ""}`).toString("base64");
  const r = await httpJson<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }>(
    "x",
    {
      method: "POST",
      url: `${API()}/2/oauth2/token`,
      headers: { Authorization: `Basic ${basic}` },
      form,
      fetchImpl,
    },
    (status, body) => {
      const b = (body ?? {}) as XErrorBody;
      if (status >= 400)
        return {
          kind: "auth",
          message: `X token request failed: ${b.error_description ?? b.error ?? status}`,
        };
      return null;
    },
  );
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (r.expires_in ?? 7200) * 1000),
    scopes: (r.scope ?? "").split(" ").filter(Boolean),
  };
}

export function exchangeXCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
) {
  return tokenRequest(
    { code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: codeVerifier },
    fetchImpl,
  );
}

export function refreshXToken(refreshToken: string, fetchImpl: typeof fetch = fetch) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}
