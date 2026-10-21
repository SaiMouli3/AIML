import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission } from "../context";
import * as s from "../db/schema";
import { AppError } from "../lib/errors";
import { normalizeDomain } from "../lib/url-safety";
import { detectInjection } from "../lib/injection";

// ───────────────────────────── Company profile ─────────────────────────────

export const companyProfileSchema = z.object({
  name: z.string().trim().max(160).optional(),
  website: z.url().max(500).optional().or(z.literal("")),
  description: z.string().max(4000).optional(),
  industry: z.string().max(120).optional(),
  markets: z.array(z.string().max(120)).max(30).optional(),
  customerSegments: z.array(z.string().max(300)).max(30).optional(),
  objectives: z.array(z.string().max(300)).max(20).optional(),
  differentiators: z.array(z.string().max(300)).max(20).optional(),
  brandVoice: z
    .object({
      tone: z.string().max(500).optional(),
      do: z.array(z.string().max(300)).max(20).optional(),
      dont: z.array(z.string().max(300)).max(20).optional(),
    })
    .optional(),
  visualIdentity: z.string().max(2000).optional(),
  pricingNotes: z.string().max(2000).optional(),
  policies: z.string().max(4000).optional(),
  deliveryRegions: z.array(z.string().max(120)).max(50).optional(),
  escalationContact: z.string().max(200).optional(),
  languages: z.array(z.string().max(20)).max(10).optional(),
});
export type CompanyProfile = z.infer<typeof companyProfileSchema>;

const COMPLETENESS_FIELDS: Array<[keyof CompanyProfile, number]> = [
  ["name", 10],
  ["website", 10],
  ["description", 15],
  ["markets", 10],
  ["customerSegments", 15],
  ["objectives", 10],
  ["differentiators", 10],
  ["brandVoice", 10],
  ["policies", 10],
];

export function profileCompleteness(p: CompanyProfile): { score: number; missing: string[] } {
  let score = 0;
  const missing: string[] = [];
  for (const [k, w] of COMPLETENESS_FIELDS) {
    const v = p[k];
    const filled = Array.isArray(v) ? v.length > 0 : typeof v === "object" && v ? Object.values(v).some((x) => (Array.isArray(x) ? x.length : x)) : Boolean(v);
    if (filled) score += w;
    else missing.push(k);
  }
  return { score, missing };
}

export async function getProfile(ctx: Ctx) {
  requirePermission(ctx, "brain.read");
  const rows = await ctx.tx.select().from(s.companyProfiles).where(eq(s.companyProfiles.workspaceId, ctx.workspaceId)).limit(1);
  const row = rows[0];
  const data = companyProfileSchema.parse(row?.data ?? {});
  return { data, version: row?.version ?? 0, updatedAt: row?.updatedAt ?? null, ...profileCompleteness(data) };
}

export async function updateProfile(ctx: Ctx, patch: CompanyProfile, expectedVersion?: number) {
  requirePermission(ctx, "brain.write");
  const current = await getProfile(ctx);
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw new AppError("CONFLICT", "The profile was changed by someone else. Reload and try again.");
  }
  const data = companyProfileSchema.parse({ ...current.data, ...patch });
  const { score } = profileCompleteness(data);
  await ctx.tx
    .insert(s.companyProfiles)
    .values({ workspaceId: ctx.workspaceId, data, completeness: score, version: 1, updatedBy: ctx.userId })
    .onConflictDoUpdate({
      target: s.companyProfiles.workspaceId,
      set: { data, completeness: score, version: sql`${s.companyProfiles.version} + 1`, updatedBy: ctx.userId, updatedAt: new Date() },
    });
  await audit(ctx, { action: "brain.profile_updated", targetType: "company_profile", targetId: ctx.workspaceId, metadata: { fields: Object.keys(patch) } });
  return getProfile(ctx);
}

// ───────────────────────────── Facts ─────────────────────────────

export const FACT_CATEGORIES = ["product", "pricing", "policy", "audience", "offer", "brand", "faq", "delivery", "other"] as const;

export const factInputSchema = z.object({
  category: z.enum(FACT_CATEGORIES),
  key: z.string().trim().min(1).max(160),
  value: z.string().trim().min(1).max(4000),
  sourceId: z.uuid().optional().nullable(),
  sourceExcerpt: z.string().max(2000).optional().nullable(),
});

const normKey = (k: string) => k.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Add a fact. If an approved/pending fact with the same key has a different value, both are marked as
 * `conflict` — the system never silently chooses between contradictory prices or terms.
 */
