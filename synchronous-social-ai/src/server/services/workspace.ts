import { and, count, eq, isNull, sql } from "drizzle-orm";
import { seq } from "../lib/seq";
import { z } from "zod";
import { audit, writeAudit } from "../audit/audit";
import { hashPassword, verifyPassword } from "../auth/password";
import type { Ctx } from "../context";
import { requirePermission, requireUser } from "../context";
import { db } from "../db/client";
import { withSystem } from "../db/tenant";
import * as s from "../db/schema";
import { AppError } from "../lib/errors";
import { randomToken, sha256 } from "../lib/crypto";
import { consumeRateLimit } from "../lib/rate-limit";
import { assignableRoles, isRole, type Role } from "../rbac/roles";

export const signupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  password: z.string().min(12, "Use at least 12 characters").max(200),
  workspaceName: z.string().trim().min(2).max(120),
  timezone: z.string().max(64).default("UTC"),
});

export const loginSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(200),
});

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "workspace"
  );
}

export function isValidTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Create a user, their first workspace and owner membership in one system transaction. */
export async function signup(input: z.infer<typeof signupSchema>, meta: { ip?: string | null }) {
  await consumeRateLimit(db(), `signup:${meta.ip ?? "unknown"}`, 10, 3600, { throwOnLimit: true });
  if (!isValidTimezone(input.timezone)) throw new AppError("VALIDATION_FAILED", "Unknown timezone");
  const passwordHash = await hashPassword(input.password);
  return withSystem(async (tx) => {
    const existing = await tx.select({ id: s.users.id }).from(s.users).where(eq(s.users.email, input.email)).limit(1);
    if (existing[0]) throw new AppError("CONFLICT", "An account with this email already exists");
    const [user] = await tx.insert(s.users).values({ email: input.email, name: input.name, passwordHash }).returning();
    const ws = await createWorkspaceTx(tx, user!.id, input.workspaceName, input.timezone);
    await writeAudit(tx, { workspaceId: ws.id, actorType: "user", actorId: user!.id, action: "auth.signup", targetType: "user", targetId: user!.id, ip: meta.ip });
    return { user: user!, workspace: ws };
  });
}

type SysTx = Parameters<Parameters<typeof withSystem>[0]>[0];

export async function createWorkspaceTx(tx: SysTx, userId: string, name: string, timezone = "UTC", isDemo = false) {
  let slug = slugify(name);
  const taken = await tx.select({ id: s.workspaces.id }).from(s.workspaces).where(eq(s.workspaces.slug, slug)).limit(1);
  if (taken[0]) slug = `${slug}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5)}`;
  const [ws] = await tx
    .insert(s.workspaces)
    .values({ name, slug, timezone, isDemo, settings: { approvalExpiryHours: 72, twoPersonApprovalAdBudgetMinor: 100000 } })
    .returning();
  await tx.insert(s.memberships).values({ workspaceId: ws!.id, userId, role: "owner" });
  await tx.insert(s.companyProfiles).values({ workspaceId: ws!.id, data: { name }, completeness: 0, updatedBy: userId });
  return ws!;
}

export async function createAdditionalWorkspace(userId: string, name: string, timezone: string) {
  if (!isValidTimezone(timezone)) throw new AppError("VALIDATION_FAILED", "Unknown timezone");
  return withSystem(async (tx) => {
    const ws = await createWorkspaceTx(tx, userId, name, timezone);
    await writeAudit(tx, { workspaceId: ws.id, actorType: "user", actorId: userId, action: "workspace.created", targetType: "workspace", targetId: ws.id });
    return ws;
  });
}

/** Password login with per-IP and per-account throttling; identical error for unknown email or bad password. */
export async function login(input: z.infer<typeof loginSchema>, meta: { ip?: string | null }) {
  await consumeRateLimit(db(), `login:ip:${meta.ip ?? "unknown"}`, 30, 900, { throwOnLimit: true });
  await consumeRateLimit(db(), `login:email:${sha256(input.email)}`, 10, 900, { throwOnLimit: true });
  const rows = await withSystem((tx) => tx.select().from(s.users).where(eq(s.users.email, input.email)).limit(1));
  const user = rows[0];
  const ok = user && !user.disabledAt ? await verifyPassword(input.password, user.passwordHash) : false;
  if (!user || !ok) {
    if (!user) await hashPassword(input.password); // equalize timing
    throw new AppError("UNAUTHENTICATED", "Invalid email or password");
  }
  return user;
}

