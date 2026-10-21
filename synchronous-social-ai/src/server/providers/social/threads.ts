import { randomUUID } from "node:crypto";
import { env } from "../../env";
import { ProviderError } from "../errors";
import { graphCall } from "../meta/graph";
import {
  injectMockFailure,
  type CapabilityResult,
  type ChannelPublisher,
  type OAuthTokens,
  type PublishInput,
  type PublishStep,
} from "./types";

/**
 * Threads API (graph.threads.com/v1.0), Meta docs Oct 2026:
 *  - Container: POST /{user}/threads media_type=TEXT|IMAGE|VIDEO|CAROUSEL (+ text, image_url, video_url,
 *    is_carousel_item, children). Carousel: 2–20 items. Text limit 500.
 *  - Status: GET /{container}?fields=status,error_message → IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED
 *    (Meta recommends ~30s before publishing and polling once a minute for ≤5 minutes).
 *  - Publish: POST /{user}/threads_publish creation_id=… → { id }; 250 posts per 24 hours.
 *  - OAuth: threads.com/oauth/authorize → POST graph.threads.com/oauth/access_token →
 *    GET /access_token?grant_type=th_exchange_token (60 days) → GET /refresh_access_token?grant_type=th_refresh_token.
 */

export const THREADS_SCOPES = ["threads_basic", "threads_content_publish"] as const;
const host = () => env().THREADS_GRAPH_HOST;
const base = () => `${host()}/v1.0`;

export function threadsCapabilities(scopes: string[]): CapabilityResult[] {
  const ok = scopes.includes("threads_content_publish") && scopes.includes("threads_basic");
  return [
    ok
      ? { capability: "publish", status: "available" }
      : { capability: "publish", status: "unavailable", reason: "Missing threads_content_publish" },
  ];
}

