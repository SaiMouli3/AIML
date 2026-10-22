import { randomUUID } from "node:crypto";
import { env } from "../../env";
import { ProviderError } from "../errors";
import { graphCall } from "../meta/graph";
import {
  injectMockFailure,
  type CapabilityResult,
  type ChannelPublisher,
  type MessagingAdapter,
  type PublishInput,
  type PublishStep,
} from "./types";

/**
 * Facebook Pages via the Graph API (graph.facebook.com), using a Page access token obtained through
 * Facebook Login. Endpoints (Meta Pages API docs, Oct 2026):
 *  - Text/link post: POST /{page-id}/feed message=…
 *  - Photo post: POST /{page-id}/photos url=… message=… → { id, post_id }
 *  - Multi-photo: POST /{page-id}/photos url=… published=false (each) → POST /{page-id}/feed attached_media=[{media_fbid}]
 *  - Video post: POST /{page-id}/videos file_url=… description=… → { id }; GET /{video-id}?fields=status,permalink_url
 *  - Comment reply: POST /{comment-id}/comments message=…
 *  - Private reply: POST /{page-id}/messages recipient={comment_id} (one per comment, within 7 days)
 *  - Messenger reply: POST /{page-id}/messages recipient={id} messaging_type=RESPONSE (24-hour window)
 *  - Webhooks: POST /{page-id}/subscribed_apps subscribed_fields=feed,messages
 */

export const FB_PAGE_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_engagement",
  "pages_read_user_content",
  "pages_manage_metadata",
  "pages_messaging",
] as const;

export function facebookPageCapabilities(scopes: string[], tasks: string[] = []): CapabilityResult[] {
  const has = (s: string) => scopes.includes(s);
  const canCreate = !tasks.length || tasks.includes("CREATE_CONTENT") || tasks.includes("MANAGE");
  const canModerate = !tasks.length || tasks.includes("MODERATE") || tasks.includes("MANAGE");
  const r = (capability: string, ok: boolean, missing: string): CapabilityResult =>
    ok ? { capability, status: "available" } : { capability, status: "unavailable", reason: missing };
  return [
    r(
      "publish",
      has("pages_manage_posts") && canCreate,
      has("pages_manage_posts") ? "Your Page role cannot create content" : "Missing pages_manage_posts",
    ),
    r(
      "comments_read",
      has("pages_read_user_content") || has("pages_read_engagement"),
      "Missing pages_read_user_content",
    ),
    r(
      "comments_reply",
      has("pages_manage_engagement") && canModerate,
      has("pages_manage_engagement") ? "Your Page role cannot moderate" : "Missing pages_manage_engagement",
    ),
    r("private_reply", has("pages_messaging") && canModerate, "Private replies need pages_messaging"),
    has("pages_messaging")
      ? {
          capability: "messaging",
          status: "unknown",
          reason:
            "Scope granted. Sending also requires Advanced Access (app review); verified on first send.",
        }
      : { capability: "messaging", status: "unavailable", reason: "Missing pages_messaging" },
  ];
}

const base = () => `https://graph.facebook.com/${env().META_GRAPH_VERSION}`;

