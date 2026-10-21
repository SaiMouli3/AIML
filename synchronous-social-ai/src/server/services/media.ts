import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission } from "../context";
import * as s from "../db/schema";
import { env } from "../env";
import { AppError } from "../lib/errors";
import { hashPayload, sha256 } from "../lib/crypto";
import { imageDimensions, malwareScanner, validateUpload } from "../lib/file-validation";
import { newId } from "../lib/ids";
import { isProviderError, ProviderError } from "../providers/errors";
import { HIGGSFIELD_MODELS, mediaProvider, parseStatusPayload, TERMINAL, type MediaProvider } from "../providers/higgsfield/higgsfield";
import { storage, tenantKey } from "../providers/storage/storage";
import { backoffMs, enqueue, PermanentError, RetryableError } from "../queue/queue";
import { registerJob } from "../queue/runtime";
import { RescheduleSignal } from "../queue/signals";
import { notify } from "./notifications";

export const rightsSchema = z.object({
  owner: z.string().max(200).optional(),
  license: z.string().max(200).optional(),
  consent: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});

export async function uploadMedia(ctx: Ctx, file: { name: string; type: string; data: Buffer }, meta: { altText?: string; rights?: z.infer<typeof rightsSchema> } = {}) {
  requirePermission(ctx, "content.write");
  const v = validateUpload(file.data, file.type, "media");
  if (!v.ok) throw new AppError("VALIDATION_FAILED", v.reason ?? "Invalid file");
  const scan = await malwareScanner.scan(file.data);
  if (scan.status === "infected") {
    await audit(ctx, { action: "media.upload_quarantined", targetType: "media_asset", result: "blocked", metadata: { reason: scan.detail } });
    throw new AppError("POLICY_BLOCKED", "File failed malware scanning");
  }
  const id = newId();
  const ext = v.type!.split("/")[1]!.replace("quicktime", "mov").replace("jpeg", "jpg");
  const key = tenantKey(ctx.workspaceId, "media", `${id}.${ext}`);
  await storage().put(key, file.data, v.type!);
  const dims = v.kind === "image" ? imageDimensions(file.data, v.type!) : null;
  const [asset] = await ctx.tx
    .insert(s.mediaAssets)
    .values({
      id,
      workspaceId: ctx.workspaceId,
      kind: v.kind as "image" | "video",
      origin: "upload",
      title: file.name.slice(0, 200),
      mimeType: v.type!,
      sizeBytes: file.data.length,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      storageKey: key,
      sha256: sha256(file.data),
      rights: meta.rights ?? null,
      altText: meta.altText ?? null,
      scanStatus: scan.status,
      createdBy: ctx.userId,
    })
    .returning();
  await audit(ctx, { action: "media.uploaded", targetType: "media_asset", targetId: id, metadata: { mimeType: v.type, size: file.data.length, scan: scan.status } });
  return asset!;
}

export async function listMedia(ctx: Ctx, limit = 100) {
  requirePermission(ctx, "content.read");
  const rows = await ctx.tx
    .select()
    .from(s.mediaAssets)
    .where(and(eq(s.mediaAssets.workspaceId, ctx.workspaceId), isNull(s.mediaAssets.deletedAt)))
    .orderBy(desc(s.mediaAssets.createdAt))
    .limit(limit);
  return Promise.all(rows.map(async (r) => ({ ...r, url: await storage().signedUrl(r.storageKey, 900) })));
}

export async function deleteMedia(ctx: Ctx, id: string) {
  requirePermission(ctx, "content.write");
  const r = await ctx.tx.select().from(s.mediaAssets).where(and(eq(s.mediaAssets.id, id), eq(s.mediaAssets.workspaceId, ctx.workspaceId))).limit(1);
  if (!r[0]) throw new AppError("NOT_FOUND", "Asset not found");
  const inUse = await ctx.tx.execute(sql`select 1 from content_versions cv join content_items ci on ci.id = cv.content_item_id and ci.current_version = cv.version
    where cv.workspace_id = ${ctx.workspaceId} and cv.media_asset_ids ? ${id} and ci.status not in ('archived') limit 1`);
  if (inUse.rows.length) throw new AppError("CONFLICT", "Asset is used by current content. Remove it from the content first.");
  await ctx.tx.update(s.mediaAssets).set({ deletedAt: new Date() }).where(eq(s.mediaAssets.id, id));
  await storage().delete(r[0].storageKey);
  await audit(ctx, { action: "media.deleted", targetType: "media_asset", targetId: id });
}

