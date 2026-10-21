import { and, eq } from "drizzle-orm";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission } from "../context";
import * as s from "../db/schema";
import { AppError } from "../lib/errors";
import { sha256 } from "../lib/crypto";
import { malwareScanner, validateUpload } from "../lib/file-validation";
import { newId } from "../lib/ids";
import { storage, tenantKey } from "../providers/storage/storage";
import { enqueue } from "../queue/queue";
import { registerJob } from "../queue/runtime";
import { storeChunks } from "./company-brain";

/** Upload a knowledge document. Content is validated, scanned, stored, then processed by a durable job. */
export async function uploadKnowledgeSource(ctx: Ctx, file: { name: string; type: string; data: Buffer }) {
  requirePermission(ctx, "brain.write");
  const v = validateUpload(file.data, file.type, "knowledge");
  if (!v.ok) throw new AppError("VALIDATION_FAILED", v.reason ?? "Invalid file");
  const scan = await malwareScanner.scan(file.data);
  const id = newId();
  const key = tenantKey(ctx.workspaceId, "knowledge", `${id}`);
  const quarantined = scan.status === "infected";
  if (!quarantined) await storage().put(key, file.data, v.type!);
  const [src] = await ctx.tx
    .insert(s.knowledgeSources)
    .values({
      id,
      workspaceId: ctx.workspaceId,
      kind: "upload",
      title: file.name.slice(0, 200),
      status: quarantined ? "quarantined" : "uploaded",
      mimeType: v.type!,
      sizeBytes: file.data.length,
      storageKey: quarantined ? null : key,
      sha256: sha256(file.data),
      scanStatus: scan.status,
      error: quarantined ? `Malware scan: ${scan.detail}` : null,
      createdBy: ctx.userId,
    })
    .returning();
  if (!quarantined) {
    await enqueue(ctx.tx, {
      type: "knowledge.process",
      workspaceId: ctx.workspaceId,
      payload: { sourceId: id },
      idempotencyKey: `knowledge.process:${id}`,
      correlationId: ctx.correlationId,
    });
  }
  await audit(ctx, { action: "brain.source_uploaded", targetType: "knowledge_source", targetId: id, result: quarantined ? "blocked" : "success", metadata: { mimeType: v.type, size: file.data.length, scan: scan.status } });
  return src!;
}

/** Manually entered text source (e.g. pasted FAQ). */
export async function addTextSource(ctx: Ctx, title: string, text: string) {
  requirePermission(ctx, "brain.write");
  if (!text.trim()) throw new AppError("VALIDATION_FAILED", "Text is empty");
  const [src] = await ctx.tx
    .insert(s.knowledgeSources)
    .values({ workspaceId: ctx.workspaceId, kind: "manual", title: title.slice(0, 200), status: "processing", mimeType: "text/plain", sizeBytes: Buffer.byteLength(text), sha256: sha256(text), createdBy: ctx.userId })
    .returning();
  await ctx.tx.insert(s.knowledgeDocuments).values({ workspaceId: ctx.workspaceId, sourceId: src!.id, text });
  const n = await storeChunks(ctx, src!.id, text);
  await ctx.tx.update(s.knowledgeSources).set({ status: "ready", chunkCount: n }).where(eq(s.knowledgeSources.id, src!.id));
  await audit(ctx, { action: "brain.source_added", targetType: "knowledge_source", targetId: src!.id });
  return { ...src!, status: "ready", chunkCount: n };
}

export async function deleteSource(ctx: Ctx, id: string) {
  requirePermission(ctx, "brain.write");
  const rows = await ctx.tx
    .select()
    .from(s.knowledgeSources)
    .where(and(eq(s.knowledgeSources.id, id), eq(s.knowledgeSources.workspaceId, ctx.workspaceId)))
    .limit(1);
  const src = rows[0];
  if (!src) throw new AppError("NOT_FOUND", "Source not found");
  await ctx.tx.delete(s.knowledgeChunks).where(eq(s.knowledgeChunks.sourceId, id));
  await ctx.tx.delete(s.knowledgeDocuments).where(eq(s.knowledgeDocuments.sourceId, id));
  await ctx.tx.update(s.knowledgeSources).set({ deletedAt: new Date(), status: "deleted" }).where(eq(s.knowledgeSources.id, id));
  if (src.storageKey) await storage().delete(src.storageKey);
  await audit(ctx, { action: "brain.source_deleted", targetType: "knowledge_source", targetId: id });
}

export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export async function extractText(data: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await pdfText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : text;
  }
  const raw = data.toString("utf8");
  return mimeType === "text/html" ? htmlToText(raw) : raw;
}

registerJob("knowledge.process", {
  async run(jc, payload) {
    const sourceId = String(payload.sourceId);
    const src = await jc.tenant(async (ctx) => {
      const r = await ctx.tx.select().from(s.knowledgeSources).where(eq(s.knowledgeSources.id, sourceId)).limit(1);
      if (r[0]) await ctx.tx.update(s.knowledgeSources).set({ status: "processing" }).where(eq(s.knowledgeSources.id, sourceId));
      return r[0];
    });
    if (!src || !src.storageKey || src.deletedAt) return { skipped: true };
    let text: string;
    try {
      text = await extractText(await storage().get(src.storageKey), src.mimeType ?? "text/plain");
    } catch (e) {
      await jc.tenant((ctx) =>
        ctx.tx.update(s.knowledgeSources).set({ status: "failed", error: `Text extraction failed: ${(e as Error).message.slice(0, 200)}` }).where(eq(s.knowledgeSources.id, sourceId)),
      );
      return { failed: true };
    }
    return jc.tenant(async (ctx) => {
      if (!text.trim()) {
        await ctx.tx.update(s.knowledgeSources).set({ status: "unsupported", error: "No extractable text (scanned PDF?). Paste the text instead." }).where(eq(s.knowledgeSources.id, sourceId));
        return { chunks: 0 };
      }
      await ctx.tx.insert(s.knowledgeDocuments).values({ workspaceId: ctx.workspaceId, sourceId, text });
      const n = await storeChunks(ctx, sourceId, text);
      await ctx.tx.update(s.knowledgeSources).set({ status: "ready", chunkCount: n, error: null }).where(eq(s.knowledgeSources.id, sourceId));
      await audit(ctx, { action: "brain.source_processed", targetType: "knowledge_source", targetId: sourceId, metadata: { chunks: n } });
      return { chunks: n };
    });
  },
});