export async function addFact(
  ctx: Ctx,
  input: z.infer<typeof factInputSchema>,
  opts: { origin?: "user" | "agent"; confidence?: number; agentRunId?: string; status?: "pending" | "approved" } = {},
) {
  requirePermission(ctx, "brain.write");
  const key = normKey(input.key);
  if (input.sourceId) await assertSource(ctx, input.sourceId);
  const others = await ctx.tx
    .select()
    .from(s.companyFacts)
    .where(and(eq(s.companyFacts.workspaceId, ctx.workspaceId), eq(s.companyFacts.key, key), ne(s.companyFacts.status, "rejected")));
  const conflicting = others.filter((f) => f.value.trim().toLowerCase() !== input.value.trim().toLowerCase());
  const status = conflicting.length ? "conflict" : (opts.status ?? (opts.origin === "agent" ? "pending" : "approved"));
  const [fact] = await ctx.tx
    .insert(s.companyFacts)
    .values({
      workspaceId: ctx.workspaceId,
      category: input.category,
      key,
      value: input.value,
      sourceId: input.sourceId ?? null,
      sourceExcerpt: input.sourceExcerpt ?? null,
      confidence: String(opts.confidence ?? 1),
      status,
      origin: opts.origin ?? "user",
      agentRunId: opts.agentRunId ?? null,
      reviewedBy: opts.origin === "agent" ? null : ctx.userId,
    })
    .returning();
  if (conflicting.length) {
    await ctx.tx
      .update(s.companyFacts)
      .set({ status: "conflict", updatedAt: new Date() })
      .where(inArray(s.companyFacts.id, conflicting.map((c) => c.id)));
  }
  await audit(ctx, { action: "brain.fact_added", targetType: "company_fact", targetId: fact!.id, metadata: { key, status, origin: opts.origin ?? "user" } });
  return fact!;
}

async function assertSource(ctx: Ctx, sourceId: string) {
  const r = await ctx.tx
    .select({ id: s.knowledgeSources.id })
    .from(s.knowledgeSources)
    .where(and(eq(s.knowledgeSources.id, sourceId), eq(s.knowledgeSources.workspaceId, ctx.workspaceId)))
    .limit(1);
  if (!r[0]) throw new AppError("NOT_FOUND", "Source not found");
}

export async function listFacts(ctx: Ctx, opts: { status?: string; category?: string } = {}) {
  requirePermission(ctx, "brain.read");
  const conds = [eq(s.companyFacts.workspaceId, ctx.workspaceId)];
  if (opts.status) conds.push(eq(s.companyFacts.status, opts.status));
  if (opts.category) conds.push(eq(s.companyFacts.category, opts.category));
  return ctx.tx
    .select({ fact: s.companyFacts, sourceTitle: s.knowledgeSources.title })
    .from(s.companyFacts)
    .leftJoin(s.knowledgeSources, eq(s.knowledgeSources.id, s.companyFacts.sourceId))
    .where(and(...conds))
    .orderBy(desc(s.companyFacts.updatedAt));
}

/** Resolve a fact (approve, reject, or correct its value). Resolving a conflict rejects the alternatives. */
export async function reviewFact(ctx: Ctx, id: string, input: { decision: "approve" | "reject"; value?: string }) {
  requirePermission(ctx, "brain.write");
  const rows = await ctx.tx
    .select()
    .from(s.companyFacts)
    .where(and(eq(s.companyFacts.id, id), eq(s.companyFacts.workspaceId, ctx.workspaceId)))
    .limit(1);
  const fact = rows[0];
  if (!fact) throw new AppError("NOT_FOUND", "Fact not found");
  if (input.decision === "reject") {
    await ctx.tx.update(s.companyFacts).set({ status: "rejected", reviewedBy: ctx.userId, updatedAt: new Date() }).where(eq(s.companyFacts.id, id));
  } else {
    await ctx.tx
      .update(s.companyFacts)
      .set({ status: "approved", value: input.value ?? fact.value, reviewedBy: ctx.userId, updatedAt: new Date() })
      .where(eq(s.companyFacts.id, id));
    await ctx.tx
      .update(s.companyFacts)
      .set({ status: "rejected", reviewedBy: ctx.userId, updatedAt: new Date() })
      .where(and(eq(s.companyFacts.workspaceId, ctx.workspaceId), eq(s.companyFacts.key, fact.key), ne(s.companyFacts.id, id), eq(s.companyFacts.status, "conflict")));
  }
  await audit(ctx, { action: `brain.fact_${input.decision}d`, targetType: "company_fact", targetId: id, metadata: { corrected: Boolean(input.value) } });
}