export class LiveThreadsAdapter implements ChannelPublisher {
  readonly mode = "live" as const;
  readonly provider = "threads" as const;
  constructor(
    private readonly userId: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private call<T>(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    mutation = false,
  ) {
    return graphCall<T>(
      { method, url: `${base()}${path}`, token: this.token, params, mutation, fetchImpl: this.fetchImpl },
      "threads",
    );
  }
  async getProfile() {
    const r = await this.call<{ id: string; username: string; name?: string }>("GET", "/me", {
      fields: "id,username,name",
    });
    return { id: r.id, name: r.name ?? r.username, username: r.username };
  }
  private container(params: Record<string, string | boolean | undefined>) {
    return this.call<{ id: string }>("POST", `/${this.userId}/threads`, params, true);
  }
  async publish(i: PublishInput): Promise<PublishStep> {
    let id: string;
    if (i.format === "carousel") {
      const children: string[] = [];
      for (const m of i.media) {
        const c = await this.container({
          is_carousel_item: true,
          media_type: m.kind === "video" ? "VIDEO" : "IMAGE",
          ...(m.kind === "video" ? { video_url: m.url } : { image_url: m.url, alt_text: m.altText }),
        });
        children.push(c.id);
      }
      id = (await this.container({ media_type: "CAROUSEL", children: children.join(","), text: i.text })).id;
    } else if (i.media.length === 1) {
      const m = i.media[0]!;
      id = (
        await this.container(
          m.kind === "video"
            ? { media_type: "VIDEO", video_url: m.url, text: i.text }
            : { media_type: "IMAGE", image_url: m.url, text: i.text, alt_text: m.altText },
        )
      ).id;
    } else {
      id = (await this.container({ media_type: "TEXT", text: i.text })).id;
    }
    return { state: "processing", ref: { containerId: id }, checkAfterMs: 30_000 };
  }
  async checkPublish(ref: Record<string, string | string[]>): Promise<PublishStep> {
    const containerId = String(ref.containerId);
    const st = await this.call<{ status?: string; error_message?: string }>("GET", `/${containerId}`, {
      fields: "status,error_message",
    });
    if (st.status === "IN_PROGRESS") return { state: "processing", ref, checkAfterMs: 60_000 };
    if (st.status === "ERROR" || st.status === "EXPIRED")
      throw new ProviderError(
        "invalid",
        "threads",
        `Container ${st.status}: ${st.error_message ?? "unknown"}`,
      );
    if (st.status === "PUBLISHED")
      // Published by an earlier attempt whose response was lost: report it rather than re-publishing.
      throw new ProviderError("unknown_outcome", "threads", "Container already published; reconcile");
    const pub = await this.call<{ id: string }>(
      "POST",
      `/${this.userId}/threads_publish`,
      { creation_id: containerId },
      true,
    );
    const m = await this.call<{ permalink?: string }>("GET", `/${pub.id}`, { fields: "permalink" }).catch(
      () => ({
        permalink: undefined,
      }),
    );
    return { state: "published", id: pub.id, permalink: m.permalink ?? null };
  }
  async findRecent(text: string) {
    const r = await this.call<{ data: Array<{ id: string; text?: string; permalink?: string }> }>(
      "GET",
      `/${this.userId}/threads`,
      { fields: "id,text,permalink", limit: 25 },
    );
    const hit = (r.data ?? []).find((t) => (t.text ?? "").trim() === text.trim());
    return hit ? { id: hit.id, permalink: hit.permalink ?? null } : null;
  }
}

export class MockThreadsAdapter implements ChannelPublisher {
  readonly mode = "mock" as const;
  readonly provider = "threads" as const;
  constructor(private readonly userId: string) {}
  async getProfile() {
    return { id: this.userId, name: "Mock Threads (development)", username: "mock_brand" };
  }
  async publish(i: PublishInput): Promise<PublishStep> {
    injectMockFailure("threads", i.text);
    return { state: "processing", ref: { containerId: `mock_th_c_${randomUUID()}` }, checkAfterMs: 1000 };
  }
  async checkPublish(): Promise<PublishStep> {
    const id = `mock_th_${randomUUID()}`;
    return { state: "published", id, permalink: `https://mock.invalid/threads/${id}` };
  }
  async findRecent() {
    return null;
  }
}

// ───────────────────────────── OAuth ─────────────────────────────

export function threadsAuthorizeUrl(state: string, redirectUri: string) {
  const u = new URL(env().THREADS_AUTHORIZE_URL);
  u.searchParams.set("client_id", env().THREADS_APP_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", THREADS_SCOPES.join(","));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  return u.toString();
}

async function readJson(res: Response) {
  return (await res.json().catch(() => ({}))) as {
    access_token?: string;
    user_id?: string | number;
    expires_in?: number;
    error?: { message?: string; code?: number };
    error_message?: string;
  };
}

export async function exchangeThreadsCode(
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
) {
  const e = env();
  const res = await fetchImpl(`${host()}/oauth/access_token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: e.THREADS_APP_ID ?? "",
      client_secret: e.THREADS_APP_SECRET ?? "",
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await readJson(res);
  if (!res.ok || !json.access_token)
    throw new ProviderError(
      "auth",
      "threads",
      `Code exchange failed: ${json.error?.message ?? json.error_message ?? res.status}`,
    );
  const ll = new URL(`${host()}/access_token`);
  ll.searchParams.set("grant_type", "th_exchange_token");
  ll.searchParams.set("client_secret", e.THREADS_APP_SECRET ?? "");
  ll.searchParams.set("access_token", json.access_token);
  const llJson = await readJson(await fetchImpl(ll, { signal: AbortSignal.timeout(20_000) }));
  return {
    userId: String(json.user_id ?? ""),
    tokens: {
      accessToken: llJson.access_token ?? json.access_token,
      refreshToken: null,
      expiresAt: new Date(Date.now() + (llJson.expires_in ?? 3600) * 1000),
      // Threads does not echo granted scopes on the token response; the requested set is recorded and
      // verified on first use (permission errors downgrade the capability).
      scopes: [...THREADS_SCOPES],
    } satisfies OAuthTokens,
  };
}

export async function refreshThreadsToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const u = new URL(`${host()}/refresh_access_token`);
  u.searchParams.set("grant_type", "th_refresh_token");
  u.searchParams.set("access_token", token);
  const res = await fetchImpl(u, { signal: AbortSignal.timeout(20_000) });
  const json = await readJson(res);
  if (!res.ok || !json.access_token) {
    const { mapGraphError } = await import("../meta/graph");
    throw mapGraphError(res.status, json as never, "threads");
  }
  return {
    accessToken: json.access_token,
    refreshToken: null,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 0) * 1000),
    scopes: [...THREADS_SCOPES],
  };
}
