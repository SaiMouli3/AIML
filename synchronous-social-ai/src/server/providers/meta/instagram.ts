import { randomUUID } from "node:crypto";
import { env } from "../../env";
import { ProviderError } from "../errors";
import { graphCall } from "./graph";

/**
 * Instagram API with Instagram Login (graph.instagram.com). Verified against Meta docs (Oct 2026):
 *  - Content publishing: POST /<IG_ID>/media → container; GET /<container>?fields=status_code;
 *    POST /<IG_ID>/media_publish creation_id=<container>; GET /<IG_ID>/content_publishing_limit.
 *    Images must be JPEG on a public URL. Carousel children use is_carousel_item=true.
 *  - Comment replies: POST /<comment_id>/replies message=...
 *  - Private replies: POST /<IG_ID>/messages {recipient:{comment_id}, message:{text}} — one per comment,
 *    within 7 days of the comment; follow-ups only after the person replies, within 24h.
 *  - Messaging replies: POST /<IG_ID>/messages {recipient:{id: IGSID}, message:{text}} inside the 24h window.
 * See docs/integrations.md for scopes and app-review requirements.
 */

export const IG_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
] as const;

export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

export interface IgAccountInfo {
  id: string;
  username: string;
  name?: string;
  accountType?: string;
}

export interface CapabilityResult {
  capability: string;
  status: "available" | "unavailable" | "unknown";
  reason?: string;
}

export interface CreateContainerInput {
  kind:
    | "image"
    | "reel"
    | "story_image"
    | "story_video"
    | "carousel_item_image"
    | "carousel_item_video"
    | "carousel";
  mediaUrl?: string;
  caption?: string;
  altText?: string;
  children?: string[];
}

export interface InstagramAdapter {
  readonly mode: "live" | "mock";
  getAccount(): Promise<IgAccountInfo>;
  discoverCapabilities(grantedScopes: string[], accountType?: string): Promise<CapabilityResult[]>;
  createContainer(input: CreateContainerInput): Promise<{ id: string }>;
  getContainerStatus(containerId: string): Promise<ContainerStatus>;
  publishContainer(containerId: string): Promise<{ id: string }>;
  getMedia(
    mediaId: string,
  ): Promise<{ id: string; permalink?: string; timestamp?: string; caption?: string }>;
  listRecentMedia(
    limit?: number,
  ): Promise<Array<{ id: string; caption?: string; timestamp?: string; permalink?: string }>>;
  getPublishingLimit(): Promise<{ used: number; total: number }>;
  replyToComment(commentId: string, message: string): Promise<{ id: string }>;
  sendPrivateReply(commentId: string, text: string): Promise<{ messageId: string; recipientId?: string }>;
  sendMessage(recipientIgsid: string, text: string): Promise<{ messageId: string }>;
  getMediaInsights(mediaId: string, metrics: string[]): Promise<Record<string, number>>;
}

