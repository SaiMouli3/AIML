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
import { ACCOUNT_STATUS, ADS_SCOPES, exchangeFacebookCode, facebookAuthorizeUrl, LiveMetaAdsAdapter, MockMetaAdsAdapter, type MetaAdsAdapter } from "../providers/meta/marketing";
import { HIGGSFIELD_MODELS } from "../providers/higgsfield/higgsfield";
import { enqueue } from "../queue/queue";
import { registerJob } from "../queue/runtime";
import { notify } from "./notifications";

export type AccountRow = typeof s.connectedAccounts.$inferSelect;
export type OAuthProvider = "instagram" | "meta_ads";

export const accountSettingsSchema = z.object({
  commentMonitoring: z.boolean().optional(),
  publicReplySuggestions: z.boolean().optional(),
  privateReplies: z.boolean().optional(),
  dmAutoReplies: z.boolean().optional(),
  automationPaused: z.boolean().optional(),
  pageId: z.string().regex(/^\d+$/).optional(),
});

export async function listIntegrations(ctx: Ctx) {
  requirePermission(ctx, "integrations.read");
  const accounts = await ctx.tx.select().from(s.connectedAccounts).where(eq(s.connectedAccounts.workspaceId, ctx.workspaceId)).orderBy(desc(s.connectedAccounts.createdAt));
  const caps = await ctx.tx.select().from(s.providerCapabilities).where(eq(s.providerCapabilities.workspaceId, ctx.workspaceId));
  return {
    providers: {
      instagram: { configured: integrationsConfigured.meta(), webhooksConfigured: integrationsConfigured.metaWebhooks(), scopes: IG_SCOPES },
      meta_ads: { configured: integrationsConfigured.meta(), testMode: env().META_ADS_TEST_MODE, scopes: ADS_SCOPES },
      higgsfield: { configured: integrationsConfigured.higgsfield(), models: HIGGSFIELD_MODELS.map((m) => ({ id: m.id, label: m.label, kind: m.kind, docs: m.docs })) },
      llm: { configured: integrationsConfigured.llm(), baseUrl: new URL(env().LLM_BASE_URL).origin, models: { default: env().LLM_MODEL_DEFAULT, fast: env().LLM_MODEL_FAST } },
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
    .where(and(eq(s.providerCapabilities.accountId, accountId), eq(s.providerCapabilities.capability, capability)))
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
  if (!integrationsConfigured.meta()) {
    throw new AppError("INTEGRATION_NOT_CONNECTED", "Meta app credentials (META_APP_ID / META_APP_SECRET) are not configured on the server.");
  }
  const path = SAFE_REDIRECT.test(redirectPath) ? redirectPath : "/integrations";
  const state = randomToken(32);
  await withSystem((tx) =>
    tx.insert(s.oauthStates).values({ id: sha256(state), workspaceId: ctx.workspaceId, userId, provider, redirectPath: path, expiresAt: new Date(Date.now() + 10 * 60_000) }),
  );
  await audit(ctx, { action: "integration.oauth_started", targetType: "integration", targetId: provider });
  const uri = redirectUriFor(provider);
  return { url: provider === "instagram" ? instagramAuthorizeUrl(state, uri) : facebookAuthorizeUrl(state, uri) };
}

/** Validate state (exists, unused, unexpired, same provider, same signed-in user) and consume it atomically. */
export async function consumeOAuthState(state: string, provider: OAuthProvider, sessionUserId: string | null) {
  return withSystem(async (tx) => {
    const res = await tx
      .update(s.oauthStates)
      .set({ usedAt: new Date() })
      .where(and(eq(s.oauthStates.id, sha256(state)), isNull(s.oauthStates.usedAt), sql`${s.oauthStates.expiresAt} > now()`))
      .returning();
    const st = res[0];
    if (!st || st.provider !== provider) throw new AppError("FORBIDDEN", "OAuth state is invalid, expired or already used");
    if (!sessionUserId || sessionUserId !== st.userId) throw new AppError("FORBIDDEN", "OAuth callback does not match the signed-in user");
    return st;
  });
}

export async function completeInstagramOAuth(tx: Tx, st: { workspaceId: string; userId: string }, code: string, fetchImpl?: typeof fetch) {
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
  const caps = await new LiveInstagramAdapter(info.id, tok.accessToken, fetchImpl).discoverCapabilities(scopes, info.accountType);
  await saveCapabilities(tx, st.workspaceId, account.id, caps);
  await writeAudit(tx, { workspaceId: st.workspaceId, actorType: "user", actorId: st.userId, action: "integration.connected", targetType: "connected_account", targetId: account.id, provider: "instagram", metadata: { scopes, accountType: info.accountType } });
  return account;
}

export async function completeMetaAdsOAuth(tx: Tx, st: { workspaceId: string; userId: string }, code: string, fetchImpl?: typeof fetch) {
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
  await writeAudit(tx, { workspaceId: st.workspaceId, actorType: "user", actorId: st.userId, action: "integration.connected", targetType: "integration", targetId: "meta_ads", provider: "meta_ads", metadata: { adAccounts: out.length, scopes: tok.scopes } });
  return out;
}

export function adsCapabilities(scopes: string[], accountStatus: number) {
  const active = accountStatus === 1;
  return [
    { capability: "ads_read", status: scopes.includes("ads_read") ? "available" : "unavailable", reason: scopes.includes("ads_read") ? undefined : "Missing ads_read" },
    {
      capability: "ads_manage",
      status: scopes.includes("ads_management") && active ? "available" : "unavailable",
      reason: !scopes.includes("ads_management") ? "Missing ads_management" : active ? undefined : `Ad account status: ${ACCOUNT_STATUS[accountStatus] ?? accountStatus}`,
    },
    { capability: "ads_activate", status: env().META_ADS_TEST_MODE ? "unavailable" : "unknown", reason: env().META_ADS_TEST_MODE ? "Server is in META_ADS_TEST_MODE: campaigns are created paused" : "Requires billing and Meta ad review" },
  ] as Array<{ capability: string; status: "available" | "unavailable" | "unknown"; reason?: string }>;
}

async function upsertAccount(
  tx: Tx,
  workspaceId: string,
  userId: string,
  a: { provider: string; mode: string; externalId: string; displayName: string; username: string | null; grantedScopes: string[]; tokenExpiresAt: Date | null; accessToken: string; currency?: string },
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
      settings: { commentMonitoring: true, publicReplySuggestions: true, privateReplies: true, dmAutoReplies: false },
    })
    .onConflictDoUpdate({
      target: [s.connectedAccounts.workspaceId, s.connectedAccounts.provider, s.connectedAccounts.externalId],
      set: { status: "connected", grantedScopes: a.grantedScopes, tokenExpiresAt: a.tokenExpiresAt, displayName: a.displayName, username: a.username, healthError: null, lastHealthCheckAt: new Date(), updatedAt: new Date() },
    })
    .returning();
  await tx.update(s.oauthGrants).set({ revokedAt: new Date() }).where(and(eq(s.oauthGrants.accountId, account!.id), isNull(s.oauthGrants.revokedAt)));
  await tx.insert(s.oauthGrants).values({ workspaceId, accountId: account!.id, encryptedAccessToken: encryptSecret(a.accessToken), scopes: a.grantedScopes, expiresAt: a.tokenExpiresAt });
  return account!;
}

