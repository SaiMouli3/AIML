import { and, asc, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { seq } from "../lib/seq";
import { z } from "zod";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission } from "../context";
import * as s from "../db/schema";
import { env } from "../env";
import { AppError } from "../lib/errors";
import { hashPayload } from "../lib/crypto";
import { evaluateAction } from "../policy/policy";
import { storage } from "../providers/storage/storage";
import { enqueue } from "../queue/queue";
import { registerJob } from "../queue/runtime";
import { RescheduleSignal } from "../queue/signals";
import {
  invalidateApprovalsForSubject,
  loadApprovalForExecution,
  markApprovalExecuted,
  registerApprovalSubject,
} from "./approvals";
import { runBrandCheck, type BrandCheckResult } from "./brand-check";
import { listAllowedDomains, listBrandRules, listProducts } from "./company-brain";
import { runExternalAction } from "./external-actions";
import { capabilityStatus, getAccount, instagramAdapter } from "./integrations";
import { notify } from "./notifications";
import { isValidTimezone } from "./workspace";

export const FORMATS = ["post", "carousel", "story", "reel"] as const;

/**
 * Content lifecycle. The UI shows these as distinct badges so a generated concept is never confused
 * with a scheduled or published post:
 *  concept → draft → in_review → approved → scheduled → publishing → published | failed; archived.
 */
export const CONTENT_STATUSES = [
  "concept",
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "archived",
] as const;

export const versionInputSchema = z.object({
  caption: z.string().max(2200).default(""),
  cta: z.string().max(200).nullable().optional(),
  altText: z.string().max(1000).nullable().optional(),
  hashtags: z
    .array(
      z
        .string()
        .regex(/^[\p{L}\p{N}_]+$/u, "Hashtags may contain letters, numbers and _ only")
        .max(100),
    )
    .max(30)
    .default([]),
  language: z.string().max(20).default("en"),
  targetSegment: z.string().max(300).nullable().optional(),
  mediaAssetIds: z.array(z.uuid()).max(20).default([]),
  brief: z.record(z.string(), z.unknown()).nullable().optional(),
  sourceFactIds: z.array(z.uuid()).max(50).default([]),
  changeNote: z.string().max(300).optional(),
  agentRunId: z.uuid().optional(),
});

export const createContentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  format: z.enum(FORMATS),
  status: z.enum(["concept", "draft"]).default("draft"),
  campaignId: z.uuid().nullable().optional(),
  promotionId: z.uuid().nullable().optional(),
  productIds: z.array(z.uuid()).max(10).default([]),
  connectedAccountId: z.uuid().nullable().optional(),
  scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
  timezone: z.string().refine(isValidTimezone, "Unknown timezone").nullable().optional(),
  version: versionInputSchema.optional(),
});