// ───────────────────────────── Members & invitations ─────────────────────────────

export async function listMembers(ctx: Ctx) {
  const members = await ctx.tx
    .select({ id: s.memberships.id, userId: s.users.id, name: s.users.name, email: s.users.email, role: s.memberships.role, createdAt: s.memberships.createdAt })
    .from(s.memberships)
    .innerJoin(s.users, eq(s.users.id, s.memberships.userId))
    .where(eq(s.memberships.workspaceId, ctx.workspaceId));
  const invites = await ctx.tx
    .select()
    .from(s.invitations)
    .where(and(eq(s.invitations.workspaceId, ctx.workspaceId), isNull(s.invitations.acceptedAt), isNull(s.invitations.revokedAt)));
  return { members, invites: invites.map(({ tokenHash: _t, ...i }) => i) };
}

export const inviteSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  role: z.string().refine(isRole, "Unknown role"),
});

/** Returns the raw invite token once so it can be shared; only its hash is stored. */
export async function inviteMember(ctx: Ctx, input: z.infer<typeof inviteSchema>) {
  requirePermission(ctx, "members.manage");
  const actorUser = requireUser(ctx);
  if (!assignableRoles(ctx.role).includes(input.role as Role)) throw new AppError("FORBIDDEN", "You cannot grant that role");
  const token = randomToken(24);
  const [inv] = await ctx.tx
    .insert(s.invitations)
    .values({
      workspaceId: ctx.workspaceId,
      email: input.email,
      role: input.role,
      tokenHash: sha256(token),
      invitedBy: actorUser,
      expiresAt: new Date(Date.now() + 7 * 86400_000),
    })
    .returning();
  await audit(ctx, { action: "members.invited", targetType: "invitation", targetId: inv!.id, metadata: { role: input.role } });
  return { invitation: { ...inv!, tokenHash: undefined }, token };
}

export async function revokeInvite(ctx: Ctx, id: string) {
  requirePermission(ctx, "members.manage");
  const res = await ctx.tx
    .update(s.invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(s.invitations.id, id), eq(s.invitations.workspaceId, ctx.workspaceId)))
    .returning();
  if (!res[0]) throw new AppError("NOT_FOUND", "Invitation not found");
  await audit(ctx, { action: "members.invite_revoked", targetType: "invitation", targetId: id });
}

export const acceptInviteSchema = z.object({
  token: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(12).max(200).optional(),
});

/** Accept an invitation. Existing users must already be signed in as the invited email. */
export async function acceptInvite(input: z.infer<typeof acceptInviteSchema>, signedInUserId: string | null) {
  return withSystem(async (tx) => {
    const rows = await tx.select().from(s.invitations).where(eq(s.invitations.tokenHash, sha256(input.token))).limit(1);
    const inv = rows[0];
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) {
      throw new AppError("NOT_FOUND", "Invitation is invalid or expired");
    }
    let userId = signedInUserId;
    const existing = await tx.select().from(s.users).where(eq(s.users.email, inv.email)).limit(1);
    if (existing[0]) {
      if (userId !== existing[0].id) throw new AppError("FORBIDDEN", "Sign in as the invited email address to accept");
    } else {
      if (!input.name || !input.password) throw new AppError("VALIDATION_FAILED", "Name and password are required");
      const [u] = await tx
        .insert(s.users)
        .values({ email: inv.email, name: input.name, passwordHash: await hashPassword(input.password) })
        .returning();
      userId = u!.id;
    }
    await tx.insert(s.memberships).values({ workspaceId: inv.workspaceId, userId: userId!, role: inv.role }).onConflictDoNothing();
    await tx.update(s.invitations).set({ acceptedAt: new Date() }).where(eq(s.invitations.id, inv.id));
    await writeAudit(tx, { workspaceId: inv.workspaceId, actorType: "user", actorId: userId, action: "members.joined", targetType: "user", targetId: userId, metadata: { role: inv.role } });
    return { userId: userId!, workspaceId: inv.workspaceId };
  });
}

