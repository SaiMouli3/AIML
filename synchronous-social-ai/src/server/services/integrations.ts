import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { audit, writeAudit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission, requireUser } from "../context";
import type { Tx } from "../db/client";
import { withSystem } from "../db/tenant";
import * as s from "../db/schema";
import { env, integrationsConfigured } from "../env";
import { AppError } from "../lib/errors";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "../lib/crypto";
import { isProviderError, ProviderError } from "../providers/errors";
import {
  capabilitiesFromScopes,
  exchangeInstagramCode,
  IG_SCOPES,
  instagramAuthorizeUrl,
  LiveInstagramAdapter,
  MockInstagramAdapter,
  refreshInstagramToken,
  type InstagramAdapter,
} from "../providers/meta/instagram";
import {
  ACCOUNT_STATUS,
  ADS_SCOPES,
  exchangeFacebookCode,
  facebookAuthorizeUrl,
  LiveMetaAdsAdapter,
  MockMetaAdsAdapter,
  type MetaAdsAdapter,
} from "../providers/meta/marketing";
import { HIGGSFIELD_MODELS } from "../providers/higgsfield/higgsfield";
import {
  exchangeFacebookPagesCode,
  facebookPageCapabilities,
  facebookPagesAuthorizeUrl,
  FB_PAGE_SCOPES,
  LiveFacebookPageAdapter,
  MockFacebookPageAdapter,
} from "../providers/social/facebook";
import {
  exchangeThreadsCode,
  LiveThreadsAdapter,
  MockThreadsAdapter,
  refreshThreadsToken,
  threadsAuthorizeUrl,
  threadsCapabilities,
  THREADS_SCOPES,
} from "../providers/social/threads";
import {
  exchangeTikTokCode,
  LiveTikTokAdapter,
  MockTikTokAdapter,
  refreshTikTokToken,
  tiktokAuthorizeUrl,
  tiktokCapabilities,
  TIKTOK_SCOPES,
} from "../providers/social/tiktok";
import type { ChannelPublisher, MessagingAdapter, OAuthTokens } from "../providers/social/types";
import {
  exchangeXCode,
  LiveXAdapter,
  MockXAdapter,
  refreshXToken,
  xAuthorizeUrl,
  xCapabilities,
  X_SCOPES,
} from "../providers/social/x";
import { CHANNEL_META, TIKTOK_PRIVACY_LEVELS, type SocialChannel } from "../../lib/channels";
import { enqueue } from "../queue/queue";
import { registerJob } from "../queue/runtime";
import { notify } from "./notifications";

