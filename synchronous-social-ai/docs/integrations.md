# Integrations

Status legend: **Live adapter** = real implementation against the official API, needs your credentials · **Mock** = labelled development mock · **Adapter boundary** = interface only.

| Integration                                        | Status                                                                                           | Credentials                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| LLM gateway (Experiential Labs, OpenAI-compatible) | Live adapter, verified with a real key on 2026-10-21 (`/models`, structured `/chat/completions`) | `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_DEFAULT`, `LLM_MODEL_FAST`             |
| Instagram API with Instagram Login                 | Live adapter (not exercised against a real account in this environment) + mock                   | `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`                    |
| Facebook Pages                                     | Live adapter (not exercised against a real Page) + mock; publishing + comment-to-DM inbox        | same Meta app (`META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`)    |
| Threads                                            | Live adapter (not exercised) + mock; publishing only                                             | `THREADS_APP_ID`, `THREADS_APP_SECRET`                                           |
| X (formerly Twitter)                               | Live adapter (not exercised) + mock; publishing only                                             | `X_CLIENT_ID`, `X_CLIENT_SECRET`                                                 |
| TikTok                                             | Live adapter (not exercised) + mock; direct posting only                                         | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`                                      |
| Meta Marketing API                                 | Live adapter (not exercised) + mock; test mode default                                           | same Meta app (Facebook Login for Business)                                      |
| Higgsfield                                         | Live adapter (not exercised — no key supplied) + mock                                            | `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_KEY_SECRET`, `HIGGSFIELD_WEBHOOK_TOKEN` |
| Object storage                                     | Local FS (dev) · S3-compatible (prod)                                                            | `STORAGE_DRIVER=s3`, `S3_*`                                                      |
| Commerce (prices/coupons)                          | **Not connected** — the product never claims to change prices                                    | —                                                                                |
| CRM                                                | Adapter boundary (`crm_sync_events` table); no provider selected                                 | —                                                                                |
| Email notifications                                | Adapter boundary; in-app notifications only                                                      | —                                                                                |

## Instagram (Business Login for Instagram) — verified against Meta docs, Oct 2026

- OAuth: `https://www.instagram.com/oauth/authorize` → `POST https://api.instagram.com/oauth/access_token` → long-lived token via `GET graph.instagram.com/access_token?grant_type=ig_exchange_token`; refreshed by the hourly `integrations.token_health` job (`ig_refresh_token`) when < 7 days remain.
- Scopes requested: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_messages`. Production use requires **App Review / Advanced Access** for each and a professional (Business/Creator) account.
- Publishing: `POST /<IG_ID>/media` (image `image_url` JPEG only, `media_type=REELS|STORIES|CAROUSEL`, `is_carousel_item`, `alt_text` for images), poll `GET /<container>?fields=status_code` (`IN_PROGRESS/FINISHED/ERROR/EXPIRED/PUBLISHED`, polled once a minute up to 10×), `POST /<IG_ID>/media_publish`. Limit checked via `content_publishing_limit` (100 posts / 24h). Media are fetched by Meta from short-lived signed URLs — `APP_URL` (or S3) must be publicly reachable over HTTPS.
- Comments: `POST /<comment_id>/replies`.
- Private replies: `POST /<IG_ID>/messages` with `recipient.comment_id`; one per comment, within 7 days (Live: only during broadcast).
- Messaging: `POST /<IG_ID>/messages` with `recipient.id`, only within 24h of the person's last message. Shown as `unknown` capability until the first send confirms Advanced Access.
- Webhooks: configure callback `https://<APP_URL>/api/v1/webhooks/meta` with your verify token; subscribe to `comments`, `live_comments`, `messages`. Signature `X-Hub-Signature-256` is verified. Meta retries for up to 36h; duplicates are acknowledged and ignored.
- API version: `META_GRAPH_VERSION` (default `v26.0`).

## Facebook Pages — verified against Meta Pages API docs, Oct 2026

- OAuth: Facebook Login dialog → code → long-lived user token (`fb_exchange_token`) → `GET /me/accounts` gives a **Page token per Page**. Each Page becomes its own connected account. Page tokens derived from a long-lived user token do not expire; they stop working if the person loses their Page role or removes the app (the UI then shows "reconnect").
- Scopes: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_engagement`, `pages_read_user_content`, `pages_manage_metadata`, `pages_messaging` (App Review / Advanced Access). Page tasks (`CREATE_CONTENT`, `MODERATE`) are respected.
- Publishing: text/link `POST /{page}/feed`; photo `POST /{page}/photos url=…` (post ID from `post_id`); multi-photo = unpublished photos + `POST /{page}/feed attached_media=[…]`; video `POST /{page}/videos file_url=…` then `GET /{video}?fields=status` until ready. Reconciliation looks for the caption in `/{page}/published_posts`.
- Inbox: on connect the Page is subscribed with `POST /{page}/subscribed_apps subscribed_fields=feed,messages`. Webhooks arrive on the same `/api/v1/webhooks/meta` endpoint (`object: "page"`). Only `feed` comment **additions** are processed; the Page's own comments are ignored as echoes. Replies: public `POST /{comment}/comments`; private `POST /{page}/messages recipient={comment_id}` (one per comment, within 7 days); Messenger `messaging_type=RESPONSE` within 24 hours of the person's last message.

## Threads — verified against Meta Threads API docs, Oct 2026

- OAuth: `https://threads.com/oauth/authorize` → `POST graph.threads.com/oauth/access_token` → 60-day token via `th_exchange_token`; refreshed by the token-health job with `th_refresh_token` when < 7 days remain. Hosts are configurable (`THREADS_GRAPH_HOST`, `THREADS_AUTHORIZE_URL`).
- Scopes: `threads_basic`, `threads_content_publish`.
- Publishing: container `POST /{user}/threads` (`TEXT`, `IMAGE`, `VIDEO`, or `CAROUSEL` of 2–20 items), wait ~30 s and poll `GET /{container}?fields=status,error_message` once a minute, then `POST /{user}/threads_publish creation_id=…`. 500-character limit; 250 posts / 24 h. A container already `PUBLISHED` is treated as an uncertain outcome and reconciled against `/{user}/threads` rather than re-published.