export async function changeMemberRole(ctx: Ctx, membershipId: string, role: string) {
  requirePermission(ctx, "members.manage");
  requireUser(ctx);
  if (!isRole(role) || !assignableRoles(ctx.role).includes(role)) throw new AppError("FORBIDDEN", "You cannot grant that role");
  const rows = await ctx.tx
    .select()
    .from(s.memberships)
    .where(and(eq(s.memberships.id, membershipId), eq(s.memberships.workspaceId, ctx.workspaceId)))
    .limit(1);
  const m = rows[0];
  if (!m) throw new AppError("NOT_FOUND", "Member not found");
  if (m.role === "owner" && ctx.role !== "owner") throw new AppError("FORBIDDEN", "Only owners can change an owner");
  if (m.userId === ctx.userId) throw new AppError("FORBIDDEN", "You cannot change your own role");
  if (m.role === "owner" && role !== "owner") await assertAnotherOwner(ctx, m.userId);
  await ctx.tx.update(s.memberships).set({ role }).where(eq(s.memberships.id, membershipId));
  await audit(ctx, { action: "members.role_changed", targetType: "membership", targetId: membershipId, metadata: { from: m.role, to: role } });
}

async function assertAnotherOwner(ctx: Ctx, excludingUserId: string) {
  const [r] = await ctx.tx
    .select({ c: count() })
    .from(s.memberships)
    .where(and(eq(s.memberships.workspaceId, ctx.workspaceId), eq(s.memberships.role, "owner"), sql`${s.memberships.userId} <> ${excludingUserId}`));
  if (!r || r.c === 0) throw new AppError("CONFLICT", "A workspace must keep at least one owner");
}

export async function removeMember(ctx: Ctx, membershipId: string) {
  requirePermission(ctx, "members.manage");
  requireUser(ctx);
  const rows = await ctx.tx
    .select()
    .from(s.memberships)
    .where(and(eq(s.memberships.id, membershipId), eq(s.memberships.workspaceId, ctx.workspaceId)))
    .limit(1);
  const m = rows[0];
  if (!m) throw new AppError("NOT_FOUND", "Member not found");
  if (m.role === "owner") {
    if (ctx.role !== "owner") throw new AppError("FORBIDDEN", "Only owners can remove an owner");
    await assertAnotherOwner(ctx, m.userId);
  }
  await ctx.tx.delete(s.memberships).where(eq(s.memberships.id, membershipId));
  await audit(ctx, { action: "members.removed", targetType: "membership", targetId: membershipId, metadata: { role: m.role } });
}

// ───────────────────────────── Workspace controls ─────────────────────────────

export async function getWorkspace(ctx: Ctx) {
  const rows = await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", "Workspace not found");
  return rows[0];
}

export const settingsSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  timezone: z.string().refine(isValidTimezone, "Unknown timezone").optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  monthlyAdSpendCapMinor: z.number().int().min(0).max(1_000_000_000).optional(),
  settings: z
    .object({
      twoPersonApprovalAdBudgetMinor: z.number().int().min(0).optional(),
      llmMonthlyBudgetUsd: z.number().min(0).max(100000).optional(),
      mediaMonthlyBudgetUsd: z.number().min(0).max(100000).optional(),
      approvalExpiryHours: z.number().int().min(1).max(24 * 30).optional(),
      retentionDays: z.number().int().min(30).max(3650).optional(),
    })
    .optional(),
});

export async function updateSettings(ctx: Ctx, input: z.infer<typeof settingsSchema>) {
  requirePermission(ctx, "workspace.manage");
  requireUser(ctx);
  const ws = await getWorkspace(ctx);
  const next = {
    ...(input.name ? { name: input.name } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.currency ? { currency: input.currency } : {}),
    ...(input.monthlyAdSpendCapMinor !== undefined ? { monthlyAdSpendCapMinor: input.monthlyAdSpendCapMinor } : {}),
    ...(input.settings ? { settings: { ...ws.settings, ...input.settings } } : {}),
  };
  await ctx.tx.update(s.workspaces).set(next).where(eq(s.workspaces.id, ctx.workspaceId));
  await audit(ctx, {
    action: input.monthlyAdSpendCapMinor !== undefined ? "budget.spend_cap_changed" : "workspace.settings_updated",
    targetType: "workspace",
    targetId: ctx.workspaceId,
    metadata: { before: { cap: ws.monthlyAdSpendCapMinor, settings: ws.settings }, after: next },
  });
  return getWorkspace(ctx);
}