export type AccountRow = typeof s.connectedAccounts.$inferSelect;
export const OAUTH_PROVIDERS = ["instagram", "facebook", "threads", "x", "tiktok", "meta_ads"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export const MOCKABLE_PROVIDERS = OAUTH_PROVIDERS;

/** Whether the server has app credentials for a provider (OAuth cannot start otherwise). */
export function providerConfigured(p: OAuthProvider) {
  if (p === "threads") return integrationsConfigured.threads();
  if (p === "x") return integrationsConfigured.x();
  if (p === "tiktok") return integrationsConfigured.tiktok();
  return integrationsConfigured.meta();
}

const CREDENTIAL_HINT: Record<OAuthProvider, string> = {
  instagram: "META_APP_ID / META_APP_SECRET",
  facebook: "META_APP_ID / META_APP_SECRET",
  meta_ads: "META_APP_ID / META_APP_SECRET",
  threads: "THREADS_APP_ID / THREADS_APP_SECRET",
  x: "X_CLIENT_ID / X_CLIENT_SECRET",
  tiktok: "TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET",
};

export const accountSettingsSchema = z.object({
  commentMonitoring: z.boolean().optional(),
  publicReplySuggestions: z.boolean().optional(),
  privateReplies: z.boolean().optional(),
  dmAutoReplies: z.boolean().optional(),
  automationPaused: z.boolean().optional(),
  pageId: z.string().regex(/^\d+$/).optional(),
  tiktokPrivacy: z.enum(TIKTOK_PRIVACY_LEVELS).optional(),
});

export async function listIntegrations(ctx: Ctx) {
  requirePermission(ctx, "integrations.read");
  const accounts = await ctx.tx
    .select()
    .from(s.connectedAccounts)
    .where(eq(s.connectedAccounts.workspaceId, ctx.workspaceId))
    .orderBy(desc(s.connectedAccounts.createdAt));
  const caps = await ctx.tx
    .select()
    .from(s.providerCapabilities)
    .where(eq(s.providerCapabilities.workspaceId, ctx.workspaceId));
  return {
    providers: {
      instagram: {
        configured: integrationsConfigured.meta(),
        webhooksConfigured: integrationsConfigured.metaWebhooks(),
        scopes: IG_SCOPES,
      },
      facebook: {
        configured: integrationsConfigured.meta(),
        webhooksConfigured: integrationsConfigured.metaWebhooks(),
        scopes: FB_PAGE_SCOPES,
      },
      threads: { configured: integrationsConfigured.threads(), scopes: THREADS_SCOPES },
      x: { configured: integrationsConfigured.x(), scopes: X_SCOPES },
      tiktok: { configured: integrationsConfigured.tiktok(), scopes: TIKTOK_SCOPES },
      meta_ads: {
        configured: integrationsConfigured.meta(),
        testMode: env().META_ADS_TEST_MODE,
        scopes: ADS_SCOPES,
      },
      higgsfield: {
        configured: integrationsConfigured.higgsfield(),
        models: HIGGSFIELD_MODELS.map((m) => ({ id: m.id, label: m.label, kind: m.kind, docs: m.docs })),
      },
      llm: {
        configured: integrationsConfigured.llm(),
        baseUrl: new URL(env().LLM_BASE_URL).origin,
        models: { default: env().LLM_MODEL_DEFAULT, fast: env().LLM_MODEL_FAST },
      },
    },
    mocksAllowed: env().mocksAllowed,
    accounts: accounts.map((a) => ({ ...a, capabilities: caps.filter((c) => c.accountId === a.id) })),
  };
}

export async function getAccount(ctx: Ctx, accountId: string) {
  const rows = await ctx.tx
    .select()
    .from(s.connectedAccounts)
    .where(and(eq(s.connectedAccounts.id, accountId), eq(s.connectedAccounts.workspaceId, ctx.workspaceId)))
    .limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", "Connected account not found");
  return rows[0];
}

export async function capabilityStatus(ctx: Ctx, accountId: string, capability: string) {
  const rows = await ctx.tx
    .select()
    .from(s.providerCapabilities)
    .where(
      and(eq(s.providerCapabilities.accountId, accountId), eq(s.providerCapabilities.capability, capability)),
    )
    .limit(1);
  return rows[0] ?? { status: "unknown", reason: "Capability not discovered yet" };
}

// ───────────────────────────── OAuth ─────────────────────────────

export function redirectUriFor(provider: OAuthProvider) {
  return `${env().APP_URL}/api/v1/integrations/${provider}/callback`;
}

const SAFE_REDIRECT = /^\/(?!\/)[A-Za-z0-9/_?=&.-]*$/;

/** Start OAuth: a single-use, hashed, 10-minute state binds the callback to this user and workspace. */
export async function startOAuth(ctx: Ctx, provider: OAuthProvider, redirectPath = "/integrations") {
  requirePermission(ctx, "integrations.manage");
  const userId = requireUser(ctx);
  if (!providerConfigured(provider)) {
    throw new AppError(
      "INTEGRATION_NOT_CONNECTED",
      `App credentials (${CREDENTIAL_HINT[provider]}) are not configured on the server.`,
    );
  }
  const path = SAFE_REDIRECT.test(redirectPath) ? redirectPath : "/integrations";
  const state = randomToken(32);
  const codeVerifier = provider === "x" ? randomToken(48) : null;
  await withSystem((tx) =>
    tx.insert(s.oauthStates).values({
      id: sha256(state),
      workspaceId: ctx.workspaceId,
      userId,
      provider,
      redirectPath: path,
      encryptedCodeVerifier: codeVerifier ? encryptSecret(codeVerifier) : null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    }),
  );
  await audit(ctx, { action: "integration.oauth_started", targetType: "integration", targetId: provider });
  const uri = redirectUriFor(provider);
  const url =
    provider === "instagram"
      ? instagramAuthorizeUrl(state, uri)
      : provider === "facebook"
        ? facebookPagesAuthorizeUrl(state, uri)
        : provider === "threads"
          ? threadsAuthorizeUrl(state, uri)
          : provider === "x"
            ? xAuthorizeUrl(state, uri, codeVerifier!)
            : provider === "tiktok"
              ? tiktokAuthorizeUrl(state, uri)
              : facebookAuthorizeUrl(state, uri);
  return { url };
}

/** Validate state (exists, unused, unexpired, same provider, same signed-in user) and consume it atomically. */
export async function consumeOAuthState(
  state: string,
  provider: OAuthProvider,
  sessionUserId: string | null,
) {
  return withSystem(async (tx) => {
    const res = await tx
      .update(s.oauthStates)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(s.oauthStates.id, sha256(state)),
          isNull(s.oauthStates.usedAt),
          sql`${s.oauthStates.expiresAt} > now()`,
        ),
      )
      .returning();
    const st = res[0];
    if (!st || st.provider !== provider)
      throw new AppError("FORBIDDEN", "OAuth state is invalid, expired or already used");
    if (!sessionUserId || sessionUserId !== st.userId)
      throw new AppError("FORBIDDEN", "OAuth callback does not match the signed-in user");
    return {
      ...st,
      codeVerifier: st.encryptedCodeVerifier ? decryptSecret(st.encryptedCodeVerifier) : null,
    };
  });
}