export async function updateMediaRights(ctx: Ctx, id: string, input: { altText?: string; rights?: z.infer<typeof rightsSchema> }) {
  requirePermission(ctx, "content.write");
  const r = await ctx.tx
    .update(s.mediaAssets)
    .set({ ...(input.altText !== undefined ? { altText: input.altText } : {}), ...(input.rights ? { rights: input.rights } : {}) })
    .where(and(eq(s.mediaAssets.id, id), eq(s.mediaAssets.workspaceId, ctx.workspaceId)))
    .returning();
  if (!r[0]) throw new AppError("NOT_FOUND", "Asset not found");
  await audit(ctx, { action: "media.rights_updated", targetType: "media_asset", targetId: id });
  return r[0];
}

// ───────────────────────────── Generation jobs ─────────────────────────────

export const generationSchema = z.object({
  modelId: z.string().max(80),
  prompt: z.string().trim().min(3).max(1500),
  params: z.record(z.string(), z.unknown()).default({}),
  contentItemId: z.uuid().optional(),
  /** Client-generated key so a double-click or network retry never creates two paid generations. */
  clientRequestId: z.string().min(8).max(100),
});

let providerOverride: MediaProvider | null | undefined;
export function setMediaProviderForTests(p: MediaProvider | null | undefined) {
  providerOverride = p;
}
function provider(): MediaProvider | null {
  return providerOverride !== undefined ? providerOverride : mediaProvider();
}

export function mediaProviderStatus() {
  const p = provider();
  return p ? { connected: true, name: p.name, mode: p.mode } : { connected: false, name: "higgsfield", mode: null, reason: "HIGGSFIELD_API_KEY_ID / HIGGSFIELD_API_KEY_SECRET are not set" };
}

async function monthlyMediaSpend(ctx: Ctx) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const [r] = await ctx.tx
    .select({ c: sql<string>`coalesce(sum(${s.usageEvents.costUsd}), 0)` })
    .from(s.usageEvents)
    .where(and(eq(s.usageEvents.workspaceId, ctx.workspaceId), eq(s.usageEvents.kind, "media_generation"), gte(s.usageEvents.createdAt, start)));
  return Number(r?.c ?? 0);
}

export async function createGeneration(ctx: Ctx, input: z.infer<typeof generationSchema>) {
  requirePermission(ctx, "media.generate");
  const p = provider();
  if (!p) throw new AppError("INTEGRATION_NOT_CONNECTED", "Higgsfield is not connected. Add API credentials on the server to enable generation.");
  const model = HIGGSFIELD_MODELS.find((m) => m.id === input.modelId);
  if (!model) throw new AppError("VALIDATION_FAILED", "Unknown model. Only models from the verified catalog can be used.");
  const params = model.params.parse({ ...model.defaultParams, ...input.params });
  if (input.contentItemId) {
    const c = await ctx.tx.select({ id: s.contentItems.id }).from(s.contentItems).where(and(eq(s.contentItems.id, input.contentItemId), eq(s.contentItems.workspaceId, ctx.workspaceId))).limit(1);
    if (!c[0]) throw new AppError("NOT_FOUND", "Content not found");
  }
  const idempotencyKey = `gen:${ctx.workspaceId}:${sha256(`${input.clientRequestId}:${hashPayload({ m: model.id, p: input.prompt, params })}`).slice(0, 40)}`;
  const existing = await ctx.tx.select().from(s.mediaGenerationJobs).where(eq(s.mediaGenerationJobs.idempotencyKey, idempotencyKey)).limit(1);
  if (existing[0]) return existing[0];

  const estimate = await p.estimate(model, input.prompt, params);
  const ws = (await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1))[0]!;
  const budget = ws.settings.mediaMonthlyBudgetUsd;
  if (budget !== undefined && budget !== null && (await monthlyMediaSpend(ctx)) + (estimate.usd ?? 0) > budget) {
    throw new AppError("BUDGET_EXCEEDED", `Monthly media budget of $${budget} would be exceeded`);
  }
  const [job] = await ctx.tx
    .insert(s.mediaGenerationJobs)
    .values({
      workspaceId: ctx.workspaceId,
      provider: p.name,
      mode: p.mode,
      model: model.id,
      kind: model.kind,
      prompt: input.prompt,
      params,
      status: "queued",
      idempotencyKey,
      estimatedCostUsd: estimate.usd !== null ? String(estimate.usd) : null,
      estimatedCredits: estimate.credits !== null ? String(estimate.credits) : null,
      contentItemId: input.contentItemId ?? null,
      timeoutAt: new Date(Date.now() + (model.kind === "video" ? 30 : 10) * 60_000),
      createdBy: ctx.userId,
      correlationId: ctx.correlationId,
    })
    .returning();
  await enqueue(ctx.tx, { type: "media.generate", workspaceId: ctx.workspaceId, payload: { jobId: job!.id }, idempotencyKey: `media.generate:${job!.id}`, correlationId: ctx.correlationId, maxAttempts: 8 });
  await audit(ctx, { action: "media.generation_requested", targetType: "media_generation_job", targetId: job!.id, provider: p.name, metadata: { model: model.id, mode: p.mode, estimate } });
  return job!;
}

