import { randomUUID } from "node:crypto";
import { env } from "../../env";
import { ProviderError, type ProviderErrorKind } from "../errors";
import {
  httpJson,
  injectMockFailure,
  type CapabilityResult,
  type ChannelPublisher,
  type OAuthTokens,
  type PublishInput,
  type PublishStep,
} from "./types";

/**
 * TikTok Content Posting API (open.tiktokapis.com), docs Oct 2026:
 *  - POST /v2/post/publish/creator_info/query/ → privacy_level_options, username, max_video_post_duration_sec
 *  - Video: POST /v2/post/publish/video/init/ { post_info{title, privacy_level, …}, source_info{source: PULL_FROM_URL, video_url} }
 *  - Photos: POST /v2/post/publish/content/init/ { post_info, source_info{PULL_FROM_URL, photo_images, photo_cover_index},
 *    post_mode: DIRECT_POST, media_type: PHOTO }
 *  - Status: POST /v2/post/publish/status/fetch/ { publish_id } → PROCESSING_DOWNLOAD | PUBLISH_COMPLETE | FAILED
 *  - PULL_FROM_URL requires the media URL prefix/domain to be verified in the TikTok developer portal.
 *  - Unaudited apps can only post with privacy SELF_ONLY. privacy_level must be one the creator offers.
 *  - OAuth v2: tiktok.com/v2/auth/authorize/ → POST /v2/oauth/token/ (access 24h, refresh 365 days).
 */

export const TIKTOK_SCOPES = ["user.info.basic", "video.publish"] as const;
const API = () => env().TIKTOK_API_BASE;

export function tiktokCapabilities(scopes: string[]): CapabilityResult[] {
  return [
    scopes.includes("video.publish")
      ? { capability: "publish", status: "available" }
      : { capability: "publish", status: "unavailable", reason: "Missing video.publish" },
  ];
}

const ERROR_KINDS: Record<string, ProviderErrorKind> = {
  access_token_invalid: "auth",
  scope_not_authorized: "permission",
  scope_permission_missed: "permission",
  rate_limit_exceeded: "rate_limit",
  spam_risk_too_many_posts: "rate_limit",
  spam_risk_user_banned_from_posting: "policy",
  reached_active_user_cap: "rate_limit",
  unaudited_client_can_only_post_to_private_accounts: "permission",
  url_ownership_unverified: "permission",
  privacy_level_option_mismatch: "invalid",
  invalid_param: "invalid",
};

function tiktokError(status: number, body: unknown) {
  const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
  if (!err?.code || err.code === "ok") return status >= 400 ? { message: `TikTok HTTP ${status}` } : null;
  return {
    kind: ERROR_KINDS[err.code] ?? (status >= 500 ? "transient" : "invalid"),
    message: `TikTok ${err.code}: ${err.message ?? ""}`.trim(),
  };
}

export interface TikTokCreatorInfo {
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  max_video_post_duration_sec?: number;
}