export async function completeInstagramOAuth(
  tx: Tx,
  st: { workspaceId: string; userId: string },
  code: string,
  fetchImpl?: typeof fetch,
) {
  const tok = await exchangeInstagramCode(code, redirectUriFor("instagram"), fetchImpl);
  const adapter = new LiveInstagramAdapter(tok.userId || "me", tok.accessToken, fetchImpl);
  const info = await adapter.getAccount();
  const scopes = tok.scopes.length ? tok.scopes : [];
  const account = await upsertAccount(tx, st.workspaceId, st.userId, {
    provider: "instagram",
    mode: "live",
    externalId: info.id,
    displayName: info.name ?? info.username,
    username: info.username,
    grantedScopes: scopes,
    tokenExpiresAt: tok.expiresAt,
    accessToken: tok.accessToken,
  });
  const caps = await new LiveInstagramAdapter(info.id, tok.accessToken, fetchImpl).discoverCapabilities(
    scopes,
    info.accountType,
  );
  await saveCapabilities(tx, st.workspaceId, account.id, caps);
  await writeAudit(tx, {
    workspaceId: st.workspaceId,
    actorType: "user",
    actorId: st.userId,
    action: "integration.connected",
    targetType: "connected_account",
    targetId: account.id,
    provider: "instagram",
    metadata: { scopes, accountType: info.accountType },
  });
  return account;
}

export async function completeMetaAdsOAuth(
  tx: Tx,
  st: { workspaceId: string; userId: string },
  code: string,
  fetchImpl?: typeof fetch,
) {
  const tok = await exchangeFacebookCode(code, redirectUriFor("meta_ads"), fetchImpl);
  const out: AccountRow[] = [];
  for (const acct of tok.adAccounts) {
    const account = await upsertAccount(tx, st.workspaceId, st.userId, {
      provider: "meta_ads",
      mode: "live",
      externalId: acct.id,
      displayName: acct.name,
      username: null,
      grantedScopes: tok.scopes,
      tokenExpiresAt: tok.expiresAt,
      accessToken: tok.accessToken,
      currency: acct.currency,
    });
    await saveCapabilities(tx, st.workspaceId, account.id, adsCapabilities(tok.scopes, acct.account_status));
    out.push(account);
  }
  await writeAudit(tx, {
    workspaceId: st.workspaceId,
    actorType: "user",
    actorId: st.userId,
    action: "integration.connected",
    targetType: "integration",
    targetId: "meta_ads",
    provider: "meta_ads",
    metadata: { adAccounts: out.length, scopes: tok.scopes },
  });
  return out;
}

type OAuthState = { workspaceId: string; userId: string; codeVerifier?: string | null };

/** Dispatch the OAuth callback to the provider-specific completion. */
export async function completeOAuth(
  tx: Tx,
  provider: OAuthProvider,
  st: OAuthState,
  code: string,
  fetchImpl?: typeof fetch,
) {
  if (provider === "instagram") return [await completeInstagramOAuth(tx, st, code, fetchImpl)];
  if (provider === "meta_ads") return completeMetaAdsOAuth(tx, st, code, fetchImpl);
  if (provider === "facebook") return completeFacebookOAuth(tx, st, code, fetchImpl);
  let tokens: OAuthTokens;
  let profile: { id: string; name: string; username?: string | null };
  if (provider === "threads") {
    const r = await exchangeThreadsCode(code, redirectUriFor("threads"), fetchImpl);
    tokens = r.tokens;
    profile = await new LiveThreadsAdapter(r.userId || "me", tokens.accessToken, fetchImpl).getProfile();
  } else if (provider === "x") {
    if (!st.codeVerifier) throw new AppError("FORBIDDEN", "Missing PKCE verifier for X");
    tokens = await exchangeXCode(code, redirectUriFor("x"), st.codeVerifier, fetchImpl);
    profile = await new LiveXAdapter(tokens.accessToken, fetchImpl).getProfile();
  } else {
    const r = await exchangeTikTokCode(code, redirectUriFor("tiktok"), fetchImpl);
    tokens = r.tokens;
    profile = await new LiveTikTokAdapter(r.openId, tokens.accessToken, fetchImpl).getProfile();
    profile.id = r.openId || profile.id;
  }
  const account = await upsertAccount(tx, st.workspaceId, st.userId, {
    provider,
    mode: "live",
    externalId: profile.id,
    displayName: profile.name,
    username: profile.username ?? null,
    grantedScopes: tokens.scopes,
    tokenExpiresAt: tokens.expiresAt,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? null,
  });
  await saveCapabilities(tx, st.workspaceId, account.id, channelCapabilities(provider, tokens.scopes));
  await writeAudit(tx, {
    workspaceId: st.workspaceId,
    actorType: "user",
    actorId: st.userId,
    action: "integration.connected",
    targetType: "connected_account",
    targetId: account.id,
    provider,
    metadata: { scopes: tokens.scopes },
  });
  return [account];
}