// ───────────────────────────── Brand rules & domains ─────────────────────────────

export const brandRuleSchema = z.object({
  kind: z.enum(["approved_claim", "forbidden_claim", "forbidden_word", "required_disclaimer", "voice"]),
  text: z.string().trim().min(1).max(1000),
});

export async function addBrandRule(ctx: Ctx, input: z.infer<typeof brandRuleSchema>) {
  requirePermission(ctx, "brain.write");
  const [r] = await ctx.tx.insert(s.brandRules).values({ workspaceId: ctx.workspaceId, ...input, createdBy: ctx.userId }).returning();
  await audit(ctx, { action: "brain.brand_rule_added", targetType: "brand_rule", targetId: r!.id, metadata: { kind: input.kind } });
  return r!;
}

export async function removeBrandRule(ctx: Ctx, id: string) {
  requirePermission(ctx, "brain.write");
  const r = await ctx.tx
    .update(s.brandRules)
    .set({ active: false })
    .where(and(eq(s.brandRules.id, id), eq(s.brandRules.workspaceId, ctx.workspaceId)))
    .returning();
  if (!r[0]) throw new AppError("NOT_FOUND", "Rule not found");
  await audit(ctx, { action: "brain.brand_rule_removed", targetType: "brand_rule", targetId: id });
}

export async function listBrandRules(ctx: Ctx) {
  return ctx.tx
    .select()
    .from(s.brandRules)
    .where(and(eq(s.brandRules.workspaceId, ctx.workspaceId), eq(s.brandRules.active, true)))
    .orderBy(desc(s.brandRules.createdAt));
}

export async function listAllowedDomains(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.tx.select({ d: s.allowedDomains.domain }).from(s.allowedDomains).where(eq(s.allowedDomains.workspaceId, ctx.workspaceId));
  return rows.map((r) => r.d);
}

export async function addAllowedDomain(ctx: Ctx, domain: string) {
  requirePermission(ctx, "brain.write");
  const d = normalizeDomain(domain);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new AppError("VALIDATION_FAILED", "Enter a domain such as shop.example.com");
  await ctx.tx.insert(s.allowedDomains).values({ workspaceId: ctx.workspaceId, domain: d, createdBy: ctx.userId }).onConflictDoNothing();
  await audit(ctx, { action: "brain.domain_allowed", targetType: "allowed_domain", targetId: d });
  return d;
}

export async function removeAllowedDomain(ctx: Ctx, domain: string) {
  requirePermission(ctx, "brain.write");
  await ctx.tx.delete(s.allowedDomains).where(and(eq(s.allowedDomains.workspaceId, ctx.workspaceId), eq(s.allowedDomains.domain, normalizeDomain(domain))));
  await audit(ctx, { action: "brain.domain_removed", targetType: "allowed_domain", targetId: domain });
}

// ───────────────────────────── Products (approved catalog) ─────────────────────────────

export const productSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z.string().max(100).optional().nullable(),
  description: z.string().max(4000).optional().nullable(),
  url: z.url().max(1000).optional().nullable(),
  priceMinor: z.number().int().min(0).max(1e10).optional().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional().nullable(),
  variants: z.array(z.string().max(120)).max(50).default([]),
  stockStatus: z.enum(["in_stock", "low", "out_of_stock", "unknown"]).default("unknown"),
  deliveryPolicy: z.string().max(2000).optional().nullable(),
  keywords: z.array(z.string().max(60)).max(30).default([]),
});

export async function upsertProduct(ctx: Ctx, input: z.infer<typeof productSchema>, id?: string) {
  requirePermission(ctx, "brain.write");
  if (input.url) {
    const domains = await listAllowedDomains(ctx);
    const host = new URL(input.url).hostname.replace(/^www\./, "");
    if (!domains.some((d) => host === d || host.endsWith(`.${d}`))) {
      await ctx.tx
        .insert(s.allowedDomains)
        .values({ workspaceId: ctx.workspaceId, domain: host, createdBy: ctx.userId })
        .onConflictDoNothing();
      await audit(ctx, { action: "brain.domain_allowed", targetType: "allowed_domain", targetId: host, metadata: { via: "product_url" } });
    }
  }
  if (id) {
    const r = await ctx.tx
      .update(s.products)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(s.products.id, id), eq(s.products.workspaceId, ctx.workspaceId)))
      .returning();
    if (!r[0]) throw new AppError("NOT_FOUND", "Product not found");
    await audit(ctx, { action: "brain.product_updated", targetType: "product", targetId: id });
    return r[0];
  }
  const [p] = await ctx.tx.insert(s.products).values({ workspaceId: ctx.workspaceId, ...input }).returning();
  await audit(ctx, { action: "brain.product_added", targetType: "product", targetId: p!.id });
  return p!;
}