export class LiveFacebookPageAdapter implements ChannelPublisher, MessagingAdapter {
  readonly mode = "live" as const;
  readonly provider = "facebook" as const;
  constructor(
    private readonly pageId: string,
    private readonly pageToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private call<T>(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    mutation = false,
  ) {
    return graphCall<T>(
      { method, url: `${base()}${path}`, token: this.pageToken, params, mutation, fetchImpl: this.fetchImpl },
      "facebook",
    );
  }
  async getProfile() {
    const r = await this.call<{ id: string; name: string; username?: string }>("GET", `/${this.pageId}`, {
      fields: "id,name,username",
    });
    return { id: r.id, name: r.name, username: r.username ?? null };
  }
  private async permalink(id: string) {
    const r = await this.call<{ permalink_url?: string }>("GET", `/${id}`, { fields: "permalink_url" }).catch(
      () => ({ permalink_url: undefined }),
    );
    return r.permalink_url ? new URL(r.permalink_url, "https://www.facebook.com").toString() : null;
  }
  async publish(i: PublishInput): Promise<PublishStep> {
    if (i.format === "reel") {
      const v = await this.call<{ id: string }>(
        "POST",
        `/${this.pageId}/videos`,
        { file_url: i.media[0]!.url, description: i.text },
        true,
      );
      return { state: "processing", ref: { videoId: v.id }, checkAfterMs: 30_000 };
    }
    if (i.format === "carousel") {
      const ids: string[] = [];
      for (const m of i.media) {
        const p = await this.call<{ id: string }>(
          "POST",
          `/${this.pageId}/photos`,
          { url: m.url, published: false, alt_text_custom: m.altText },
          true,
        );
        ids.push(p.id);
      }
      const post = await this.call<{ id: string }>(
        "POST",
        `/${this.pageId}/feed`,
        { message: i.text, attached_media: JSON.stringify(ids.map((media_fbid) => ({ media_fbid }))) },
        true,
      );
      return { state: "published", id: post.id, permalink: await this.permalink(post.id) };
    }
    if (i.media.length === 1) {
      const p = await this.call<{ id: string; post_id?: string }>(
        "POST",
        `/${this.pageId}/photos`,
        { url: i.media[0]!.url, message: i.text, alt_text_custom: i.media[0]!.altText },
        true,
      );
      const id = p.post_id ?? p.id;
      return { state: "published", id, permalink: await this.permalink(id) };
    }
    const post = await this.call<{ id: string }>("POST", `/${this.pageId}/feed`, { message: i.text }, true);
    return { state: "published", id: post.id, permalink: await this.permalink(post.id) };
  }
  async checkPublish(ref: Record<string, string | string[]>): Promise<PublishStep> {
    const videoId = String(ref.videoId);
    const v = await this.call<{
      status?: { video_status?: string; processing_progress?: number };
      permalink_url?: string;
      post_id?: string;
    }>("GET", `/${videoId}`, { fields: "status,permalink_url,post_id" });
    const st = v.status?.video_status;
    if (st === "error")
      throw new ProviderError("invalid", "facebook", "Facebook could not process the video");
    if (st === "ready" || st === "published" || !st) {
      const permalink = v.permalink_url
        ? new URL(v.permalink_url, "https://www.facebook.com").toString()
        : null;
      return { state: "published", id: v.post_id ?? videoId, permalink };
    }
    return { state: "processing", ref, checkAfterMs: 60_000 };
  }
  async findRecent(text: string) {
    const r = await this.call<{ data: Array<{ id: string; message?: string; permalink_url?: string }> }>(
      "GET",
      `/${this.pageId}/published_posts`,
      { fields: "id,message,permalink_url", limit: 25 },
    );
    const hit = (r.data ?? []).find((p) => (p.message ?? "").trim() === text.trim());
    return hit ? { id: hit.id, permalink: hit.permalink_url ?? null } : null;
  }
  async replyToComment(commentId: string, message: string) {
    return this.call<{ id: string }>("POST", `/${commentId}/comments`, { message }, true);
  }
  async sendPrivateReply(commentId: string, text: string) {
    const r = await this.call<{ recipient_id?: string; message_id: string }>(
      "POST",
      `/${this.pageId}/messages`,
      { recipient: JSON.stringify({ comment_id: commentId }), message: JSON.stringify({ text }) },
      true,
    );
    return { messageId: r.message_id, recipientId: r.recipient_id };
  }
  async sendMessage(recipientId: string, text: string) {
    const r = await this.call<{ message_id: string }>(
      "POST",
      `/${this.pageId}/messages`,
      {
        recipient: JSON.stringify({ id: recipientId }),
        messaging_type: "RESPONSE",
        message: JSON.stringify({ text }),
      },
      true,
    );
    return { messageId: r.message_id };
  }
  /** Subscribe the Page to this app's webhooks so comments and Messenger events arrive. */
  async subscribeWebhooks() {
    return this.call<{ success: boolean }>(
      "POST",
      `/${this.pageId}/subscribed_apps`,
      { subscribed_fields: "feed,messages" },
      true,
    );
  }
}

export class MockFacebookPageAdapter implements ChannelPublisher, MessagingAdapter {
  readonly mode = "mock" as const;
  readonly provider = "facebook" as const;
  constructor(private readonly pageId: string) {}
  async getProfile() {
    return { id: this.pageId, name: "Mock Facebook Page (development)", username: "mockbrand" };
  }
  async publish(i: PublishInput): Promise<PublishStep> {
    injectMockFailure("facebook", i.text);
    const id = `${this.pageId}_mock_${randomUUID()}`;
    if (i.format === "reel") return { state: "processing", ref: { videoId: id }, checkAfterMs: 1000 };
    return { state: "published", id, permalink: `https://mock.invalid/facebook/${id}` };
  }
  async checkPublish(ref: Record<string, string | string[]>): Promise<PublishStep> {
    const id = String(ref.videoId);
    return { state: "published", id, permalink: `https://mock.invalid/facebook/${id}` };
  }
  async findRecent() {
    return null; // Mock accounts have no provider state: leave ambiguous outcomes to a human.
  }
  async replyToComment(_c: string, message: string) {
    injectMockFailure("facebook", message);
    return { id: `mock_fb_reply_${randomUUID()}` };
  }
  async sendPrivateReply(_c: string, text: string) {
    injectMockFailure("facebook", text);
    return { messageId: `mock_fb_pm_${randomUUID()}`, recipientId: "mock_psid" };
  }
  async sendMessage(_r: string, text: string) {
    injectMockFailure("facebook", text);
    return { messageId: `mock_fb_dm_${randomUUID()}` };
  }
}

// ───────────────────────────── OAuth (Facebook Login for Pages) ─────────────────────────────

export function facebookPagesAuthorizeUrl(state: string, redirectUri: string) {
  const u = new URL(`https://www.facebook.com/${env().META_GRAPH_VERSION}/dialog/oauth`);
  u.searchParams.set("client_id", env().META_APP_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", FB_PAGE_SCOPES.join(","));
  u.searchParams.set("response_type", "code");
  return u.toString();
}

export interface FacebookPageGrant {
  id: string;
  name: string;
  username?: string;
  accessToken: string;
  tasks: string[];
}

/**
 * Code → user token → long-lived user token → Page tokens. Page tokens derived from a long-lived user
 * token do not expire (they stop working if the user loses the Page role or revokes the app).
 */
export async function exchangeFacebookPagesCode(
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
) {
  const e = env();
  const tokenUrl = new URL(`${base()}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", e.META_APP_ID ?? "");
  tokenUrl.searchParams.set("client_secret", e.META_APP_SECRET ?? "");
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", code);
  const res = await fetchImpl(tokenUrl, { signal: AbortSignal.timeout(20_000) });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || !json.access_token)
    throw new ProviderError("auth", "facebook", `Code exchange failed (${res.status})`);
  const ll = new URL(`${base()}/oauth/access_token`);
  ll.searchParams.set("grant_type", "fb_exchange_token");
  ll.searchParams.set("client_id", e.META_APP_ID ?? "");
  ll.searchParams.set("client_secret", e.META_APP_SECRET ?? "");
  ll.searchParams.set("fb_exchange_token", json.access_token);
  const llRes = await fetchImpl(ll, { signal: AbortSignal.timeout(20_000) });
  const llJson = (await llRes.json().catch(() => ({}))) as { access_token?: string };
  const userToken = llJson.access_token ?? json.access_token;
  const perms = await graphCall<{ data: Array<{ permission: string; status: string }> }>(
    { method: "GET", url: `${base()}/me/permissions`, token: userToken, fetchImpl },
    "facebook",
  );
  const pages = await graphCall<{
    data: Array<{ id: string; name: string; username?: string; access_token: string; tasks?: string[] }>;
  }>(
    {
      method: "GET",
      url: `${base()}/me/accounts`,
      token: userToken,
      params: { fields: "id,name,username,access_token,tasks", limit: 100 },
      fetchImpl,
    },
    "facebook",
  );
  return {
    scopes: (perms.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission),
    pages: (pages.data ?? []).map((p): FacebookPageGrant => ({
      id: p.id,
      name: p.name,
      username: p.username,
      accessToken: p.access_token,
      tasks: p.tasks ?? [],
    })),
  };
}