export function channelCapabilities(provider: SocialChannel, scopes: string[], tasks?: string[]) {
  if (provider === "instagram") return capabilitiesFromScopes(scopes);
  if (provider === "facebook") return facebookPageCapabilities(scopes, tasks);
  if (provider === "threads") return threadsCapabilities(scopes);
  if (provider === "x") return xCapabilities(scopes);
  return tiktokCapabilities(scopes);
}

/** One connected account per Facebook Page the user manages; each Page is subscribed to webhooks. */
export async function completeFacebookOAuth(tx: Tx, st: OAuthState, code: string, fetchImpl?: typeof fetch) {
  const grant = await exchangeFacebookPagesCode(code, redirectUriFor("facebook"), fetchImpl);
  if (!grant.pages.length)
    throw new ProviderError("permission", "facebook", "No Facebook Pages were shared with the app");
  const out: AccountRow[] = [];
  for (const page of grant.pages) {
    const account = await upsertAccount(tx, st.workspaceId, st.userId, {
      provider: "facebook",
      mode: "live",
      externalId: page.id,
      displayName: page.name,
      username: page.username ?? null,
      grantedScopes: grant.scopes,
      tokenExpiresAt: null,
      accessToken: page.accessToken,
    });
    const caps = facebookPageCapabilities(grant.scopes, page.tasks);
    try {
      await new LiveFacebookPageAdapter(page.id, page.accessToken, fetchImpl).subscribeWebhooks();
      caps.push({ capability: "webhooks", status: "available" });
    } catch (e) {
      caps.push({
        capability: "webhooks",
        status: "unavailable",
        reason: `Page webhook subscription failed: ${isProviderError(e) ? e.publicMessage : "error"}`,
      });
    }
    await saveCapabilities(tx, st.workspaceId, account.id, caps);
    out.push(account);
  }
  await writeAudit(tx, {
    workspaceId: st.workspaceId,
    actorType: "user",
    actorId: st.userId,
    action: "integration.connected",
    targetType: "integration",
    targetId: "facebook",
    provider: "facebook",
    metadata: { pages: out.length, scopes: grant.scopes },
  });
  return out;
}

export function adsCapabilities(scopes: string[], accountStatus: number) {
  const active = accountStatus === 1;
  return [
    {
      capability: "ads_read",
      status: scopes.includes("ads_read") ? "available" : "unavailable",
      reason: scopes.includes("ads_read") ? undefined : "Missing ads_read",
    },
    {
      capability: "ads_manage",
      status: scopes.includes("ads_management") && active ? "available" : "unavailable",
      reason: !scopes.includes("ads_management")
        ? "Missing ads_management"
        : active
          ? undefined
          : `Ad account status: ${ACCOUNT_STATUS[accountStatus] ?? accountStatus}`,
    },
    {
      capability: "ads_activate",
      status: env().META_ADS_TEST_MODE ? "unavailable" : "unknown",
      reason: env().META_ADS_TEST_MODE
        ? "Server is in META_ADS_TEST_MODE: campaigns are created paused"
        : "Requires billing and Meta ad review",
    },
  ] as Array<{ capability: string; status: "available" | "unavailable" | "unknown"; reason?: string }>;
}