export const scheduleSchema = z.object({
  connectedAccountId: z.uuid().nullable().optional(),
  scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
  timezone: z.string().refine(isValidTimezone, "Unknown timezone").nullable().optional(),
  campaignId: z.uuid().nullable().optional(),
  promotionId: z.uuid().nullable().optional(),
  productIds: z.array(z.uuid()).max(10).optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

type Item = typeof s.contentItems.$inferSelect;
type Version = typeof s.contentVersions.$inferSelect;

export async function getContent(ctx: Ctx, id: string) {
  requirePermission(ctx, "content.read");
  const rows = await ctx.tx
    .select()
    .from(s.contentItems)
    .where(and(eq(s.contentItems.id, id), eq(s.contentItems.workspaceId, ctx.workspaceId)))
    .limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", "Content not found");
  return rows[0];
}

export async function getVersion(ctx: Ctx, item: Item, version = item.currentVersion): Promise<Version> {
  const rows = await ctx.tx
    .select()
    .from(s.contentVersions)
    .where(
      and(
        eq(s.contentVersions.contentItemId, item.id),
        eq(s.contentVersions.version, version),
        eq(s.contentVersions.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new AppError("NOT_FOUND", "Content version not found");
  return rows[0];
}

async function assertOwned(
  ctx: Ctx,
  table: typeof s.campaigns | typeof s.promotionOffers | typeof s.connectedAccounts,
  id: string | null | undefined,
  what: string,
) {
  if (!id) return;
  const r = await ctx.tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.workspaceId, ctx.workspaceId)))
    .limit(1);
  if (!r[0]) throw new AppError("NOT_FOUND", `${what} not found`);
}

async function assertMedia(ctx: Ctx, ids: string[]) {
  if (!ids.length) return [];
  const rows = await ctx.tx
    .select()
    .from(s.mediaAssets)
    .where(and(inArray(s.mediaAssets.id, ids), eq(s.mediaAssets.workspaceId, ctx.workspaceId)));
  if (rows.length !== new Set(ids).size)
    throw new AppError("NOT_FOUND", "One or more media assets were not found");
  if (rows.some((r) => r.status !== "ready"))
    throw new AppError("VALIDATION_FAILED", "Media assets must be ready (not quarantined or failed)");
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

async function computeBrandCheck(
  ctx: Ctx,
  item: Pick<Item, "format" | "promotionId">,
  v: z.infer<typeof versionInputSchema>,
): Promise<BrandCheckResult> {
  const [rules, domains, products, media] = await seq([
    () => listBrandRules(ctx),
    () => listAllowedDomains(ctx),
    () => listProducts(ctx),
    () => assertMedia(ctx, v.mediaAssetIds),
  ]);
  let promotion = null;
  if (item.promotionId) {
    const p = await ctx.tx
      .select()
      .from(s.promotionOffers)
      .where(
        and(eq(s.promotionOffers.id, item.promotionId), eq(s.promotionOffers.workspaceId, ctx.workspaceId)),
      )
      .limit(1);
    promotion = p[0] ?? null;
  }
  return runBrandCheck({
    caption: v.caption,
    cta: v.cta,
    altText: v.altText,
    hashtags: v.hashtags,
    format: item.format as (typeof FORMATS)[number],
    media: media.map((m) => ({ kind: m.kind, mimeType: m.mimeType, width: m.width, height: m.height })),
    rules,
    allowedDomains: domains,
    products: products.map((p) => ({ name: p.name, priceMinor: p.priceMinor, currency: p.currency })),
    promotion: promotion
      ? {
          discountType: promotion.discountType,
          discountValue: promotion.discountValue,
          endsAt: promotion.endsAt,
        }
      : null,
  });
}

function versionHash(v: z.infer<typeof versionInputSchema>) {
  return hashPayload({
    caption: v.caption,
    cta: v.cta ?? null,
    altText: v.altText ?? null,
    hashtags: v.hashtags,
    language: v.language,
    mediaAssetIds: v.mediaAssetIds,
  });
}

export async function createContent(ctx: Ctx, raw: z.input<typeof createContentSchema>) {
  requirePermission(ctx, "content.write");
  const input = createContentSchema.parse(raw);
  await assertOwned(ctx, s.campaigns, input.campaignId, "Campaign");
  await assertOwned(ctx, s.promotionOffers, input.promotionId, "Promotion");
  await assertOwned(ctx, s.connectedAccounts, input.connectedAccountId, "Account");
  const ws = (
    await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1)
  )[0]!;
  const [item] = await ctx.tx
    .insert(s.contentItems)
    .values({
      workspaceId: ctx.workspaceId,
      title: input.title,
      format: input.format,
      status: input.status,
      campaignId: input.campaignId ?? null,
      promotionId: input.promotionId ?? null,
      productIds: input.productIds,
      connectedAccountId: input.connectedAccountId ?? null,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      timezone: input.timezone ?? ws.timezone,
      currentVersion: 1,
      createdBy: ctx.userId,
    })
    .returning();
  const v = versionInputSchema.parse(input.version ?? {});
  const brandCheck = await computeBrandCheck(ctx, item!, v);
  await ctx.tx.insert(s.contentVersions).values({
    workspaceId: ctx.workspaceId,
    contentItemId: item!.id,
    version: 1,
    ...v,
    brief: v.brief ?? null,
    brandCheck,
    contentHash: versionHash(v),
    createdBy: ctx.userId,
    agentRunId: v.agentRunId ?? null,
    changeNote: v.changeNote ?? "Created",
  });
  await audit(ctx, {
    action: "content.created",
    targetType: "content_item",
    targetId: item!.id,
    metadata: { format: input.format, status: input.status },
  });
  return item!;
}

/**
 * Every edit creates a new immutable version. Material changes invalidate any open approval for the item.
 */
export async function addVersion(ctx: Ctx, id: string, input: z.input<typeof versionInputSchema>) {
  requirePermission(ctx, "content.write");
  const item = await getContent(ctx, id);
  if (["publishing", "published"].includes(item.status))
    throw new AppError("CONFLICT", `Content is ${item.status} and cannot be edited`);
  const v = versionInputSchema.parse(input);
  const prev = await getVersion(ctx, item);
  const hash = versionHash(v);
  if (hash === prev.contentHash && JSON.stringify(v.brief ?? null) === JSON.stringify(prev.brief ?? null))
    return { item, version: prev, invalidated: 0 };
  const brandCheck = await computeBrandCheck(ctx, item, v);
  const next = item.currentVersion + 1;
  const [version] = await ctx.tx
    .insert(s.contentVersions)
    .values({
      workspaceId: ctx.workspaceId,
      contentItemId: id,
      version: next,
      ...v,
      brief: v.brief ?? null,
      brandCheck,
      contentHash: hash,
      createdBy: ctx.userId,
      agentRunId: v.agentRunId ?? null,
      changeNote: v.changeNote ?? null,
    })
    .returning();
  const invalidated = await invalidateApprovalsForSubject(ctx, id, `Edited to version ${next}`, [
    "publish_post",
  ]);
  // Saving an edited version promotes a concept to a draft (it now has real copy to review).
  const status = "draft";
  const [updated] = await ctx.tx
    .update(s.contentItems)
    .set({ currentVersion: next, status, updatedAt: new Date() })
    .where(eq(s.contentItems.id, id))
    .returning();
  await audit(ctx, {
    action: "content.version_created",
    targetType: "content_item",
    targetId: id,
    metadata: { version: next, invalidatedApprovals: invalidated },
  });
  return { item: updated!, version: version!, invalidated };
}

/** Destination/schedule edits are material too: they invalidate approvals. */
export async function updateSchedule(ctx: Ctx, id: string, input: z.infer<typeof scheduleSchema>) {
  requirePermission(ctx, "content.write");
  const item = await getContent(ctx, id);
  if (["publishing", "published"].includes(item.status))
    throw new AppError("CONFLICT", `Content is ${item.status}`);
  await assertOwned(ctx, s.connectedAccounts, input.connectedAccountId, "Account");
  await assertOwned(ctx, s.campaigns, input.campaignId, "Campaign");
  await assertOwned(ctx, s.promotionOffers, input.promotionId, "Promotion");
  const patch: Partial<Item> = {};
  if (input.connectedAccountId !== undefined) patch.connectedAccountId = input.connectedAccountId;
  if (input.scheduledAt !== undefined)
    patch.scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.campaignId !== undefined) patch.campaignId = input.campaignId;
  if (input.promotionId !== undefined) patch.promotionId = input.promotionId;
  if (input.productIds !== undefined) patch.productIds = input.productIds;
  if (input.title !== undefined) patch.title = input.title;
  const material = ["connectedAccountId", "scheduledAt", "timezone", "promotionId"].some((k) => k in patch);
  let invalidated = 0;
  if (material) {
    invalidated = await invalidateApprovalsForSubject(ctx, id, "Destination, schedule or offer changed", [
      "publish_post",
    ]);
    if (["approved", "scheduled", "in_review"].includes(item.status)) patch.status = "draft";
  }
  const [updated] = await ctx.tx
    .update(s.contentItems)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(s.contentItems.id, id))
    .returning();
  await audit(ctx, {
    action: "content.schedule_updated",
    targetType: "content_item",
    targetId: id,
    metadata: { fields: Object.keys(patch), invalidatedApprovals: invalidated },
  });
  return { item: updated!, invalidated };
}