export async function listProducts(ctx: Ctx) {
  return ctx.tx
    .select()
    .from(s.products)
    .where(and(eq(s.products.workspaceId, ctx.workspaceId), eq(s.products.status, "active")))
    .orderBy(s.products.name);
}

export async function archiveProduct(ctx: Ctx, id: string) {
  requirePermission(ctx, "brain.write");
  const r = await ctx.tx
    .update(s.products)
    .set({ status: "archived", updatedAt: new Date() })
    .where(and(eq(s.products.id, id), eq(s.products.workspaceId, ctx.workspaceId)))
    .returning();
  if (!r[0]) throw new AppError("NOT_FOUND", "Product not found");
  await audit(ctx, { action: "brain.product_archived", targetType: "product", targetId: id });
}

// ───────────────────────────── Knowledge retrieval ─────────────────────────────

export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(clean.length, i + size);
    if (end < clean.length) {
      const para = clean.lastIndexOf("\n\n", end);
      const sentence = clean.lastIndexOf(". ", end);
      const cut = para > i + size / 2 ? para : sentence > i + size / 2 ? sentence + 1 : end;
      end = cut;
    }
    chunks.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return chunks.filter(Boolean);
}

/** Tenant-scoped full-text search with source references. RLS and the explicit filter both apply. */
export async function searchKnowledge(ctx: Ctx, query: string, limit = 8) {
  requirePermission(ctx, "brain.read");
  const q = query.trim().slice(0, 300);
  if (!q) return [];
  const res = await ctx.tx.execute<{
    id: string;
    source_id: string;
    title: string;
    text: string;
    rank: number;
    injection_flag: boolean;
  }>(sql`
    select c.id, c.source_id, s.title, c.text, c.injection_flag,
      ts_rank(c.tsv, websearch_to_tsquery('english', ${q})) as rank
    from knowledge_chunks c join knowledge_sources s on s.id = c.source_id
    where c.workspace_id = ${ctx.workspaceId} and s.deleted_at is null
      and c.tsv @@ websearch_to_tsquery('english', ${q})
    order by rank desc limit ${Math.min(limit, 25)}`);
  return res.rows.map((r) => ({
    chunkId: r.id,
    sourceId: r.source_id,
    sourceTitle: r.title,
    text: r.text,
    rank: Number(r.rank),
    injectionFlag: r.injection_flag,
  }));
}

export async function storeChunks(ctx: Ctx, sourceId: string, text: string) {
  await ctx.tx.delete(s.knowledgeChunks).where(eq(s.knowledgeChunks.sourceId, sourceId));
  const chunks = chunkText(text);
  if (chunks.length) {
    await ctx.tx.insert(s.knowledgeChunks).values(
      chunks.map((c, i) => ({ workspaceId: ctx.workspaceId, sourceId, ordinal: i, text: c, injectionFlag: detectInjection(c).flagged })),
    );
  }
  return chunks.length;
}

export async function listSources(ctx: Ctx) {
  requirePermission(ctx, "brain.read");
  return ctx.tx
    .select()
    .from(s.knowledgeSources)
    .where(and(eq(s.knowledgeSources.workspaceId, ctx.workspaceId), isNull(s.knowledgeSources.deletedAt)))
    .orderBy(desc(s.knowledgeSources.createdAt));
}

/** Grounding bundle for agents: approved facts, brand rules, products and allowed domains. */
export async function groundingBundle(ctx: Ctx) {
  const [profile, facts, rules, catalog, domains] = await Promise.all([
    getProfile(ctx),
    ctx.tx
      .select()
      .from(s.companyFacts)
      .where(and(eq(s.companyFacts.workspaceId, ctx.workspaceId), eq(s.companyFacts.status, "approved"))),
    listBrandRules(ctx),
    listProducts(ctx),
    listAllowedDomains(ctx),
  ]);
  return { profile: profile.data, facts, rules, products: catalog, domains };
}