async function saveCapabilities(tx: Tx, workspaceId: string, accountId: string, caps: Array<{ capability: string; status: string; reason?: string }>) {
  for (const c of caps) {
    await tx
      .insert(s.providerCapabilities)
      .values({ workspaceId, accountId, capability: c.capability, status: c.status, reason: c.reason ?? null, checkedAt: new Date() })
      .onConflictDoUpdate({ target: [s.providerCapabilities.accountId, s.providerCapabilities.capability], set: { status: c.status, reason: c.reason ?? null, checkedAt: new Date() } });
  }
}

/** Development-only mock account. Refused outside development/test/demo. Always labelled MOCK. */
export async function connectMockAccount(ctx: Ctx, provider: "instagram" | "meta_ads") {
  requirePermission(ctx, "integrations.manage");
  const userId = requireUser(ctx);
  if (!env().mocksAllowed) throw new AppError("FORBIDDEN", "Mock integrations are disabled in this environment");
  const externalId = provider === "instagram" ? `mock_ig_${ctx.workspaceId.slice(0, 8)}` : `act_mock_${ctx.workspaceId.slice(0, 8)}`;
  const scopes = provider === "instagram" ? [...IG_SCOPES] : ["ads_management", "ads_read"];
  const account = await upsertAccount(ctx.tx, ctx.workspaceId, userId, {
    provider,
    mode: "mock",
    externalId,
    displayName: provider === "instagram" ? "Mock Instagram (development)" : "Mock Ad Account (development)",
    username: provider === "instagram" ? "mock_brand" : null,
    grantedScopes: scopes,
    tokenExpiresAt: new Date(Date.now() + 60 * 86400_000),
    accessToken: `mock-token-${randomToken(8)}`,
    currency: provider === "meta_ads" ? "USD" : undefined,
  });
  const caps = provider === "instagram" ? await new MockInstagramAdapter(externalId).discoverCapabilities(scopes, "BUSINESS") : adsCapabilities(scopes, 1);
  await saveCapabilities(ctx.tx, ctx.workspaceId, account.id, caps);
  await audit(ctx, { action: "integration.mock_connected", targetType: "connected_account", targetId: account.id, provider, metadata: { mode: "mock" } });
  return account;
}