export async function archiveContent(ctx: Ctx, id: string) {
  requirePermission(ctx, "content.write");
  const item = await getContent(ctx, id);
  if (item.status === "publishing") throw new AppError("CONFLICT", "Content is being published");
  await invalidateApprovalsForSubject(ctx, id, "Archived");
  await ctx.tx
    .update(s.contentItems)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(s.contentItems.id, id));
  await audit(ctx, { action: "content.archived", targetType: "content_item", targetId: id });
}

export const listContentQuery = z.object({
  status: z.string().max(40).optional(),
  format: z.enum(FORMATS).optional(),
  campaignId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export async function listContent(ctx: Ctx, q: z.infer<typeof listContentQuery> = {}) {
  requirePermission(ctx, "content.read");
  const conds: SQL[] = [eq(s.contentItems.workspaceId, ctx.workspaceId)];
  if (q.status) conds.push(eq(s.contentItems.status, q.status));
  if (q.format) conds.push(eq(s.contentItems.format, q.format));
  if (q.campaignId) conds.push(eq(s.contentItems.campaignId, q.campaignId));
  if (q.accountId) conds.push(eq(s.contentItems.connectedAccountId, q.accountId));
  if (q.from) conds.push(gte(s.contentItems.scheduledAt, new Date(q.from)));
  if (q.to) conds.push(lte(s.contentItems.scheduledAt, new Date(q.to)));
  const items = await ctx.tx
    .select()
    .from(s.contentItems)
    .where(and(...conds))
    .orderBy(desc(s.contentItems.updatedAt))
    .limit(300);
  if (!items.length) return [];
  const versions = await ctx.tx
    .select()
    .from(s.contentVersions)
    .where(
      and(
        eq(s.contentVersions.workspaceId, ctx.workspaceId),
        inArray(
          s.contentVersions.contentItemId,
          items.map((i) => i.id),
        ),
      ),
    );
  return items.map((i) => ({
    ...i,
    version: versions.find((v) => v.contentItemId === i.id && v.version === i.currentVersion) ?? null,
  }));
}

export async function contentDetail(ctx: Ctx, id: string) {
  const item = await getContent(ctx, id);
  const versions = await ctx.tx
    .select()
    .from(s.contentVersions)
    .where(eq(s.contentVersions.contentItemId, id))
    .orderBy(desc(s.contentVersions.version));
  const current = versions.find((v) => v.version === item.currentVersion)!;
  const media = current.mediaAssetIds.length
    ? await ctx.tx
        .select()
        .from(s.mediaAssets)
        .where(
          and(
            inArray(s.mediaAssets.id, current.mediaAssetIds),
            eq(s.mediaAssets.workspaceId, ctx.workspaceId),
          ),
        )
    : [];
  const mediaWithUrls = await Promise.all(
    media.map(async (m) => ({ ...m, url: await storage().signedUrl(m.storageKey, 900) })),
  );
  const approvals = await ctx.tx
    .select()
    .from(s.approvalRequests)
    .where(and(eq(s.approvalRequests.workspaceId, ctx.workspaceId), eq(s.approvalRequests.subjectId, id)))
    .orderBy(desc(s.approvalRequests.createdAt));
  const actions = await ctx.tx
    .select()
    .from(s.externalActions)
    .where(and(eq(s.externalActions.workspaceId, ctx.workspaceId), eq(s.externalActions.subjectId, id)))
    .orderBy(desc(s.externalActions.createdAt));
  const facts = current.sourceFactIds.length
    ? await ctx.tx
        .select()
        .from(s.companyFacts)
        .where(
          and(
            inArray(s.companyFacts.id, current.sourceFactIds),
            eq(s.companyFacts.workspaceId, ctx.workspaceId),
          ),
        )
    : [];
  const account = item.connectedAccountId
    ? await getAccount(ctx, item.connectedAccountId).catch(() => null)
    : null;
  return { item, current, versions, media: mediaWithUrls, approvals, actions, facts, account };
}

// ───────────────────────────── Publish approval subject ─────────────────────────────

async function buildPublishPayload(ctx: Ctx, id: string) {
  const item = await getContent(ctx, id);
  const v = await getVersion(ctx, item);
  const media = await assertMedia(ctx, v.mediaAssetIds);
  const account = item.connectedAccountId ? await getAccount(ctx, item.connectedAccountId) : null;
  const payload = {
    contentItemId: item.id,
    version: v.version,
    contentHash: v.contentHash,
    format: item.format,
    caption: v.caption,
    altText: v.altText ?? null,
    hashtags: v.hashtags,
    media: media.map((m) => ({ id: m.id, sha256: m.sha256, mimeType: m.mimeType })),
    accountId: account?.id ?? null,
    accountExternalId: account?.externalId ?? null,
    scheduledAt: item.scheduledAt?.toISOString() ?? null,
    timezone: item.timezone ?? null,
    promotionId: item.promotionId ?? null,
  };
  return { item, v, media, account, payload };
}

function fullCaption(caption: string, hashtags: string[]) {
  const tags = hashtags.map((h) => `#${h}`).join(" ");
  return tags ? `${caption}\n\n${tags}` : caption;
}

registerApprovalSubject("publish_post", {
  subjectType: "content_item",
  async build(ctx, id) {
    const { item, v, account, payload } = await buildPublishPayload(ctx, id);
    const check = (v.brandCheck ?? { findings: [] }) as BrandCheckResult;
    return {
      version: v.version,
      executeBy: item.scheduledAt,
      payload,
      summary: {
        title: `${item.format === "reel" ? "Reel" : item.format === "story" ? "Story" : item.format === "carousel" ? "Carousel" : "Post"}: ${item.title}`,
        channel: "Instagram",
        destination: account ? `@${account.username ?? account.displayName}` : "No account selected",
        mode: (account?.mode as "live" | "mock" | undefined) ?? undefined,
        schedule: { at: item.scheduledAt?.toISOString() ?? null, timezone: item.timezone },
        risks: check.findings.filter((f) => f.severity !== "info").map((f) => f.message),
        sideEffects: [
          account?.mode === "mock"
            ? "MOCK account: nothing will be posted to Instagram."
            : "Creates a public Instagram post visible to followers and non-followers.",
          "Counts toward the account's 100 API-published posts per 24 hours.",
        ],
        preview: { text: fullCaption(v.caption, v.hashtags), mediaAssetIds: v.mediaAssetIds },
      },
    };
  },
  async onApproved(ctx, approval) {
    const item = await getContent(ctx, approval.subjectId);
    const at = item.scheduledAt && item.scheduledAt > new Date() ? item.scheduledAt : new Date();
    await ctx.tx
      .update(s.contentItems)
      .set({
        status: item.scheduledAt && item.scheduledAt > new Date() ? "scheduled" : "approved",
        updatedAt: new Date(),
      })
      .where(eq(s.contentItems.id, item.id));
    await enqueue(ctx.tx, {
      type: "content.publish",
      workspaceId: ctx.workspaceId,
      payload: { contentItemId: item.id, approvalId: approval.id },
      runAt: at,
      idempotencyKey: `content.publish:${approval.id}`,
      correlationId: ctx.correlationId,
      maxAttempts: 6,
    });
  },
  async onClosed(ctx, approval, status) {
    const item = await getContent(ctx, approval.subjectId).catch(() => null);
    if (!item || ["published", "publishing", "archived"].includes(item.status)) return;
    if (
      status === "rejected" ||
      status === "changes_requested" ||
      status === "revoked" ||
      status === "invalidated" ||
      status === "expired"
    ) {
      await ctx.tx
        .update(s.contentItems)
        .set({ status: "draft", updatedAt: new Date() })
        .where(eq(s.contentItems.id, item.id));
    }
  },
});

/** "Prepare for approval": validates publishability, then creates a publish approval bound to the exact version. */
export async function requestPublishApproval(ctx: Ctx, id: string) {
  requirePermission(ctx, "approvals.request");
  const { item, v, account, media } = await buildPublishPayload(ctx, id);
  const problems: string[] = [];
  if (!account) problems.push("Select an Instagram account.");
  else if (account.provider !== "instagram") problems.push("Destination must be an Instagram account.");
  else if (account.status !== "connected")
    problems.push(`Account is ${account.status}. Reconnect it in Integrations.`);
  if (item.scheduledAt && item.scheduledAt < new Date(Date.now() - 60_000))
    problems.push("Scheduled time is in the past.");
  const check = v.brandCheck as BrandCheckResult | null;
  if (check?.status === "block")
    problems.push(...check.findings.filter((f) => f.severity === "block").map((f) => f.message));
  if ((item.format === "post" || item.format === "story") && media.length !== 1)
    problems.push(`${item.format === "post" ? "Feed posts" : "Stories"} need exactly one media asset.`);
  if (item.format === "carousel" && (media.length < 2 || media.length > 20))
    problems.push("Carousels need 2–20 media assets.");
  if (item.format === "reel" && (media.length !== 1 || media[0]!.kind !== "video"))
    problems.push("Reels need exactly one video.");
  if (account && account.status === "connected") {
    const capName =
      item.format === "reel"
        ? "publish_reel"
        : item.format === "story"
          ? "publish_story"
          : item.format === "carousel"
            ? "publish_carousel"
            : "publish_image";
    const cap = await capabilityStatus(ctx, account.id, capName);
    if (cap.status !== "available")
      problems.push(`Account cannot ${capName.replace("_", " ")}: ${cap.reason ?? "capability unavailable"}`);
  }
  if (problems.length) throw new AppError("VALIDATION_FAILED", "Content is not ready for approval", problems);
  const { requestApproval } = await import("./approvals");
  const approval = await requestApproval(ctx, { actionType: "publish_post", subjectId: id });
  await ctx.tx
    .update(s.contentItems)
    .set({ status: "in_review", updatedAt: new Date() })
    .where(eq(s.contentItems.id, id));
  return approval;
}

// ───────────────────────────── Publishing job ─────────────────────────────

registerJob("content.publish", {
  external: true,
  uncertainOnCrash: true,
  async run(jc, payload) {
    const contentItemId = String(payload.contentItemId);
    const approvalId = String(payload.approvalId);
    const containerId = payload.containerId as string | undefined;

    const res = await runExternalAction(jc, {
      actionType: "publish_post",
      provider: "instagram",
      accountId: null,
      subjectType: "content_item",
      subjectId: contentItemId,
      idempotencyKey: `publish:${approvalId}`,
      approvalRequestId: approvalId,
      async authorize(ctx) {
        const { approval, currentHash } = await loadApprovalForExecution(ctx, approvalId);
        const { account, item } = await buildPublishPayload(ctx, contentItemId);
        const ws = (
          await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1)
        )[0]!;
        const decision = evaluateAction({
          actionType: "publish_post",
          actorType: "worker",
          workspace: ws,
          accountId: account?.id,
          account: account
            ? { automationPaused: account.automationPaused, status: account.status, mode: account.mode }
            : null,
          currentPayloadHash: currentHash,
          approval,
          mocksAllowed: env().mocksAllowed,
        });
        if (!decision.allowed) throw new AppError("POLICY_BLOCKED", decision.reasons.join(" "));
        if (item.status === "published") throw new AppError("CONFLICT", "Already published");
        const limit = await (await instagramAdapter(ctx, account!)).getPublishingLimit();
        if (limit.used >= limit.total)
          throw new AppError("RATE_LIMITED", "Instagram publishing limit reached for the last 24 hours");
        await ctx.tx
          .update(s.contentItems)
          .set({ status: "publishing", lastError: null, updatedAt: new Date() })
          .where(eq(s.contentItems.id, contentItemId));
        return { payloadHash: currentHash, mode: account!.mode as "live" | "mock" };
      },
      async execute(ctx) {
        const { account, item, v, media } = await buildPublishPayload(ctx, contentItemId);
        const ig = await instagramAdapter(ctx, account!);
        const caption = fullCaption(v.caption, v.hashtags);
        const urls = await Promise.all(media.map((m) => storage().signedUrl(m.storageKey, 3600)));
        let cid = containerId;
        if (!cid) {
          if (item.format === "carousel") {
            const children: string[] = [];
            for (let i = 0; i < media.length; i++) {
              const c = await ig.createContainer({
                kind: media[i]!.kind === "video" ? "carousel_item_video" : "carousel_item_image",
                mediaUrl: urls[i],
                altText: v.altText ?? undefined,
              });
              children.push(c.id);
            }
            cid = (await ig.createContainer({ kind: "carousel", children, caption })).id;
          } else if (item.format === "reel") {
            cid = (await ig.createContainer({ kind: "reel", mediaUrl: urls[0], caption })).id;
          } else if (item.format === "story") {
            cid = (
              await ig.createContainer({
                kind: media[0]!.kind === "video" ? "story_video" : "story_image",
                mediaUrl: urls[0],
              })
            ).id;
          } else {
            cid = (
              await ig.createContainer({
                kind: "image",
                mediaUrl: urls[0],
                caption,
                altText: v.altText ?? undefined,
              })
            ).id;
          }
        }
        const status = await ig.getContainerStatus(cid);
        if (status === "IN_PROGRESS") {
          // Media still processing on Meta's side: check again in a minute (Meta recommends ≤5 minutes of polling).
          const polls = Number(payload.polls ?? 0);
          if (polls >= 10)
            throw new (await import("../providers/errors")).ProviderError(
              "invalid",
              "instagram",
              "Container did not finish processing",
            );
          throw new RescheduleSignal(60_000, { ...payload, containerId: cid, polls: polls + 1 });
        }
        if (status === "ERROR" || status === "EXPIRED") {
          throw new (await import("../providers/errors")).ProviderError(
            "invalid",
            "instagram",
            `Container status ${status}`,
          );
        }
        const published = await ig.publishContainer(cid);
        const media2 = await ig
          .getMedia(published.id)
          .catch(() => ({ id: published.id, permalink: undefined }));
        return {
          providerRef: published.id,
          summary: { permalink: media2.permalink ?? null, containerId: cid, mode: ig.mode },
        };
      },
      async reconcile(ctx) {
        // Ambiguous publish: look for the caption among recent media before ever retrying.
        const { account, v } = await buildPublishPayload(ctx, contentItemId);
        const ig = await instagramAdapter(ctx, account!);
        // Mock accounts have no provider state to inspect: leave the outcome for a human.
        if (ig.mode === "mock") return null;
        const recent = await ig.listRecentMedia(25);
        const caption = fullCaption(v.caption, v.hashtags).trim();
        const hit = recent.find((m) => (m.caption ?? "").trim() === caption);
        return hit
          ? {
              found: true,
              result: {
                providerRef: hit.id,
                summary: { permalink: hit.permalink ?? null, reconciled: true },
              },
            }
          : { found: false };
      },
      async onSuccess(ctx, result, row) {
        await ctx.tx
          .update(s.contentItems)
          .set({
            status: "published",
            publishedMediaId: result.providerRef,
            permalink: (result.summary?.permalink as string | null) ?? null,
            publishedAt: new Date(),
            publishMode: row.mode,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(s.contentItems.id, contentItemId));
        await markApprovalExecuted(ctx, approvalId);
        await notify(ctx, {
          kind: "published",
          title:
            row.mode === "mock"
              ? "Mock publish completed (nothing posted to Instagram)"
              : "Post published to Instagram",
          link: `/content?id=${contentItemId}`,
        });
      },
      async onFailure(ctx, error, final) {
        await ctx.tx
          .update(s.contentItems)
          .set({ status: final ? "failed" : "publishing", lastError: error, updatedAt: new Date() })
          .where(eq(s.contentItems.id, contentItemId));
        if (final)
          await notify(ctx, {
            kind: "publish_failed",
            title: "Publishing failed",
            body: error,
            link: `/content?id=${contentItemId}`,
          });
      },
    });
    return { status: res.status };
  },
});

/** Recover a failed post: return it to draft so it can be fixed and re-approved. */
export async function resetFailedContent(ctx: Ctx, id: string) {
  requirePermission(ctx, "content.write");
  const item = await getContent(ctx, id);
  if (item.status !== "failed") throw new AppError("CONFLICT", "Only failed content can be reset");
  await ctx.tx
    .update(s.contentItems)
    .set({ status: "draft", updatedAt: new Date() })
    .where(eq(s.contentItems.id, id));
  await audit(ctx, { action: "content.reset_after_failure", targetType: "content_item", targetId: id });
}

export async function calendar(ctx: Ctx, fromIso: string, toIso: string) {
  requirePermission(ctx, "content.read");
  const items = await ctx.tx
    .select()
    .from(s.contentItems)
    .where(
      and(
        eq(s.contentItems.workspaceId, ctx.workspaceId),
        gte(s.contentItems.scheduledAt, new Date(fromIso)),
        lte(s.contentItems.scheduledAt, new Date(toIso)),
      ),
    )
    .orderBy(asc(s.contentItems.scheduledAt));
  const promos = await ctx.tx
    .select()
    .from(s.promotionOffers)
    .where(eq(s.promotionOffers.workspaceId, ctx.workspaceId));
  return {
    items,
    promotions: promos.filter(
      (p) => p.startsAt && p.endsAt && p.endsAt >= new Date(fromIso) && p.startsAt <= new Date(toIso),
    ),
  };
}