export async function listGenerations(ctx: Ctx, limit = 50) {
  requirePermission(ctx, "content.read");
  return ctx.tx.select().from(s.mediaGenerationJobs).where(eq(s.mediaGenerationJobs.workspaceId, ctx.workspaceId)).orderBy(desc(s.mediaGenerationJobs.createdAt)).limit(limit);
}

export async function getGeneration(ctx: Ctx, id: string) {
  requirePermission(ctx, "content.read");
  const r = await ctx.tx.select().from(s.mediaGenerationJobs).where(and(eq(s.mediaGenerationJobs.id, id), eq(s.mediaGenerationJobs.workspaceId, ctx.workspaceId))).limit(1);
  if (!r[0]) throw new AppError("NOT_FOUND", "Generation not found");
  return r[0];
}

export async function cancelGeneration(ctx: Ctx, id: string) {
  requirePermission(ctx, "media.generate");
  const job = await getGeneration(ctx, id);
  if (TERMINAL.includes(job.status as never) || job.status === "timed_out") throw new AppError("CONFLICT", `Generation is already ${job.status}`);
  if (job.status === "queued" && !job.providerRequestId) {
    await ctx.tx.update(s.mediaGenerationJobs).set({ status: "canceled", updatedAt: new Date(), completedAt: new Date() }).where(eq(s.mediaGenerationJobs.id, id));
    await audit(ctx, { action: "media.generation_canceled", targetType: "media_generation_job", targetId: id });
    return { canceled: true };
  }
  const p = provider();
  if (!p || !job.providerRequestId) throw new AppError("INTEGRATION_NOT_CONNECTED", "Provider unavailable");
  const r = await p.cancel(job.providerRequestId);
  if (r.canceled) {
    await ctx.tx.update(s.mediaGenerationJobs).set({ status: "canceled", updatedAt: new Date(), completedAt: new Date() }).where(eq(s.mediaGenerationJobs.id, id));
  }
  await audit(ctx, { action: r.canceled ? "media.generation_canceled" : "media.generation_cancel_refused", targetType: "media_generation_job", targetId: id, metadata: { reason: r.reason } });
  return r;
}