export async function disconnectAccount(ctx: Ctx, accountId: string) {
  requirePermission(ctx, "integrations.manage");
  requireUser(ctx);
  const acct = await getAccount(ctx, accountId);
  await ctx.tx.update(s.connectedAccounts).set({ status: "disconnected", updatedAt: new Date() }).where(eq(s.connectedAccounts.id, accountId));
  // Token material is destroyed, not just flagged.
  await ctx.tx.update(s.oauthGrants).set({ revokedAt: new Date(), encryptedAccessToken: "revoked", encryptedRefreshToken: null }).where(eq(s.oauthGrants.accountId, accountId));
  await audit(ctx, { action: "integration.disconnected", targetType: "connected_account", targetId: accountId, provider: acct.provider });
}

export async function updateAccountSettings(ctx: Ctx, accountId: string, input: z.infer<typeof accountSettingsSchema>) {
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
    .set({ settings: { ...acct.settings, ...settings }, ...(automationPaused !== undefined ? { automationPaused } : {}), updatedAt: new Date() })
    .where(eq(s.connectedAccounts.id, accountId));
  await audit(ctx, {
    action: automationPaused === true ? "automation.account_paused" : automationPaused === false ? "automation.account_resumed" : "integration.settings_updated",
    targetType: "connected_account",
    targetId: accountId,
    metadata: input,
  });
  return getAccount(ctx, accountId);
}

// ───────────────────────────── Adapters ─────────────────────────────

let igOverride: ((a: AccountRow) => InstagramAdapter) | null = null;
let adsOverride: ((a: AccountRow) => MetaAdsAdapter) | null = null;
export function setAdapterOverridesForTests(o: { instagram?: ((a: AccountRow) => InstagramAdapter) | null; ads?: ((a: AccountRow) => MetaAdsAdapter) | null }) {
  if (o.instagram !== undefined) igOverride = o.instagram;
  if (o.ads !== undefined) adsOverride = o.ads;
}

async function accessToken(ctx: Ctx, accountId: string) {
  const g = await ctx.tx
    .select()
    .from(s.oauthGrants)
    .where(and(eq(s.oauthGrants.accountId, accountId), isNull(s.oauthGrants.revokedAt)))
    .orderBy(desc(s.oauthGrants.createdAt))
    .limit(1);
  if (!g[0]) throw new AppError("INTEGRATION_NOT_CONNECTED", "No active credentials for this account. Reconnect it.");
  return decryptSecret(g[0].encryptedAccessToken);
}

export async function instagramAdapter(ctx: Ctx, account: AccountRow): Promise<InstagramAdapter> {
  if (account.provider !== "instagram") throw new AppError("VALIDATION_FAILED", "Not an Instagram account");
  if (igOverride) return igOverride(account);
  if (account.mode === "mock") {
    if (!env().mocksAllowed) throw new AppError("FORBIDDEN", "Mock accounts cannot be used in this environment");
    return new MockInstagramAdapter(account.externalId, account.username ?? "mock_brand");
  }
  return new LiveInstagramAdapter(account.externalId, await accessToken(ctx, account.id));
}