export function capabilitiesFromScopes(scopes: string[], accountType?: string): CapabilityResult[] {
  const has = (s: string) => scopes.includes(s);
  const professional =
    !accountType || ["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(accountType.toUpperCase());
  const notPro = "Instagram professional (Business or Creator) account required";
  const r = (capability: string, ok: boolean, missing: string): CapabilityResult =>
    ok ? { capability, status: "available" } : { capability, status: "unavailable", reason: missing };
  return [
    r("account_profile", has("instagram_business_basic"), "Missing instagram_business_basic"),
    r(
      "publish_image",
      professional && has("instagram_business_content_publish"),
      professional ? "Missing instagram_business_content_publish" : notPro,
    ),
    r(
      "publish_carousel",
      professional && has("instagram_business_content_publish"),
      professional ? "Missing instagram_business_content_publish" : notPro,
    ),
    r(
      "publish_reel",
      professional && has("instagram_business_content_publish"),
      professional ? "Missing instagram_business_content_publish" : notPro,
    ),
    r(
      "publish_story",
      professional && has("instagram_business_content_publish"),
      professional ? "Missing instagram_business_content_publish" : notPro,
    ),
    r(
      "comments_read",
      has("instagram_business_manage_comments"),
      "Missing instagram_business_manage_comments",
    ),
    r(
      "comments_reply",
      has("instagram_business_manage_comments"),
      "Missing instagram_business_manage_comments",
    ),
    r(
      "private_reply",
      has("instagram_business_manage_comments") && has("instagram_business_basic"),
      "Private replies need instagram_business_manage_comments",
    ),
    has("instagram_business_manage_messages")
      ? {
          capability: "messaging",
          status: "unknown",
          reason:
            "Scope granted. Sending also requires Advanced Access (app review) and an open 24h conversation window; verified on first send.",
        }
      : {
          capability: "messaging",
          status: "unavailable",
          reason: "Missing instagram_business_manage_messages",
        },
    r(
      "insights",
      has("instagram_business_basic") && professional,
      "Insights need a professional account and instagram_business_basic",
    ),
  ];
}

export class LiveInstagramAdapter implements InstagramAdapter {
  readonly mode = "live" as const;
  constructor(
    private readonly igUserId: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private base() {
    return `https://graph.instagram.com/${env().META_GRAPH_VERSION}`;
  }
  private call<T>(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    mutation = false,
  ) {
    return graphCall<T>(
      {
        method,
        url: `${this.base()}${path}`,
        token: this.token,
        params,
        mutation,
        fetchImpl: this.fetchImpl,
      },
      "instagram",
    );
  }
  async getAccount() {
    const r = await this.call<{
      user_id?: string;
      id: string;
      username: string;
      name?: string;
      account_type?: string;
    }>("GET", "/me", {
      fields: "user_id,username,name,account_type",
    });
    return { id: r.user_id ?? r.id, username: r.username, name: r.name, accountType: r.account_type };
  }
  async discoverCapabilities(grantedScopes: string[], accountType?: string) {
    const caps = capabilitiesFromScopes(grantedScopes, accountType);
    // Live probe: the publishing-limit endpoint confirms the token can reach publishing resources.
    try {
      await this.getPublishingLimit();
    } catch (e) {
      const err = e as ProviderError;
      for (const c of caps)
        if (c.capability.startsWith("publish_"))
          Object.assign(c, {
            status: "unavailable",
            reason: `Probe failed: ${err.publicMessage ?? err.message}`,
          });
    }
    return caps;
  }
  async createContainer(i: CreateContainerInput) {
    const p: Record<string, string | boolean | undefined> = {};
    if (i.kind === "image")
      Object.assign(p, { image_url: i.mediaUrl, caption: i.caption, alt_text: i.altText });
    if (i.kind === "reel")
      Object.assign(p, { media_type: "REELS", video_url: i.mediaUrl, caption: i.caption });
    if (i.kind === "story_image") Object.assign(p, { media_type: "STORIES", image_url: i.mediaUrl });
    if (i.kind === "story_video") Object.assign(p, { media_type: "STORIES", video_url: i.mediaUrl });
    if (i.kind === "carousel_item_image")
      Object.assign(p, { is_carousel_item: true, image_url: i.mediaUrl, alt_text: i.altText });
    if (i.kind === "carousel_item_video")
      Object.assign(p, { is_carousel_item: true, media_type: "VIDEO", video_url: i.mediaUrl });
    if (i.kind === "carousel")
      Object.assign(p, { media_type: "CAROUSEL", children: i.children?.join(","), caption: i.caption });
    // Container creation has no external visibility; it is safe to retry.
    return this.call<{ id: string }>("POST", `/${this.igUserId}/media`, p, false);
  }
  async getContainerStatus(id: string) {
    const r = await this.call<{ status_code: ContainerStatus }>("GET", `/${id}`, { fields: "status_code" });
    return r.status_code;
  }
  publishContainer(id: string) {
    return this.call<{ id: string }>("POST", `/${this.igUserId}/media_publish`, { creation_id: id }, true);
  }
  getMedia(mediaId: string) {
    return this.call<{ id: string; permalink?: string; timestamp?: string; caption?: string }>(
      "GET",
      `/${mediaId}`,
      { fields: "id,permalink,timestamp,caption" },
    );
  }
  async listRecentMedia(limit = 25) {
    const r = await this.call<{
      data: Array<{ id: string; caption?: string; timestamp?: string; permalink?: string }>;
    }>("GET", `/${this.igUserId}/media`, {
      fields: "id,caption,timestamp,permalink",
      limit,
    });
    return r.data ?? [];
  }
  async getPublishingLimit() {
    const r = await this.call<{ data: Array<{ quota_usage: number; config?: { quota_total: number } }> }>(
      "GET",
      `/${this.igUserId}/content_publishing_limit`,
      {
        fields: "quota_usage,config",
      },
    );
    const d = r.data?.[0];
    return { used: d?.quota_usage ?? 0, total: d?.config?.quota_total ?? 100 };
  }
  replyToComment(commentId: string, message: string) {
    return this.call<{ id: string }>("POST", `/${commentId}/replies`, { message }, true);
  }
  async sendPrivateReply(commentId: string, text: string) {
    const r = await this.postJson<{ recipient_id?: string; message_id: string }>(
      `/${this.igUserId}/messages`,
      {
        recipient: { comment_id: commentId },
        message: { text },
      },
    );
    return { messageId: r.message_id, recipientId: r.recipient_id };
  }
  async sendMessage(recipientIgsid: string, text: string) {
    const r = await this.postJson<{ message_id: string }>(`/${this.igUserId}/messages`, {
      recipient: { id: recipientIgsid },
      message: { text },
    });
    return { messageId: r.message_id };
  }
  async getMediaInsights(mediaId: string, metrics: string[]) {
    const r = await this.call<{
      data: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }>;
    }>("GET", `/${mediaId}/insights`, {
      metric: metrics.join(","),
    });
    const out: Record<string, number> = {};
    for (const d of r.data ?? []) out[d.name] = d.total_value?.value ?? d.values?.[0]?.value ?? 0;
    return out;
  }
  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const { mapGraphError } = await import("./graph");
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base()}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new ProviderError("unknown_outcome", "instagram", `Network error: ${(e as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json.error) {
      const err = mapGraphError(res.status, json as never, "instagram");
      if (err.kind === "transient")
        throw new ProviderError("unknown_outcome", "instagram", err.message, err.meta);
      throw err;
    }
    return json as T;
  }
}

/**
 * Development mock. Clearly labelled "mock" everywhere it surfaces; never reachable in staging/production.
 * Failure injection markers (mock only): "[mock:fail]" → transient error, "[mock:ambiguous]" → unknown outcome,
 * "[mock:denied]" → permission error.
 */
export class MockInstagramAdapter implements InstagramAdapter {
  readonly mode = "mock" as const;
  constructor(
    private readonly igUserId: string,
    private readonly username = "mock_brand",
  ) {}
  private inject(text: string | undefined) {
    if (!text) return;
    if (text.includes("[mock:fail]"))
      throw new ProviderError("transient", "instagram", "Mock transient failure");
    if (text.includes("[mock:ambiguous]"))
      throw new ProviderError("unknown_outcome", "instagram", "Mock ambiguous outcome");
    if (text.includes("[mock:denied]"))
      throw new ProviderError("permission", "instagram", "Mock permission denied");
  }
  async getAccount() {
    return {
      id: this.igUserId,
      username: this.username,
      name: "Mock Brand (development)",
      accountType: "BUSINESS",
    };
  }
  async discoverCapabilities(scopes: string[], accountType?: string) {
    return capabilitiesFromScopes(scopes, accountType).map((c) =>
      c.capability === "messaging" && c.status === "unknown"
        ? { ...c, status: "available" as const, reason: "Mock account: messaging simulated" }
        : c,
    );
  }
  async createContainer(i: CreateContainerInput) {
    this.inject(i.caption);
    return { id: `mock_container_${randomUUID()}` };
  }
  async getContainerStatus() {
    return "FINISHED" as const;
  }
  async publishContainer() {
    return { id: `mock_media_${randomUUID()}` };
  }
  async getMedia(mediaId: string) {
    return {
      id: mediaId,
      permalink: `https://mock.invalid/instagram/${mediaId}`,
      timestamp: new Date().toISOString(),
    };
  }
  async listRecentMedia() {
    return [];
  }
  async getPublishingLimit() {
    return { used: 0, total: 100 };
  }
  async replyToComment(_commentId: string, message: string) {
    this.inject(message);
    return { id: `mock_reply_${randomUUID()}` };
  }
  async sendPrivateReply(_commentId: string, text: string) {
    this.inject(text);
    return { messageId: `mock_pm_${randomUUID()}`, recipientId: "mock_igsid" };
  }
  async sendMessage(_r: string, text: string) {
    this.inject(text);
    return { messageId: `mock_dm_${randomUUID()}` };
  }
  async getMediaInsights() {
    // Mock accounts return no metrics: the product never fabricates performance numbers.
    return {};
  }
}