## X — verified against docs.x.com, Oct 2026

- OAuth 2.0 Authorization Code **with PKCE (S256)**; the verifier is stored encrypted with the single-use state. Token endpoint `POST api.x.com/2/oauth2/token` with HTTP Basic client auth. Access tokens last 2 hours and are refreshed just in time (refresh tokens rotate; refreshes are serialized per account with a row lock).
- Scopes: `tweet.read`, `tweet.write`, `users.read`, `media.write`, `offline.access`.
- Publishing: `POST /2/tweets { text, media.media_ids }`. Media use the v2 chunked upload (`/2/media/upload/initialize` → `/{id}/append` (≤4 MB chunks) → `/{id}/finalize` → `GET /2/media/upload?command=STATUS` while processing). 280 characters (URLs count as 23); up to 4 images or one video. 429 honours `x-rate-limit-reset`; duplicate-content rejections are not retried.
- Requires an X developer project with a plan that includes posting.

## TikTok — verified against TikTok Content Posting API docs, Oct 2026

- OAuth v2: `tiktok.com/v2/auth/authorize/` → `POST open.tiktokapis.com/v2/oauth/token/`. Access tokens last 24 h (refreshed just in time), refresh tokens 365 days.
- Scopes: `user.info.basic`, `video.publish`.
- Publishing: right before each post, `creator_info/query` is called and the chosen **privacy level** must be one the creator offers. Video `POST /v2/post/publish/video/init/` and photo posts `POST /v2/post/publish/content/init/` (`media_type=PHOTO`, `post_mode=DIRECT_POST`), both `PULL_FROM_URL`, then `POST /v2/post/publish/status/fetch/` until `PUBLISH_COMPLETE` or `FAILED`. The publish ID is persisted between checks, so a retry continues the same post.
- The visibility level is set per account in Integrations (default "Only me") and is part of the approved payload: changing it invalidates open approvals.
- **Audit:** until your app passes TikTok's audit, posts can only be private (`SELF_ONLY`). **Domain verification:** the media URL prefix (your S3/CDN or `APP_URL`) must be verified in the TikTok developer portal for `PULL_FROM_URL`.
- There is no reliable lookup of a post from an uncertain outcome with these scopes, so ambiguous results are left for a person (Operations → resolve).

## Meta Marketing API

- Facebook Login for Business: `ads_management`, `ads_read`, `business_management`, `pages_show_list` (Advanced Access + Business Verification).
- Each returned ad account becomes a connected account; set the **Facebook Page ID** per ad account (needed for creatives).
- Launch creates campaign → ad set (daily budget in minor units, `start_time`/`end_time`, Instagram placements, optional pixel `promoted_object`) → creative (`object_story_spec.link_data`) → ad, all `status=PAUSED`. Activation happens only when `META_ADS_TEST_MODE=false`. Campaign names carry `[ssa:<approval>]` for reconciliation.
- Insights: `GET /<campaign>/insights` every 6h → `ad_metrics_snapshots` (cumulative windows, source-labelled).
- Facebook long-lived user tokens (~60 days) cannot be refreshed server-side; the UI shows expiry and asks to reconnect.

## Higgsfield — verified against docs.higgsfield.ai, Oct 2026

- Auth `Authorization: Key <id>:<secret>`; base `https://api.higgsfield.ai`.
- Catalog in code (schemas read from model pages): SOUL 2 image `/higgsfield-ai/soul/v2/standard`; Kling 3.0 Standard text-to-video `/kling-video/v3.0/std/text-to-video` (3–15s, 16:9/9:16/1:1). Availability depends on your account — confirm in console.higgsfield.ai.
- Submission uses `Idempotency-Key` (stable per job) and optional `?hf_webhook=` (our URL with a secret token). Polling 2s→10s with jitter; terminal `completed|failed|nsfw|canceled`; cancel only while queued (400 otherwise). Estimates via `POST /estimate/<path>`. Failed/NSFW are not charged. Outputs are downloaded, validated and stored in tenant storage (provider keeps them ≥7 days).

## What you need to provide

1. **Meta app** (developers.facebook.com): Instagram product with Business Login; Facebook Login (Pages permissions) for Facebook Pages; Facebook Login for Business for ads; redirect URIs shown in Integrations → Setup details; webhook callback + verify token (subscribe the `instagram` and `page` objects); App Review for the scopes above; Business Verification; an Instagram professional account and a Facebook Page; a Pixel for ads.
2. **Threads**: add the Threads use case to the Meta app and copy its Threads app ID/secret.
3. **X**: a developer project + app with OAuth 2.0 enabled (type "Web App, confidential client", read and write), the redirect URI, and an API plan that allows posting.
4. **TikTok**: a TikTok for Developers app with Login Kit and the Content Posting API (Direct Post), the redirect URI, verified media domain, and an audit for public posting.
5. **Higgsfield** API key id + secret, credits, and (optional) a webhook token.
6. **Public HTTPS deployment** (`APP_URL`) for OAuth callbacks, webhooks and media fetches; S3 bucket for production media.
7. Optional: CRM / commerce / email provider choices.