async function storeOutputs(ctx: Ctx, job: typeof s.mediaGenerationJobs.$inferSelect, p: MediaProvider, outputs: Array<{ url: string; kind: "image" | "video" }>) {
  const ids: string[] = [];
  for (const out of outputs.slice(0, 4)) {
    const { data, contentType } = await p.download(out.url);
    const v = validateUpload(data, contentType, "media");
    if (!v.ok) throw new ProviderError("invalid", p.name, `Provider output failed validation: ${v.reason}`);
    const id = newId();
    const key = tenantKey(ctx.workspaceId, "generated", `${id}.${v.type!.split("/")[1]!.replace("jpeg", "jpg")}`);
    await storage().put(key, data, v.type!);
    const dims = v.kind === "image" ? imageDimensions(data, v.type!) : null;
    await ctx.tx.insert(s.mediaAssets).values({
      id,
      workspaceId: ctx.workspaceId,
      kind: v.kind as "image" | "video",
      origin: p.mode === "mock" ? "mock_generated" : "provider_generated",
      title: p.mode === "mock" ? `MOCK output (${job.model})` : `${job.model} output`,
      mimeType: v.type!,
      sizeBytes: data.length,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      storageKey: key,
      sha256: sha256(data),
      rights: { owner: p.mode === "mock" ? "Mock placeholder" : `Generated via ${p.name}`, license: p.mode === "mock" ? "Not for publication" : "Per provider terms", consent: false },
      generationJobId: job.id,
      createdBy: job.createdBy,
    });
    ids.push(id);
  }
  return ids;
}

/** Apply a terminal provider status (from polling or webhook) exactly once. */
export async function applyGenerationResult(ctx: Ctx, jobId: string, result: { status: string; error?: string | null; outputs: Array<{ url: string; kind: "image" | "video" }> }, p: MediaProvider) {
  const job = (await ctx.tx.select().from(s.mediaGenerationJobs).where(eq(s.mediaGenerationJobs.id, jobId)).for("update").limit(1))[0];
  if (!job || TERMINAL.includes(job.status as never) || job.status === "timed_out") return job;
  if (result.status === "completed") {
    if (!result.outputs.length) {
      await ctx.tx.update(s.mediaGenerationJobs).set({ status: "failed", error: "Provider reported completion without any output", updatedAt: new Date(), completedAt: new Date() }).where(eq(s.mediaGenerationJobs.id, jobId));
      return job;
    }
    const assetIds = await storeOutputs(ctx, job, p, result.outputs);
    await ctx.tx.update(s.mediaGenerationJobs).set({ status: "completed", resultAssetIds: assetIds, error: null, updatedAt: new Date(), completedAt: new Date() }).where(eq(s.mediaGenerationJobs.id, jobId));
    await ctx.tx.insert(s.usageEvents).values({ workspaceId: ctx.workspaceId, kind: "media_generation", provider: p.name, model: job.model, quantity: "1", unit: "generation", costUsd: job.estimatedCostUsd ?? "0", estimated: true });
    await audit(ctx, { action: "media.generation_completed", targetType: "media_generation_job", targetId: jobId, provider: p.name, metadata: { assets: assetIds.length, mode: job.mode } });
    await notify(ctx, { kind: "generation_complete", title: job.mode === "mock" ? "Mock generation complete (placeholder image)" : "Media generation complete", link: "/media" });
  } else {
    const status = result.status === "canceled" ? "canceled" : result.status === "nsfw" ? "nsfw" : "failed";
    const msg = status === "nsfw" ? "Rejected by provider content moderation (not charged)" : status === "failed" ? `Provider reported failure${result.error ? `: ${result.error.slice(0, 200)}` : ""} (not charged)` : "Canceled";
    await ctx.tx.update(s.mediaGenerationJobs).set({ status, error: msg, updatedAt: new Date(), completedAt: new Date() }).where(eq(s.mediaGenerationJobs.id, jobId));
    await audit(ctx, { action: `media.generation_${status}`, targetType: "media_generation_job", targetId: jobId, provider: p.name, result: "failure", metadata: { error: result.error } });
    await notify(ctx, { kind: "generation_failed", title: `Media generation ${status}`, body: msg, link: "/media" });
  }
  return job;
}