// ───────────────────────────── OAuth (Business Login for Instagram) ─────────────────────────────

export function instagramAuthorizeUrl(state: string, redirectUri: string) {
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", env().META_APP_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", IG_SCOPES.join(","));
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeInstagramCode(
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
) {
  const e = env();
  const form = new URLSearchParams({
    client_id: e.META_APP_ID ?? "",
    client_secret: e.META_APP_SECRET ?? "",
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const res = await fetchImpl("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    user_id?: string | number;
    permissions?: string[] | string;
    error_message?: string;
  };
  if (!res.ok || !json.access_token)
    throw new ProviderError("auth", "instagram", `Code exchange failed: ${json.error_message ?? res.status}`);
  const shortToken = json.access_token;
  // Exchange for a long-lived (60 day) token.
  const ll = new URL("https://graph.instagram.com/access_token");
  ll.searchParams.set("grant_type", "ig_exchange_token");
  ll.searchParams.set("client_secret", e.META_APP_SECRET ?? "");
  ll.searchParams.set("access_token", shortToken);
  const llRes = await fetchImpl(ll, { signal: AbortSignal.timeout(20_000) });
  const llJson = (await llRes.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  const permissions = Array.isArray(json.permissions)
    ? json.permissions
    : String(json.permissions ?? "")
        .split(",")
        .filter(Boolean);
  return {
    accessToken: llJson.access_token ?? shortToken,
    expiresAt: new Date(Date.now() + (llJson.expires_in ?? 3600) * 1000),
    userId: String(json.user_id ?? ""),
    scopes: permissions,
  };
}

export async function refreshInstagramToken(token: string, fetchImpl: typeof fetch = fetch) {
  const u = new URL("https://graph.instagram.com/refresh_access_token");
  u.searchParams.set("grant_type", "ig_refresh_token");
  u.searchParams.set("access_token", token);
  const res = await fetchImpl(u, { signal: AbortSignal.timeout(20_000) });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: { code?: number; message?: string };
  };
  if (!res.ok || !json.access_token) {
    const { mapGraphError } = await import("./graph");
    throw mapGraphError(res.status, json as never, "instagram");
  }
  return { accessToken: json.access_token, expiresAt: new Date(Date.now() + (json.expires_in ?? 0) * 1000) };
}