export async function adsAdapter(ctx: Ctx, account: AccountRow): Promise<MetaAdsAdapter> {
  if (account.provider !== "meta_ads") throw new AppError("VALIDATION_FAILED", "Not a Meta ad account");
  if (adsOverride) return adsOverride(account);
  if (account.mode === "mock") {
    if (!env().mocksAllowed) throw new AppError("FORBIDDEN", "Mock accounts cannot be used in this environment");
    return new MockMetaAdsAdapter(account.externalId, account.currency ?? "USD");
  }
  return new LiveMetaAdsAdapter(account.externalId, await accessToken(ctx, account.id));
}

/** Apply provider auth/permission errors to account health so the UI shows a disconnected state. */
export async function recordProviderFailure(ctx: Ctx, accountId: string, e: unknown) {
  if (!isProviderError(e)) return;
  if (e.kind === "auth") {
    await ctx.tx.update(s.connectedAccounts).set({ status: "token_expired", healthError: e.publicMessage, updatedAt: new Date() }).where(eq(s.connectedAccounts.id, accountId));
    await notify(ctx, { kind: "token_expired", title: "Reconnect your account: access token expired or revoked", link: "/integrations" });
  } else if (e.kind === "permission") {
    await ctx.tx.update(s.connectedAccounts).set({ healthError: e.publicMessage, updatedAt: new Date() }).where(eq(s.connectedAccounts.id, accountId));
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
  await ctx.tx.update(s.connectedAccounts).set({ lastHealthCheckAt: new Date(), healthError: null }).where(eq(s.connectedAccounts.id, accountId));
  await audit(ctx, { action: "integration.capabilities_checked", targetType: "connected_account", targetId: accountId, provider: acct.provider });
  return caps;
}

// ───────────────────────────── Token health job ─────────────────────────────

registerJob("integrations.token_health", {
  async run(jc) {
    const due = await jc.system((tx) =>
      tx
        .select()
        .from(s.connectedAccounts)
        .where(and(eq(s.connectedAccounts.status, "connected"), eq(s.connectedAccounts.mode, "live"), lt(s.connectedAccounts.tokenExpiresAt, new Date(Date.now() + 7 * 86400_000)))),
    );
    let refreshed = 0;
    for (const acct of due) {
      const ctxRun = <T>(fn: (ctx: Ctx) => Promise<T>) =>
        import("../db/tenant").then(({ withTenant }) =>
          withTenant(acct.workspaceId, (tx) => fn({ workspaceId: acct.workspaceId, userId: null, role: "admin", actorType: "worker", actorId: "token_health", correlationId: jc.correlationId, tx, log: jc.log })),
        );
      try {
        if (acct.provider !== "instagram") continue; // Facebook long-lived user tokens cannot be refreshed server-side; user must reconnect.
        const token = await ctxRun((ctx) => accessToken(ctx, acct.id));
        const r = await refreshInstagramToken(token);
        await ctxRun(async (ctx) => {
          await ctx.tx.update(s.oauthGrants).set({ revokedAt: new Date() }).where(and(eq(s.oauthGrants.accountId, acct.id), isNull(s.oauthGrants.revokedAt)));
          await ctx.tx.insert(s.oauthGrants).values({ workspaceId: acct.workspaceId, accountId: acct.id, encryptedAccessToken: encryptSecret(r.accessToken), scopes: acct.grantedScopes, expiresAt: r.expiresAt });
          await ctx.tx.update(s.connectedAccounts).set({ tokenExpiresAt: r.expiresAt, lastHealthCheckAt: new Date() }).where(eq(s.connectedAccounts.id, acct.id));
          await audit(ctx, { action: "integration.token_refreshed", targetType: "connected_account", targetId: acct.id, provider: acct.provider });
        });
        refreshed++;
      } catch (e) {
        await ctxRun(async (ctx) => {
          await recordProviderFailure(ctx, acct.id, e instanceof ProviderError ? e : new ProviderError("transient", acct.provider, String(e)));
          await audit(ctx, { action: "integration.token_refresh_failed", targetType: "connected_account", targetId: acct.id, result: "failure", metadata: { error: String(e) } });
        });
      }
    }
    return { checked: due.length, refreshed };
  },
});

export async function scheduleTokenHealth(tx: Tx) {
  const bucket = new Date().toISOString().slice(0, 13);
  await enqueue(tx, { type: "integrations.token_health", workspaceId: null, idempotencyKey: `token_health:${bucket}` });
}

export { capabilitiesFromScopes };