registerJob("media.generate", {
  async run(jc, payload) {
    const jobId = String(payload.jobId);
    const p = provider();
    const job = await jc.tenant((ctx) => getGenerationRaw(ctx, jobId));
    if (!job || TERMINAL.includes(job.status as never) || job.status === "timed_out") return { skipped: true };
    if (!p) {
      await jc.tenant((ctx) => ctx.tx.update(s.mediaGenerationJobs).set({ status: "failed", error: "Provider not connected", updatedAt: new Date(), completedAt: new Date() }).where(eq(s.mediaGenerationJobs.id, jobId)));
      return { failed: "not_connected" };
    }
    if (job.timeoutAt && job.timeoutAt < new Date()) {
      await jc.tenant(async (ctx) => {
        await ctx.tx.update(s.mediaGenerationJobs).set({ status: "timed_out", error: "Generation did not finish within the time limit", updatedAt: new Date(), completedAt: new Date() }).where(eq(s.mediaGenerationJobs.id, jobId));
        await audit(ctx, { action: "media.generation_timed_out", targetType: "media_generation_job", targetId: jobId, result: "failure" });
      });
      if (job.providerRequestId) await p.cancel(job.providerRequestId).catch(() => null);
      return { timedOut: true };
    }
    const model = HIGGSFIELD_MODELS.find((m) => m.id === job.model)!;
    try {
      if (!job.providerRequestId) {
        const webhook = env().HIGGSFIELD_WEBHOOK_TOKEN && p.mode === "live" && env().APP_URL.startsWith("https://") ? `${env().APP_URL}/api/v1/webhooks/higgsfield?token=${env().HIGGSFIELD_WEBHOOK_TOKEN}&job=${jobId}` : undefined;
        // Same idempotency key on every attempt: an ambiguous timeout cannot create a second paid request.
        const sub = await p.submit(model, job.prompt, job.params as Record<string, unknown>, job.idempotencyKey, webhook);
        await jc.tenant((ctx) => ctx.tx.update(s.mediaGenerationJobs).set({ providerRequestId: sub.requestId, status: "submitted", updatedAt: new Date() }).where(eq(s.mediaGenerationJobs.id, jobId)));
        throw new RescheduleSignal(2000);
      }
      const st = await p.status(job.providerRequestId);
      if (!TERMINAL.includes(st.status)) {
        await jc.tenant((ctx) =>
          ctx.tx.update(s.mediaGenerationJobs).set({ status: st.status === "queued" ? "submitted" : "in_progress", pollCount: job.pollCount + 1, updatedAt: new Date() }).where(eq(s.mediaGenerationJobs.id, jobId)),
        );
        // Higgsfield guidance: start at 2s, back off to 10s, add jitter.
        throw new RescheduleSignal(Math.min(10_000, 2000 * 1.5 ** job.pollCount) + Math.random() * 500);
      }
      await jc.tenant((ctx) => applyGenerationResult(ctx, jobId, st, p));
      return { status: st.status };
    } catch (e) {
      if (e instanceof RescheduleSignal) throw e;
      if (isProviderError(e)) {
        if (e.retryable || e.kind === "unknown_outcome") throw new RetryableError(e.publicMessage, e.meta.retryAfterMs ?? backoffMs(jc.job.attempts));
        await jc.tenant(async (ctx) => {
          await ctx.tx.update(s.mediaGenerationJobs).set({ status: "failed", error: e.publicMessage, updatedAt: new Date(), completedAt: new Date() }).where(eq(s.mediaGenerationJobs.id, jobId));
          await audit(ctx, { action: "media.generation_failed", targetType: "media_generation_job", targetId: jobId, result: "failure", provider: p.name, metadata: { kind: e.kind, error: e.message } });
        });
        throw new PermanentError(e.publicMessage);
      }
      throw e;
    }
  },
});

async function getGenerationRaw(ctx: Ctx, id: string) {
  return (await ctx.tx.select().from(s.mediaGenerationJobs).where(eq(s.mediaGenerationJobs.id, id)).limit(1))[0];
}

/** Webhook path for Higgsfield terminal events. Deduplicated by request_id + terminal status. */
export async function handleHiggsfieldWebhook(ctx: Ctx, jobId: string, body: unknown) {
  const p = provider();
  if (!p) return { ignored: "provider not configured" };
  const parsed = parseStatusPayload(body);
  const job = await getGenerationRaw(ctx, jobId);
  if (!job) return { ignored: "unknown job" };
  const requestId = (body as { request_id?: string }).request_id;
  if (!requestId || requestId !== job.providerRequestId) return { ignored: "request id mismatch" };
  await applyGenerationResult(ctx, jobId, parsed, p);
  return { applied: parsed.status };
}
