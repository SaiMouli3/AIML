# Integrations

Status legend: **Live adapter** = real implementation against the official API, needs your credentials · **Mock** = labelled development mock · **Adapter boundary** = interface only.

| Integration                                        | Status                                                                                           | Credentials                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| LLM gateway (Experiential Labs, OpenAI-compatible) | Live adapter, verified with a real key on 2026-10-21 (`/models`, structured `/chat/completions`) | `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_DEFAULT`, `LLM_MODEL_FAST`             |
| Instagram API with Instagram Login                 | Live adapter (not exercised against a real account in this environment) + mock                   | `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`                    |
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

1. **Meta app** (developers.facebook.com): Instagram product with Business Login; Facebook Login for Business for ads; redirect URIs shown in Integrations; webhook callback + verify token; App Review for the scopes above; Business Verification; an Instagram professional account linked as needed; a Facebook Page and Pixel for ads.
2. **Higgsfield** API key id + secret, credits, and (optional) a webhook token.
3. **Public HTTPS deployment** (`APP_URL`) for OAuth callbacks, webhooks and media fetches; S3 bucket for production media.
4. Optional: CRM / commerce / email provider choices.