export async function setKillSwitch(ctx: Ctx, active: boolean, reason?: string) {
  requirePermission(ctx, "workspace.kill_switch");
  requireUser(ctx);
  await ctx.tx
    .update(s.workspaces)
    .set({ killSwitch: active, killSwitchReason: active ? (reason ?? "Activated") : null, killSwitchAt: active ? new Date() : null })
    .where(eq(s.workspaces.id, ctx.workspaceId));
  await audit(ctx, { action: active ? "operations.kill_switch_on" : "operations.kill_switch_off", targetType: "workspace", targetId: ctx.workspaceId, metadata: { reason } });
}

export async function setAutomationPaused(ctx: Ctx, paused: boolean) {
  requirePermission(ctx, "automations.manage");
  requireUser(ctx);
  await ctx.tx.update(s.workspaces).set({ automationPaused: paused }).where(eq(s.workspaces.id, ctx.workspaceId));
  await audit(ctx, { action: paused ? "automation.workspace_paused" : "automation.workspace_resumed", targetType: "workspace", targetId: ctx.workspaceId });
}

/** Data export: all tenant-owned business records as JSON (secrets and token blobs excluded). */
export async function exportWorkspace(ctx: Ctx) {
  requirePermission(ctx, "workspace.manage");
  const w = ctx.workspaceId;
  const [profile, facts, products, content, versions, approvals, decisions, conversations, messages, campaigns, promotions, ads, rules, auditLog] =
    await seq([
      () => ctx.tx.select().from(s.companyProfiles).where(eq(s.companyProfiles.workspaceId, w)),
      () => ctx.tx.select().from(s.companyFacts).where(eq(s.companyFacts.workspaceId, w)),
      () => ctx.tx.select().from(s.products).where(eq(s.products.workspaceId, w)),
      () => ctx.tx.select().from(s.contentItems).where(eq(s.contentItems.workspaceId, w)),
      () => ctx.tx.select().from(s.contentVersions).where(eq(s.contentVersions.workspaceId, w)),
      () => ctx.tx.select().from(s.approvalRequests).where(eq(s.approvalRequests.workspaceId, w)),
      () => ctx.tx.select().from(s.approvalDecisions).where(eq(s.approvalDecisions.workspaceId, w)),
      () => ctx.tx.select().from(s.inboxConversations).where(eq(s.inboxConversations.workspaceId, w)),
      () => ctx.tx.select().from(s.inboxMessages).where(eq(s.inboxMessages.workspaceId, w)),
      () => ctx.tx.select().from(s.campaigns).where(eq(s.campaigns.workspaceId, w)),
      () => ctx.tx.select().from(s.promotionOffers).where(eq(s.promotionOffers.workspaceId, w)),
      () => ctx.tx.select().from(s.adCampaigns).where(eq(s.adCampaigns.workspaceId, w)),
      () => ctx.tx.select().from(s.automationRules).where(eq(s.automationRules.workspaceId, w)),
      () => ctx.tx.select().from(s.auditEvents).where(eq(s.auditEvents.workspaceId, w)),
    ]);
  await audit(ctx, { action: "workspace.exported", targetType: "workspace", targetId: w });
  return {
    exportedAt: new Date().toISOString(),
    workspaceId: w,
    profile, facts, products, content, versions, approvals, decisions, conversations, messages, campaigns, promotions, ads, rules,
    auditLog,
  };
}

/**
 * Offboarding: hard-delete the workspace and every tenant row (cascade), including object-storage keys
 * via the returned prefix. Requires the owner to type the workspace slug.
 */
export async function deleteWorkspace(ctx: Ctx, confirmSlug: string) {
  if (ctx.role !== "owner") throw new AppError("FORBIDDEN", "Only an owner can delete a workspace");
  requireUser(ctx);
  const ws = await getWorkspace(ctx);
  if (confirmSlug !== ws.slug) throw new AppError("VALIDATION_FAILED", "Confirmation does not match the workspace slug");
  await withSystem(async (tx) => {
    await tx.execute(sql`select set_config('app.audit_purge', 'on', true)`);
    await tx.delete(s.workspaces).where(eq(s.workspaces.id, ws.id));
    await writeAudit(tx, { workspaceId: null, actorType: "user", actorId: ctx.userId, action: "workspace.deleted", targetType: "workspace", targetId: ws.id, correlationId: ctx.correlationId });
  });
  return { storagePrefix: `${ws.id}/` };
}
