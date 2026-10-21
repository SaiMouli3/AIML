import { describe, expect, it } from "vitest";
import { LiveFacebookPageAdapter, exchangeFacebookPagesCode } from "@/server/providers/social/facebook";
import { LiveThreadsAdapter } from "@/server/providers/social/threads";
import { LiveTikTokAdapter, exchangeTikTokCode } from "@/server/providers/social/tiktok";
import { LiveXAdapter, pkceChallenge, refreshXToken, xAuthorizeUrl } from "@/server/providers/social/x";
import type { PublishInput } from "@/server/providers/social/types";
import { ProviderError } from "@/server/providers/errors";

/** Fake fetch that records calls and replays fixtures shaped like the official docs. */
function recorder(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> } | Error>,
) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body,
    });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected call ${String(url)}`);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { f, calls };
}

const form = (b: unknown) => new URLSearchParams(String(b));
const json = (b: unknown) => JSON.parse(String(b)) as Record<string, unknown>;

function input(over: Partial<PublishInput> = {}): PublishInput {
  return {
    format: "post",
    text: "Hello world",
    media: [],
    ...over,
  };
}
const img = (url = "https://cdn.example.com/a.jpg") => ({
  kind: "image" as const,
  mimeType: "image/jpeg",
  url,
  sizeBytes: 10,
  load: async () => Buffer.from("0123456789"),
});
const vid = (url = "https://cdn.example.com/v.mp4") => ({
  kind: "video" as const,
  mimeType: "video/mp4",
  url,
  sizeBytes: 10,
  load: async () => Buffer.from("0123456789"),
});

describe("Facebook Pages adapter contract", () => {
  it("photo post uses /photos with url + message and returns the post_id permalink", async () => {
    const { f, calls } = recorder([
      { body: { id: "photo_1", post_id: "123_456" } },
      { body: { permalink_url: "https://www.facebook.com/123/posts/456" } },
    ]);
    const fb = new LiveFacebookPageAdapter("123", "PAGE_TOKEN", f);
    const r = await fb.publish(input({ media: [img()] }));
    expect(r).toEqual({
      state: "published",
      id: "123_456",
      permalink: "https://www.facebook.com/123/posts/456",
    });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/123/photos");
    expect(calls[0]!.headers.Authorization).toBe("Bearer PAGE_TOKEN");
    expect(form(calls[0]!.body).get("url")).toBe("https://cdn.example.com/a.jpg");
    expect(form(calls[0]!.body).get("message")).toBe("Hello world");
  });

  it("multi-photo uploads unpublished photos then attaches them to one feed post", async () => {
    const { f, calls } = recorder([
      { body: { id: "p1" } },
      { body: { id: "p2" } },
      { body: { id: "123_789" } },
      { body: {} },
    ]);
    const fb = new LiveFacebookPageAdapter("123", "T", f);
    const r = await fb.publish(
      input({ format: "carousel", media: [img(), img("https://cdn.example.com/b.jpg")] }),
    );
    expect(r.state).toBe("published");
    expect(form(calls[0]!.body).get("published")).toBe("false");
    expect(calls[2]!.url).toBe("https://graph.facebook.com/v26.0/123/feed");
    expect(JSON.parse(form(calls[2]!.body).get("attached_media")!)).toEqual([
      { media_fbid: "p1" },
      { media_fbid: "p2" },
    ]);
  });

  it("video posts are processed asynchronously and checked by status", async () => {
    const { f, calls } = recorder([
      { body: { id: "vid_1" } },
      { body: { status: { video_status: "processing" } } },
      { body: { status: { video_status: "ready" }, permalink_url: "/123/videos/vid_1", post_id: "123_9" } },
    ]);
    const fb = new LiveFacebookPageAdapter("123", "T", f);
    const step = await fb.publish(input({ format: "reel", media: [vid()] }));
    expect(step).toMatchObject({ state: "processing", ref: { videoId: "vid_1" } });
    expect(form(calls[0]!.body).get("file_url")).toBe("https://cdn.example.com/v.mp4");
    expect(form(calls[0]!.body).get("description")).toBe("Hello world");
    const ref = step.state === "processing" ? step.ref : {};
    expect((await fb.checkPublish(ref)).state).toBe("processing");
    expect(await fb.checkPublish(ref)).toEqual({
      state: "published",
      id: "123_9",
      permalink: "https://www.facebook.com/123/videos/vid_1",
    });
  });

  it("private replies go to /{page}/messages with recipient.comment_id; Messenger replies use RESPONSE", async () => {
    const { f, calls } = recorder([
      { body: { recipient_id: "psid_1", message_id: "m_1" } },
      { body: { message_id: "m_2" } },
    ]);
    const fb = new LiveFacebookPageAdapter("123", "T", f);
    expect(await fb.sendPrivateReply("c_1", "Here is the link")).toEqual({
      messageId: "m_1",
      recipientId: "psid_1",
    });
    expect(JSON.parse(form(calls[0]!.body).get("recipient")!)).toEqual({ comment_id: "c_1" });
    await fb.sendMessage("psid_1", "Hi");
    expect(form(calls[1]!.body).get("messaging_type")).toBe("RESPONSE");
    expect(JSON.parse(form(calls[1]!.body).get("recipient")!)).toEqual({ id: "psid_1" });
  });

  it("OAuth exchange returns one grant per Page with its own token and tasks", async () => {
    const { f, calls } = recorder([
      { body: { access_token: "short" } },
      { body: { access_token: "long" } },
      {
        body: {
          data: [
            { permission: "pages_manage_posts", status: "granted" },
            { permission: "pages_messaging", status: "declined" },
          ],
        },
      },
      { body: { data: [{ id: "1", name: "Lumen", access_token: "page_tok", tasks: ["CREATE_CONTENT"] }] } },
    ]);
    const r = await exchangeFacebookPagesCode("code", "https://app.example.com/cb", f);
    expect(r.scopes).toEqual(["pages_manage_posts"]);
    expect(r.pages).toEqual([
      { id: "1", name: "Lumen", username: undefined, accessToken: "page_tok", tasks: ["CREATE_CONTENT"] },
    ]);
    expect(calls[3]!.headers.Authorization).toBe("Bearer long");
  });

  it("a network failure on a mutation is an unknown outcome, never a blind retry", async () => {
    const { f } = recorder([new TypeError("socket hang up")]);
    const fb = new LiveFacebookPageAdapter("123", "T", f);
    await expect(fb.publish(input())).rejects.toMatchObject({ kind: "unknown_outcome" });
  });
});

describe("Threads adapter contract", () => {
  it("creates a TEXT container, waits for FINISHED, then publishes and reads the permalink", async () => {
    const { f, calls } = recorder([
      { body: { id: "c1" } },
      { body: { status: "IN_PROGRESS" } },
      { body: { status: "FINISHED" } },
      { body: { id: "t1" } },
      { body: { permalink: "https://www.threads.com/@b/post/x" } },
    ]);
    const th = new LiveThreadsAdapter("u1", "TH", f);
    const step = await th.publish(input());
    expect(calls[0]!.url).toBe("https://graph.threads.com/v1.0/u1/threads");
    expect(form(calls[0]!.body).get("media_type")).toBe("TEXT");
    expect(step).toMatchObject({ state: "processing", ref: { containerId: "c1" } });
    const ref = step.state === "processing" ? step.ref : {};
    expect((await th.checkPublish(ref)).state).toBe("processing");
    expect(await th.checkPublish(ref)).toEqual({
      state: "published",
      id: "t1",
      permalink: "https://www.threads.com/@b/post/x",
    });
    expect(calls[3]!.url).toBe("https://graph.threads.com/v1.0/u1/threads_publish");
    expect(form(calls[3]!.body).get("creation_id")).toBe("c1");
  });

  it("carousels create item containers then a CAROUSEL container with children", async () => {
    const { f, calls } = recorder([{ body: { id: "i1" } }, { body: { id: "i2" } }, { body: { id: "car" } }]);
    const th = new LiveThreadsAdapter("u1", "TH", f);
    await th.publish(input({ format: "carousel", media: [img(), vid()] }));
    expect(form(calls[0]!.body).get("is_carousel_item")).toBe("true");
    expect(form(calls[1]!.body).get("media_type")).toBe("VIDEO");
    expect(form(calls[2]!.body).get("children")).toBe("i1,i2");
  });

  it("an already-PUBLISHED container is reported as an unknown outcome (reconcile, do not re-publish)", async () => {
    const { f } = recorder([{ body: { status: "PUBLISHED" } }]);
    await expect(
      new LiveThreadsAdapter("u1", "TH", f).checkPublish({ containerId: "c1" }),
    ).rejects.toMatchObject({
      kind: "unknown_outcome",
    });
  });
});

describe("X adapter contract", () => {
  it("text posts call POST /2/tweets with JSON and bearer user token", async () => {
    const { f, calls } = recorder([{ status: 201, body: { data: { id: "190", text: "Hello world" } } }]);
    const x = new LiveXAdapter("XTOK", f);
    expect(await x.publish(input())).toEqual({
      state: "published",
      id: "190",
      permalink: "https://x.com/i/web/status/190",
    });
    expect(calls[0]!.url).toBe("https://api.x.com/2/tweets");
    expect(calls[0]!.headers.Authorization).toBe("Bearer XTOK");
    expect(json(calls[0]!.body)).toEqual({ text: "Hello world" });
  });

  it("media goes through v2 chunked upload (initialize → append → finalize) before the post", async () => {
    const { f, calls } = recorder([
      { body: { data: { id: "m1" } } },
      { body: {} },
      { body: { data: { id: "m1" } } },
      { status: 201, body: { data: { id: "191" } } },
    ]);
    const x = new LiveXAdapter("XTOK", f);
    await x.publish(input({ media: [img()] }));
    expect(calls[0]!.url).toBe("https://api.x.com/2/media/upload/initialize");
    expect(json(calls[0]!.body)).toEqual({
      media_type: "image/jpeg",
      total_bytes: 10,
      media_category: "tweet_image",
    });
    expect(calls[1]!.url).toBe("https://api.x.com/2/media/upload/m1/append");
    expect(calls[1]!.body).toBeInstanceOf(FormData);
    expect((calls[1]!.body as FormData).get("segment_index")).toBe("0");
    expect(calls[2]!.url).toBe("https://api.x.com/2/media/upload/m1/finalize");
    expect(json(calls[3]!.body)).toEqual({ text: "Hello world", media: { media_ids: ["m1"] } });
  });

  it("video still processing returns a processing step; STATUS polling then posts", async () => {
    const { f, calls } = recorder([
      { body: { data: { id: "v1" } } },
      { body: {} },
      { body: { data: { id: "v1", processing_info: { state: "pending", check_after_secs: 3 } } } },
      { body: { data: { processing_info: { state: "succeeded" } } } },
      { status: 201, body: { data: { id: "192" } } },
    ]);
    const x = new LiveXAdapter("XTOK", f);
    const step = await x.publish(input({ format: "reel", media: [vid()] }));
    expect(step).toMatchObject({ state: "processing", ref: { mediaIds: ["v1"] }, checkAfterMs: 5000 });
    expect(json(calls[0]!.body).media_category).toBe("tweet_video");
    const r = await x.checkPublish(step.state === "processing" ? step.ref : {}, input());
    expect(calls[3]!.url).toBe("https://api.x.com/2/media/upload?command=STATUS&media_id=v1");
    expect(r).toMatchObject({ state: "published", id: "192" });
  });

  it("maps 429 to rate_limit with reset, 401 to auth and duplicate content to invalid", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const { f } = recorder([
      { status: 429, body: { title: "Too Many Requests" }, headers: { "x-rate-limit-reset": String(reset) } },
      { status: 401, body: { title: "Unauthorized" } },
      { status: 403, body: { detail: "You are not allowed to create a Tweet with duplicate content." } },
    ]);
    const x = new LiveXAdapter("XTOK", f);
    const e1 = (await x.publish(input()).catch((e) => e)) as ProviderError;
    expect(e1.kind).toBe("rate_limit");
    expect(e1.meta.retryAfterMs).toBeGreaterThan(500_000);
    await expect(x.publish(input())).rejects.toMatchObject({ kind: "auth" });
    await expect(x.publish(input())).rejects.toMatchObject({ kind: "invalid" });
  });

  it("OAuth 2.0 uses PKCE S256 and HTTP Basic client auth; refresh keeps the rotated refresh token", async () => {
    process.env.X_CLIENT_ID = "cid";
    process.env.X_CLIENT_SECRET = "csecret";
    const { resetEnvCache } = await import("@/server/env");
    resetEnvCache();
    const u = new URL(xAuthorizeUrl("st", "https://app.example.com/cb", "verifier123"));
    expect(u.origin + u.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(u.searchParams.get("code_challenge")).toBe(pkceChallenge("verifier123"));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toContain("offline.access");
    const { f, calls } = recorder([
      {
        body: { access_token: "a2", refresh_token: "r2", expires_in: 7200, scope: "tweet.read tweet.write" },
      },
    ]);
    const t = await refreshXToken("r1", f);
    expect(t).toMatchObject({ accessToken: "a2", refreshToken: "r2", scopes: ["tweet.read", "tweet.write"] });
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("cid:csecret").toString("base64")}`);
    expect(form(calls[0]!.body).get("grant_type")).toBe("refresh_token");
    delete process.env.X_CLIENT_ID;
    delete process.env.X_CLIENT_SECRET;
    resetEnvCache();
  });
});