export class LiveTikTokAdapter implements ChannelPublisher {
  readonly mode = "live" as const;
  readonly provider = "tiktok" as const;
  constructor(
    private readonly openId: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private post<T>(path: string, json: unknown, mutation = false) {
    return httpJson<{ data: T }>(
      "tiktok",
      {
        method: "POST",
        url: `${API()}${path}`,
        token: this.token,
        json,
        mutation,
        fetchImpl: this.fetchImpl,
      },
      tiktokError,
    ).then((r) => r.data);
  }
  creatorInfo() {
    return this.post<TikTokCreatorInfo>("/v2/post/publish/creator_info/query/", {});
  }
  async getProfile() {
    const c = await this.creatorInfo();
    return {
      id: this.openId,
      name: c.creator_nickname ?? c.creator_username ?? "TikTok",
      username: c.creator_username ?? null,
    };
  }
  async publish(i: PublishInput): Promise<PublishStep> {
    const privacy = i.privacyLevel ?? "SELF_ONLY";
    // TikTok requires the privacy level to be one the creator currently offers; check right before posting.
    const info = await this.creatorInfo();
    if (info.privacy_level_options && !info.privacy_level_options.includes(privacy))
      throw new ProviderError(
        "invalid",
        "tiktok",
        `Privacy "${privacy}" is not available for this creator (allowed: ${info.privacy_level_options.join(", ")})`,
      );
    let r: { publish_id: string };
    if (i.format === "carousel") {
      r = await this.post(
        "/v2/post/publish/content/init/",
        {
          post_info: {
            title: firstLine(i.text, 90),
            description: i.text.slice(0, 4000),
            privacy_level: privacy,
          },
          source_info: {
            source: "PULL_FROM_URL",
            photo_cover_index: 0,
            photo_images: i.media.map((m) => m.url),
          },
          post_mode: "DIRECT_POST",
          media_type: "PHOTO",
        },
        true,
      );
    } else {
      r = await this.post(
        "/v2/post/publish/video/init/",
        {
          post_info: { title: i.text.slice(0, 2200), privacy_level: privacy },
          source_info: { source: "PULL_FROM_URL", video_url: i.media[0]!.url },
        },
        true,
      );
    }
    return {
      state: "processing",
      ref: { publishId: r.publish_id, username: info.creator_username ?? "" },
      checkAfterMs: 15_000,
    };
  }
  async checkPublish(ref: Record<string, string | string[]>): Promise<PublishStep> {
    const d = await this.post<{
      status: string;
      fail_reason?: string;
      publicaly_available_post_id?: Array<number | string>;
    }>("/v2/post/publish/status/fetch/", { publish_id: String(ref.publishId) });
    if (d.status === "FAILED")
      throw new ProviderError("invalid", "tiktok", `TikTok publish failed: ${d.fail_reason ?? "unknown"}`);
    if (d.status !== "PUBLISH_COMPLETE") return { state: "processing", ref, checkAfterMs: 30_000 };
    const postId = d.publicaly_available_post_id?.[0];
    const user = String(ref.username ?? "");
    return {
      state: "published",
      // The public post ID appears only after moderation for public posts; fall back to the publish ID.
      id: postId ? String(postId) : String(ref.publishId),
      permalink: postId && user ? `https://www.tiktok.com/@${user}/video/${postId}` : null,
    };
  }
  async findRecent() {
    return undefined; // No reliable lookup with these scopes: ambiguous outcomes need a human.
  }
}

function firstLine(text: string, max: number) {
  return (text.split("\n")[0] ?? "").slice(0, max);
}

export class MockTikTokAdapter implements ChannelPublisher {
  readonly mode = "mock" as const;
  readonly provider = "tiktok" as const;
  constructor(private readonly openId: string) {}
  async getProfile() {
    return { id: this.openId, name: "Mock TikTok (development)", username: "mock_brand" };
  }
  async publish(i: PublishInput): Promise<PublishStep> {
    injectMockFailure("tiktok", i.text);
    return { state: "processing", ref: { publishId: `mock_tt_pub_${randomUUID()}` }, checkAfterMs: 1000 };
  }
  async checkPublish(ref: Record<string, string | string[]>): Promise<PublishStep> {
    const id = String(ref.publishId);
    return { state: "published", id, permalink: `https://mock.invalid/tiktok/${id}` };
  }
  async findRecent() {
    return undefined;
  }
}

// ───────────────────────────── OAuth v2 ─────────────────────────────

export function tiktokAuthorizeUrl(state: string, redirectUri: string) {
  const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
  u.searchParams.set("client_key", env().TIKTOK_CLIENT_KEY ?? "");
  u.searchParams.set("scope", TIKTOK_SCOPES.join(","));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenRequest(form: Record<string, string>, fetchImpl: typeof fetch) {
  const e = env();
  const r = await httpJson<{
    open_id?: string;
    scope?: string;
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  }>(
    "tiktok",
    {
      method: "POST",
      url: `${API()}/v2/oauth/token/`,
      form: { client_key: e.TIKTOK_CLIENT_KEY ?? "", client_secret: e.TIKTOK_CLIENT_SECRET ?? "", ...form },
      fetchImpl,
    },
    (status, body) => {
      const b = (body ?? {}) as { error?: string; error_description?: string; access_token?: string };
      if (status >= 400 || (b.error && !b.access_token))
        return {
          kind: "auth",
          message: `TikTok token request failed: ${b.error_description ?? b.error ?? status}`,
        };
      return null;
    },
  );
  return {
    openId: r.open_id ?? "",
    tokens: {
      accessToken: r.access_token!,
      refreshToken: r.refresh_token ?? null,
      expiresAt: new Date(Date.now() + (r.expires_in ?? 86400) * 1000),
      scopes: (r.scope ?? "").split(",").filter(Boolean),
    } satisfies OAuthTokens,
  };
}

export function exchangeTikTokCode(code: string, redirectUri: string, fetchImpl: typeof fetch = fetch) {
  return tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri }, fetchImpl);
}

export async function refreshTikTokToken(refreshToken: string, fetchImpl: typeof fetch = fetch) {
  return (await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl)).tokens;
}