async function upsertAccount(
  tx: Tx,
  workspaceId: string,
  userId: string,
  a: {
    provider: string;
    mode: string;
    externalId: string;
    displayName: string;
    username: string | null;
    grantedScopes: string[];
    tokenExpiresAt: Date | null;
    accessToken: string;
    refreshToken?: string | null;
    currency?: string;
  },
) {
  const [account] = await tx
    .insert(s.connectedAccounts)
    .values({
      workspaceId,
      provider: a.provider,
      mode: a.mode,
      externalId: a.externalId,
      displayName: a.displayName,
      username: a.username,
      status: "connected",
      grantedScopes: a.grantedScopes,
      tokenExpiresAt: a.tokenExpiresAt,
      lastHealthCheckAt: new Date(),
      currency: a.currency ?? null,
      createdBy: userId,
      settings: {
        commentMonitoring: true,
        publicReplySuggestions: true,
        privateReplies: true,
        dmAutoReplies: false,
        // TikTok: the safest level until the owner chooses otherwise (unaudited apps can only post privately).
        ...(a.provider === "tiktok" ? { tiktokPrivacy: "SELF_ONLY" } : {}),
      },
    })
    .onConflictDoUpdate({
      target: [s.connectedAccounts.workspaceId, s.connectedAccounts.provider, s.connectedAccounts.externalId],
      set: {
        status: "connected",
        grantedScopes: a.grantedScopes,
        tokenExpiresAt: a.tokenExpiresAt,
        displayName: a.displayName,
        username: a.username,
        healthError: null,
        lastHealthCheckAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();
  await tx
    .update(s.oauthGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(s.oauthGrants.accountId, account!.id), isNull(s.oauthGrants.revokedAt)));
  await tx.insert(s.oauthGrants).values({
    workspaceId,
    accountId: account!.id,
    encryptedAccessToken: encryptSecret(a.accessToken),
    encryptedRefreshToken: a.refreshToken ? encryptSecret(a.refreshToken) : null,
    scopes: a.grantedScopes,
    expiresAt: a.tokenExpiresAt,
  });
  return account!;
}

async function saveCapabilities(
  tx: Tx,
  workspaceId: string,
  accountId: string,
  caps: Array<{ capability: string; status: string; reason?: string }>,
) {
  for (const c of caps) {
    await tx
      .insert(s.providerCapabilities)
      .values({
        workspaceId,
        accountId,
        capability: c.capability,
        status: c.status,
        reason: c.reason ?? null,
        checkedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [s.providerCapabilities.accountId, s.providerCapabilities.capability],
        set: { status: c.status, reason: c.reason ?? null, checkedAt: new Date() },
      });
  }
}

/** Development-only mock account. Refused outside development/test/demo. Always labelled MOCK. */
export async function connectMockAccount(ctx: Ctx, provider: OAuthProvider) {
  requirePermission(ctx, "integrations.manage");
  const userId = requireUser(ctx);
  if (!env().mocksAllowed)
    throw new AppError("FORBIDDEN", "Mock integrations are disabled in this environment");
  const short = ctx.workspaceId.slice(0, 8);
  const label = provider === "meta_ads" ? "Ad Account" : CHANNEL_META[provider].label;
  const scopes: string[] =
    provider === "instagram"
      ? [...IG_SCOPES]
      : provider === "facebook"
        ? [...FB_PAGE_SCOPES]
        : provider === "threads"
          ? [...THREADS_SCOPES]
          : provider === "x"
            ? [...X_SCOPES]
            : provider === "tiktok"
              ? [...TIKTOK_SCOPES]
              : ["ads_management", "ads_read"];
  const externalId =
    provider === "instagram"
      ? `mock_ig_${short}`
      : provider === "meta_ads"
        ? `act_mock_${short}`
        : `mock_${provider}_${short}`;
  const account = await upsertAccount(ctx.tx, ctx.workspaceId, userId, {
    provider,
    mode: "mock",
    externalId,
    displayName: provider === "facebook" ? "Mock Facebook Page (development)" : `Mock ${label} (development)`,
    username: provider === "meta_ads" ? null : provider === "facebook" ? "mockbrand" : "mock_brand",
    grantedScopes: scopes,
    tokenExpiresAt: new Date(Date.now() + 60 * 86400_000),
    accessToken: `mock-token-${randomToken(8)}`,
    currency: provider === "meta_ads" ? "USD" : undefined,
  });
  let caps: Array<{ capability: string; status: string; reason?: string }>;
  if (provider === "instagram")
    caps = await new MockInstagramAdapter(externalId).discoverCapabilities(scopes, "BUSINESS");
  else if (provider === "meta_ads") caps = adsCapabilities(scopes, 1);
  else
    caps = channelCapabilities(provider, scopes).map((c) =>
      c.capability === "messaging" && c.status === "unknown"
        ? { ...c, status: "available" as const, reason: "Mock account: messaging simulated" }
        : c,
    );
  await saveCapabilities(ctx.tx, ctx.workspaceId, account.id, caps);
  await audit(ctx, {
    action: "integration.mock_connected",
    targetType: "connected_account",
    targetId: account.id,
    provider,
    metadata: { mode: "mock" },
  });
  return account;
}

export async function disconnectAccount(ctx: Ctx, accountId: string) {
  requirePermission(ctx, "integrations.manage");
  requireUser(ctx);
  const acct = await getAccount(ctx, accountId);
  await ctx.tx
    .update(s.connectedAccounts)
    .set({ status: "disconnected", updatedAt: new Date() })
    .where(eq(s.connectedAccounts.id, accountId));
  // Token material is destroyed, not just flagged.
  await ctx.tx
    .update(s.oauthGrants)
    .set({ revokedAt: new Date(), encryptedAccessToken: "revoked", encryptedRefreshToken: null })
    .where(eq(s.oauthGrants.accountId, accountId));
  await audit(ctx, {
    action: "integration.disconnected",
    targetType: "connected_account",
    targetId: accountId,
    provider: acct.provider,
  });
}

export async function updateAccountSettings(
  ctx: Ctx,
  accountId: string,
  input: z.infer<typeof accountSettingsSchema>,
) {
  const acct = await getAccount(ctx, accountId);
  const { automationPaused, ...settings } = input;
  if (automationPaused !== undefined) {
    requirePermission(ctx, "automations.manage");
    requireUser(ctx);
  } else {
    requirePermission(ctx, "integrations.manage");
  }
  await ctx.tx
    .update(s.connectedAccounts)
    .set({
      settings: { ...acct.settings, ...settings },
      ...(automationPaused !== undefined ? { automationPaused } : {}),
      updatedAt: new Date(),
    })
    .where(eq(s.connectedAccounts.id, accountId));
  // Visibility is part of what a TikTok publish approval covers: changing it re-opens review.
  if (settings.tiktokPrivacy && settings.tiktokPrivacy !== acct.settings.tiktokPrivacy) {
    const { invalidateApprovalsForSubject } = await import("./approvals");
    const items = await ctx.tx
      .select({ id: s.contentItems.id })
      .from(s.contentItems)
      .where(
        and(
          eq(s.contentItems.workspaceId, ctx.workspaceId),
          eq(s.contentItems.connectedAccountId, accountId),
        ),
      );
    for (const i of items)
      await invalidateApprovalsForSubject(ctx, i.id, "TikTok visibility changed", ["publish_post"]);
  }
  await audit(ctx, {
    action:
      automationPaused === true
        ? "automation.account_paused"
        : automationPaused === false
          ? "automation.account_resumed"
          : "integration.settings_updated",
    targetType: "connected_account",
    targetId: accountId,
    metadata: input,
  });
  return getAccount(ctx, accountId);
}

// ───────────────────────────── Adapters ─────────────────────────────

let igOverride: ((a: AccountRow) => InstagramAdapter) | null = null;
let adsOverride: ((a: AccountRow) => MetaAdsAdapter) | null = null;
export function setAdapterOverridesForTests(o: {
  instagram?: ((a: AccountRow) => InstagramAdapter) | null;
  ads?: ((a: AccountRow) => MetaAdsAdapter) | null;
}) {
  if (o.instagram !== undefined) igOverride = o.instagram;
  if (o.ads !== undefined) adsOverride = o.ads;
}

async function activeGrant(ctx: Ctx, accountId: string) {
  const g = await ctx.tx
    .select()
    .from(s.oauthGrants)
    .where(and(eq(s.oauthGrants.accountId, accountId), isNull(s.oauthGrants.revokedAt)))
    .orderBy(desc(s.oauthGrants.createdAt))
    .limit(1);
  if (!g[0])
    throw new AppError("INTEGRATION_NOT_CONNECTED", "No active credentials for this account. Reconnect it.");
  return g[0];
}

async function accessToken(ctx: Ctx, accountId: string) {
  return decryptSecret((await activeGrant(ctx, accountId)).encryptedAccessToken);
}

/** Replace the active grant with refreshed tokens (old grant revoked, never deleted). */
async function storeRefreshedGrant(
  ctx: Ctx,
  account: AccountRow,
  t: OAuthTokens,
  previousRefresh: string | null,
) {
  await ctx.tx
    .update(s.oauthGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(s.oauthGrants.accountId, account.id), isNull(s.oauthGrants.revokedAt)));
  const refresh = t.refreshToken ?? previousRefresh;
  await ctx.tx.insert(s.oauthGrants).values({
    workspaceId: account.workspaceId,
    accountId: account.id,
    encryptedAccessToken: encryptSecret(t.accessToken),
    encryptedRefreshToken: refresh ? encryptSecret(refresh) : null,
    scopes: account.grantedScopes,
    expiresAt: t.expiresAt,
  });
  await ctx.tx
    .update(s.connectedAccounts)
    .set({ tokenExpiresAt: t.expiresAt, lastHealthCheckAt: new Date(), updatedAt: new Date() })
    .where(eq(s.connectedAccounts.id, account.id));
}

/** Refresh an account's token with the provider's own refresh flow. */
export async function refreshAccountToken(
  ctx: Ctx,
  account: AccountRow,
  opts: { onlyIfExpiringBefore?: Date; fetchImpl?: typeof fetch } = {},
) {
  const fetchImpl = opts.fetchImpl;
  // Serialize refreshes per account: X and TikTok refresh tokens are single-use, so a concurrent
  // second refresh would fail and wrongly mark the account disconnected.
  await ctx.tx.execute(sql`select 1 from connected_accounts where id = ${account.id} for update`);
  const g = await activeGrant(ctx, account.id);
  const token = decryptSecret(g.encryptedAccessToken);
  if (opts.onlyIfExpiringBefore && g.expiresAt && g.expiresAt > opts.onlyIfExpiringBefore) return token;
  const refresh = g.encryptedRefreshToken ? decryptSecret(g.encryptedRefreshToken) : null;
  let t: OAuthTokens;
  if (account.provider === "instagram") {
    const r = await refreshInstagramToken(token, fetchImpl);
    t = { ...r, refreshToken: null, scopes: account.grantedScopes };
  } else if (account.provider === "threads") t = await refreshThreadsToken(token, fetchImpl);
  else if (account.provider === "x" || account.provider === "tiktok") {
    if (!refresh)
      throw new ProviderError("auth", account.provider, "No refresh token: reconnect the account");
    t =
      account.provider === "x"
        ? await refreshXToken(refresh, fetchImpl)
        : await refreshTikTokToken(refresh, fetchImpl);
  } else {
    throw new ProviderError(
      "auth",
      account.provider,
      "This provider's tokens cannot be refreshed: reconnect",
    );
  }
  await storeRefreshedGrant(ctx, account, t, refresh);
  await audit(ctx, {
    action: "integration.token_refreshed",
    targetType: "connected_account",
    targetId: account.id,
    provider: account.provider,
  });
  return t.accessToken;
}

/** Access token for a live call. Short-lived tokens (X: 2h, TikTok: 24h) are refreshed just in time. */
async function liveToken(ctx: Ctx, account: AccountRow) {
  const g = await activeGrant(ctx, account.id);
  const soon = Date.now() + 5 * 60_000;
  if (
    (account.provider === "x" || account.provider === "tiktok") &&
    g.expiresAt &&
    g.expiresAt.getTime() < soon
  )
    return refreshAccountToken(ctx, account, { onlyIfExpiringBefore: new Date(soon) });
  return decryptSecret(g.encryptedAccessToken);
}

let publisherOverride: ((a: AccountRow) => ChannelPublisher | null) | null = null;
export function setPublisherOverrideForTests(fn: ((a: AccountRow) => ChannelPublisher | null) | null) {
  publisherOverride = fn;
}

function assertMockAllowed(account: AccountRow) {
  if (account.mode === "mock" && !env().mocksAllowed)
    throw new AppError("FORBIDDEN", "Mock accounts cannot be used in this environment");
}

/** Publisher for Facebook, Threads, X and TikTok (Instagram keeps its container-specific adapter). */
export async function publisherFor(ctx: Ctx, account: AccountRow): Promise<ChannelPublisher> {
  const o = publisherOverride?.(account);
  if (o) return o;
  assertMockAllowed(account);
  const mock = account.mode === "mock";
  switch (account.provider) {
    case "facebook":
      return mock
        ? new MockFacebookPageAdapter(account.externalId)
        : new LiveFacebookPageAdapter(account.externalId, await liveToken(ctx, account));
    case "threads":
      return mock
        ? new MockThreadsAdapter(account.externalId)
        : new LiveThreadsAdapter(account.externalId, await liveToken(ctx, account));
    case "x":
      return mock ? new MockXAdapter(account.externalId) : new LiveXAdapter(await liveToken(ctx, account));
    case "tiktok":
      return mock
        ? new MockTikTokAdapter(account.externalId)
        : new LiveTikTokAdapter(account.externalId, await liveToken(ctx, account));
    default:
      throw new AppError(
        "VALIDATION_FAILED",
        `${account.provider} accounts cannot publish through this path`,
      );
  }
}

/** Comment and DM replies: Instagram and Facebook Pages. */
export async function messagingAdapter(ctx: Ctx, account: AccountRow): Promise<MessagingAdapter> {
  if (account.provider === "instagram") return instagramAdapter(ctx, account);
  if (account.provider === "facebook") {
    const o = publisherOverride?.(account);
    if (o && "sendMessage" in o) return o as unknown as MessagingAdapter;
    assertMockAllowed(account);
    return account.mode === "mock"
      ? new MockFacebookPageAdapter(account.externalId)
      : new LiveFacebookPageAdapter(account.externalId, await liveToken(ctx, account));
  }
  throw new AppError(
    "VALIDATION_FAILED",
    `${channelLabelSafe(account.provider)} does not support replies here`,
  );
}

function channelLabelSafe(p: string) {
  return p in CHANNEL_META ? CHANNEL_META[p as SocialChannel].label : p;
}

export async function instagramAdapter(ctx: Ctx, account: AccountRow): Promise<InstagramAdapter> {
  if (account.provider !== "instagram") throw new AppError("VALIDATION_FAILED", "Not an Instagram account");
  if (igOverride) return igOverride(account);
  if (account.mode === "mock") {
    if (!env().mocksAllowed)
      throw new AppError("FORBIDDEN", "Mock accounts cannot be used in this environment");
    return new MockInstagramAdapter(account.externalId, account.username ?? "mock_brand");
  }
  return new LiveInstagramAdapter(account.externalId, await accessToken(ctx, account.id));
}

export async function adsAdapter(ctx: Ctx, account: AccountRow): Promise<MetaAdsAdapter> {
  if (account.provider !== "meta_ads") throw new AppError("VALIDATION_FAILED", "Not a Meta ad account");
  if (adsOverride) return adsOverride(account);
  if (account.mode === "mock") {
    if (!env().mocksAllowed)
      throw new AppError("FORBIDDEN", "Mock accounts cannot be used in this environment");
    return new MockMetaAdsAdapter(account.externalId, account.currency ?? "USD");
  }
  return new LiveMetaAdsAdapter(account.externalId, await accessToken(ctx, account.id));
}

/** Apply provider auth/permission errors to account health so the UI shows a disconnected state. */
export async function recordProviderFailure(ctx: Ctx, accountId: string, e: unknown) {
  if (!isProviderError(e)) return;
  if (e.kind === "auth") {
    await ctx.tx
      .update(s.connectedAccounts)
      .set({ status: "token_expired", healthError: e.publicMessage, updatedAt: new Date() })
      .where(eq(s.connectedAccounts.id, accountId));
    await notify(ctx, {
      kind: "token_expired",
      title: "Reconnect your account: access token expired or revoked",
      link: "/integrations",
    });
  } else if (e.kind === "permission") {
    await ctx.tx
      .update(s.connectedAccounts)
      .set({ healthError: e.publicMessage, updatedAt: new Date() })
      .where(eq(s.connectedAccounts.id, accountId));
  }
}

export async function refreshCapabilities(ctx: Ctx, accountId: string) {
  requirePermission(ctx, "integrations.manage");
  const acct = await getAccount(ctx, accountId);
  let caps: Array<{ capability: string; status: string; reason?: string }>;
  try {
    if (acct.provider === "instagram") {
      const ad = await instagramAdapter(ctx, acct);
      const info = await ad.getAccount();
      caps = await ad.discoverCapabilities(acct.grantedScopes, info.accountType);
    } else if (acct.provider in CHANNEL_META) {
      // A profile read proves the token works; capabilities follow from granted scopes.
      await (await publisherFor(ctx, acct)).getProfile();
      const existing = await ctx.tx
        .select()
        .from(s.providerCapabilities)
        .where(eq(s.providerCapabilities.accountId, accountId));
      caps = channelCapabilities(acct.provider as SocialChannel, acct.grantedScopes).map((c) => {
        const prev = existing.find((e) => e.capability === c.capability);
        return acct.mode === "mock" && prev
          ? { ...c, status: prev.status, reason: prev.reason ?? undefined }
          : c;
      });
    } else {
      const ad = await adsAdapter(ctx, acct);
      const info = await ad.getAdAccount();
      caps = adsCapabilities(acct.grantedScopes, info.accountStatus);
    }
  } catch (e) {
    await recordProviderFailure(ctx, accountId, e);
    throw new AppError("PROVIDER_ERROR", isProviderError(e) ? e.publicMessage : "Capability check failed");
  }
  await saveCapabilities(ctx.tx, ctx.workspaceId, accountId, caps);
  await ctx.tx
    .update(s.connectedAccounts)
    .set({ lastHealthCheckAt: new Date(), healthError: null })
    .where(eq(s.connectedAccounts.id, accountId));
  await audit(ctx, {
    action: "integration.capabilities_checked",
    targetType: "connected_account",
    targetId: accountId,
    provider: acct.provider,
  });
  return caps;
}

// ───────────────────────────── Token health job ─────────────────────────────

registerJob("integrations.token_health", {
  async run(jc) {
    const due = await jc.system((tx) =>
      tx
        .select()
        .from(s.connectedAccounts)
        .where(
          and(
            eq(s.connectedAccounts.status, "connected"),
            eq(s.connectedAccounts.mode, "live"),
            lt(s.connectedAccounts.tokenExpiresAt, new Date(Date.now() + 7 * 86400_000)),
          ),
        ),
    );
    let refreshed = 0;
    for (const acct of due) {
      const ctxRun = <T>(fn: (ctx: Ctx) => Promise<T>) =>
        import("../db/tenant").then(({ withTenant }) =>
          withTenant(acct.workspaceId, (tx) =>
            fn({
              workspaceId: acct.workspaceId,
              userId: null,
              role: "admin",
              actorType: "worker",
              actorId: "token_health",
              correlationId: jc.correlationId,
              tx,
              log: jc.log,
            }),
          ),
        );
      try {
        // Meta user/ad tokens cannot be refreshed server-side (the user reconnects); Facebook Page tokens do not expire.
        if (!["instagram", "threads", "x", "tiktok"].includes(acct.provider)) continue;
        // X and TikTok are also refreshed just in time before each call; here only when close to expiry.
        const short = acct.provider === "x" || acct.provider === "tiktok";
        await ctxRun((ctx) =>
          refreshAccountToken(ctx, acct, {
            onlyIfExpiringBefore: new Date(Date.now() + (short ? 2 * 3600_000 : 7 * 86400_000)),
          }),
        );
        refreshed++;
      } catch (e) {
        await ctxRun(async (ctx) => {
          await recordProviderFailure(
            ctx,
            acct.id,
            e instanceof ProviderError ? e : new ProviderError("transient", acct.provider, String(e)),
          );
          await audit(ctx, {
            action: "integration.token_refresh_failed",
            targetType: "connected_account",
            targetId: acct.id,
            result: "failure",
            metadata: { error: String(e) },
          });
        });
      }
    }
    return { checked: due.length, refreshed };
  },
});

export async function scheduleTokenHealth(tx: Tx) {
  const bucket = new Date().toISOString().slice(0, 13);
  await enqueue(tx, {
    type: "integrations.token_health",
    workspaceId: null,
    idempotencyKey: `token_health:${bucket}`,
  });
}

export { capabilitiesFromScopes };