describe("TikTok adapter contract", () => {
  const creator = {
    data: { creator_username: "lumen", privacy_level_options: ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS"] },
    error: { code: "ok" },
  };

  it("checks creator privacy options, then direct-posts a video via PULL_FROM_URL", async () => {
    const { f, calls } = recorder([
      { body: creator },
      { body: { data: { publish_id: "pub_1" }, error: { code: "ok" } } },
      { body: { data: { status: "PROCESSING_DOWNLOAD" }, error: { code: "ok" } } },
      {
        body: {
          data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [7300] },
          error: { code: "ok" },
        },
      },
    ]);
    const tt = new LiveTikTokAdapter("open_1", "TT", f);
    const step = await tt.publish(input({ format: "reel", media: [vid()], privacyLevel: "SELF_ONLY" }));
    expect(calls[0]!.url).toBe("https://open.tiktokapis.com/v2/post/publish/creator_info/query/");
    expect(calls[1]!.url).toBe("https://open.tiktokapis.com/v2/post/publish/video/init/");
    expect(json(calls[1]!.body)).toEqual({
      post_info: { title: "Hello world", privacy_level: "SELF_ONLY" },
      source_info: { source: "PULL_FROM_URL", video_url: "https://cdn.example.com/v.mp4" },
    });
    expect(step).toMatchObject({ state: "processing", ref: { publishId: "pub_1", username: "lumen" } });
    const ref = step.state === "processing" ? step.ref : {};
    expect((await tt.checkPublish(ref)).state).toBe("processing");
    expect(await tt.checkPublish(ref)).toEqual({
      state: "published",
      id: "7300",
      permalink: "https://www.tiktok.com/@lumen/video/7300",
    });
  });

  it("refuses a privacy level the creator does not offer (no post is created)", async () => {
    const { f, calls } = recorder([{ body: creator }]);
    const tt = new LiveTikTokAdapter("open_1", "TT", f);
    await expect(
      tt.publish(input({ format: "reel", media: [vid()], privacyLevel: "PUBLIC_TO_EVERYONE" })),
    ).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(calls).toHaveLength(1);
  });

  it("photo posts use content/init with media_type PHOTO and DIRECT_POST", async () => {
    const { f, calls } = recorder([
      { body: creator },
      { body: { data: { publish_id: "pub_2" }, error: { code: "ok" } } },
    ]);
    const tt = new LiveTikTokAdapter("open_1", "TT", f);
    await tt.publish(
      input({
        format: "carousel",
        media: [img(), img("https://cdn.example.com/b.jpg")],
        privacyLevel: "SELF_ONLY",
      }),
    );
    const b = json(calls[1]!.body) as {
      media_type: string;
      post_mode: string;
      source_info: { photo_images: string[] };
    };
    expect(calls[1]!.url).toBe("https://open.tiktokapis.com/v2/post/publish/content/init/");
    expect(b.media_type).toBe("PHOTO");
    expect(b.post_mode).toBe("DIRECT_POST");
    expect(b.source_info.photo_images).toHaveLength(2);
  });

  it("maps TikTok error codes: unaudited client → permission, token → auth, failed publish → invalid", async () => {
    const { f } = recorder([
      {
        status: 403,
        body: { error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "x" } },
      },
      { status: 401, body: { error: { code: "access_token_invalid", message: "x" } } },
      {
        body: { data: { status: "FAILED", fail_reason: "file_format_check_failed" }, error: { code: "ok" } },
      },
    ]);
    const tt = new LiveTikTokAdapter("open_1", "TT", f);
    await expect(tt.creatorInfo()).rejects.toMatchObject({ kind: "permission" });
    await expect(tt.creatorInfo()).rejects.toMatchObject({ kind: "auth" });
    await expect(tt.checkPublish({ publishId: "p" })).rejects.toThrow(/file_format_check_failed/);
  });

  it("token exchange posts client_key/secret as a form and returns open_id + refresh token", async () => {
    const { f, calls } = recorder([
      {
        body: {
          open_id: "o1",
          scope: "user.info.basic,video.publish",
          access_token: "at",
          refresh_token: "rt",
          expires_in: 86400,
        },
      },
    ]);
    const r = await exchangeTikTokCode("code", "https://app.example.com/cb", f);
    expect(r.openId).toBe("o1");
    expect(r.tokens).toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
      scopes: ["user.info.basic", "video.publish"],
    });
    expect(calls[0]!.url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    expect(form(calls[0]!.body).get("grant_type")).toBe("authorization_code");
  });
});
