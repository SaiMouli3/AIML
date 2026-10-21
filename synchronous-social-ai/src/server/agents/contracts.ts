import { z } from "zod";
import type { LlmMessage } from "../providers/llm/llm";
import { quoteUntrusted, UNTRUSTED_DATA_POLICY } from "../lib/injection";

/**
 * Specialist agent contracts. Agents are workflow roles, not autonomous processes: each run gathers
 * Tier-0 grounding, makes a bounded number of structured model calls, and returns a validated draft.
 * No contract lists a Tier 3/4 tool; external actions always go through approvals + the policy engine.
 */

export const AGENT_ROLES = [
  "marketing_strategist",
  "company_knowledge",
  "audience_research",
  "content_copywriter",
  "creative_director",
  "media_producer",
  "community_manager",
  "ads_strategist",
  "ads_operator",
  "analytics_analyst",
  "compliance_reviewer",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface Grounding {
  company: { name?: string; description?: string; brandVoice?: { tone?: string; do?: string[]; dont?: string[] }; customerSegments?: string[]; objectives?: string[]; markets?: string[] };
  facts: Array<{ id: string; category: string; key: string; value: string }>;
  products: Array<{ id: string; name: string; url: string | null; priceMinor: number | null; currency: string | null; stockStatus: string; variants: string[]; deliveryPolicy: string | null; keywords: string[] }>;
  rules: Array<{ kind: string; text: string }>;
  domains: string[];
  snippets: Array<{ sourceId: string; sourceTitle: string; text: string; injectionFlag: boolean }>;
  promotion?: Record<string, unknown> | null;
  metrics?: Record<string, unknown> | null;
}

export interface AgentContract<I = unknown, O = unknown> {
  role: AgentRole;
  title: string;
  purpose: string;
  nonGoals: string[];
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  allowedTools: string[];
  disallowedActions: string[];
  sourceRequirements: string;
  minConfidence: number;
  model: "default" | "fast" | "none";
  timeoutMs: number;
  maxRetries: number;
  maxSteps: number;
  maxTokens: number;
  budgetUsdPerRun: number;
  escalation: string[];
  /** Search query for knowledge retrieval (Tier 0) built from the input. */
  retrievalQuery?(input: I): string | null;
  buildPrompt?(input: I, g: Grounding): LlmMessage[];
  mock(input: I, g: Grounding): O;
  postValidate?(output: O, input: I, g: Grounding): { output: O; escalate: boolean; reasons: string[] };
}

const conf = z.number().min(0).max(1);
const factIds = z.array(z.string()).max(50).default([]);

const COMMON_DISALLOWED = [
  "publish or schedule public content",
  "send any message or reply",
  "launch, resume or change ads or budgets",
  "approve requests or change permissions",
  "invent prices, discounts, testimonials, statistics or product features",
];

function groundingText(g: Grounding, opts: { products?: boolean; snippets?: boolean; promotion?: boolean } = {}) {
  const parts: string[] = [];
  parts.push(`COMPANY PROFILE (approved): ${JSON.stringify(g.company)}`);
  parts.push(`APPROVED FACTS (cite by id): ${JSON.stringify(g.facts.slice(0, 60).map((f) => ({ id: f.id, key: f.key, value: f.value, category: f.category })))}`);
  parts.push(`BRAND RULES: ${JSON.stringify(g.rules)}`);
  parts.push(`APPROVED LINK DOMAINS: ${JSON.stringify(g.domains)}`);
  if (opts.products !== false) parts.push(`APPROVED PRODUCT CATALOG: ${JSON.stringify(g.products.slice(0, 50))}`);
  if (opts.promotion && g.promotion) parts.push(`APPROVED PROMOTION TERMS (must be copied exactly): ${JSON.stringify(g.promotion)}`);
  if (opts.snippets !== false && g.snippets.length) {
    parts.push("RETRIEVED DOCUMENT EXCERPTS:");
    for (const s of g.snippets.slice(0, 6)) parts.push(quoteUntrusted(`document:${s.sourceTitle}`, s.text, 1500));
  }
  return parts.join("\n\n");
}

function system(role: string, task: string) {
  return (
    `You are the ${role} on a governed marketing team. ${task}\n` +
    `Rules: use only the approved facts, catalog and promotion terms provided; if information is missing, list it in the output instead of guessing. ` +
    `Never fabricate testimonials, statistics, prices, discounts, scarcity or guarantees. Label hypotheses as hypotheses. ` +
    `${UNTRUSTED_DATA_POLICY} Respond with JSON matching the schema.`
  );
}

const MOCK = "[Mock draft — LLM not configured]";

// ───────────────────────────── 1. Marketing strategist ─────────────────────────────

export const strategistInput = z.object({ goal: z.string().min(3).max(2000), horizonDays: z.number().int().min(7).max(90).default(30) });
export const strategistOutput = z.object({
  summary: z.string().max(2000),
  pillars: z.array(z.object({ name: z.string().max(80), description: z.string().max(500) })).min(1).max(6),
  calendar: z
    .array(z.object({ dayOffset: z.number().int().min(0).max(90), format: z.enum(["post", "carousel", "story", "reel"]), topic: z.string().max(200), pillar: z.string().max(80) }))
    .max(40),
  goals: z.array(z.string().max(300)).max(10),
  assumptions: z.array(z.string().max(300)).max(10),
  risks: z.array(z.string().max(300)).max(10),
  missingInformation: z.array(z.string().max(300)).max(10).default([]),
  sourceFactIds: factIds,
  confidence: conf,
});

const marketingStrategist: AgentContract<z.infer<typeof strategistInput>, z.infer<typeof strategistOutput>> = {
  role: "marketing_strategist",
  title: "Marketing strategist",
  purpose: "Turns business goals into positioning, content pillars and a dated content calendar with assumptions and risks.",
  nonGoals: ["Writing final captions", "Predicting guaranteed results", "Scheduling or publishing"],
  inputSchema: strategistInput,
  outputSchema: strategistOutput,
  allowedTools: ["read_company_facts", "search_knowledge", "read_products", "read_analytics"],
  disallowedActions: COMMON_DISALLOWED,
  sourceRequirements: "Cite approved fact ids for every claim about the business; separate assumptions.",
  minConfidence: 0.4,
  model: "default",
  timeoutMs: 90_000,
  maxRetries: 1,
  maxSteps: 3,
  maxTokens: 4000,
  budgetUsdPerRun: 0.25,
  escalation: ["Company profile is less than 40% complete", "Confidence below 0.4", "Goals conflict with forbidden claims"],
  retrievalQuery: (i) => i.goal,
  buildPrompt: (i, g) => [
    { role: "system", content: system("marketing strategist", `Create a ${i.horizonDays}-day Instagram plan.`) },
    { role: "user", content: `${groundingText(g)}\n\nGOAL (from the workspace user): ${quoteUntrusted("user_goal", i.goal)}` },
  ],
  mock: (i, g) => ({
    summary: `${MOCK} ${i.horizonDays}-day plan for “${i.goal.slice(0, 120)}” based on ${g.facts.length} approved facts and ${g.products.length} products.`,
    pillars: [
      { name: "Product education", description: "Explain what the products do using approved facts only." },
      { name: "Customer proof", description: "Only use testimonials that have documented permission." },
      { name: "Behind the brand", description: "Process, team and values content." },
    ],
    calendar: Array.from({ length: Math.min(8, Math.ceil(i.horizonDays / 4)) }, (_, k) => ({
      dayOffset: k * 4,
      format: (["post", "carousel", "reel", "story"] as const)[k % 4]!,
      topic: g.products[k % Math.max(1, g.products.length)]?.name ?? `Brand story ${k + 1}`,
      pillar: ["Product education", "Customer proof", "Behind the brand"][k % 3]!,
    })),
    goals: [i.goal.slice(0, 300)],
    assumptions: ["Posting cadence of ~2 per week is sustainable (assumption)."],
    risks: g.facts.length === 0 ? ["No approved facts yet: content will be generic until the Company Brain is filled in."] : [],
    missingInformation: g.facts.length === 0 ? ["Approved product facts"] : [],
    sourceFactIds: g.facts.slice(0, 5).map((f) => f.id),
    confidence: g.facts.length ? 0.6 : 0.3,
  }),
  postValidate: (o, _i, g) => {
    const known = new Set(g.facts.map((f) => f.id));
    const output = { ...o, sourceFactIds: o.sourceFactIds.filter((id) => known.has(id)) };
    const reasons: string[] = [];
    if (o.confidence < 0.4) reasons.push("Low confidence plan");
    if (o.missingInformation.length) reasons.push(`Missing information: ${o.missingInformation.join("; ")}`);
    return { output, escalate: reasons.length > 0, reasons };
  },
};

// ───────────────────────────── 2. Company knowledge ─────────────────────────────

export const knowledgeInput = z.object({ sourceId: z.uuid(), maxFacts: z.number().int().min(1).max(60).default(30) });
export const knowledgeOutput = z.object({
  facts: z
    .array(
      z.object({
        category: z.enum(["product", "pricing", "policy", "audience", "offer", "brand", "faq", "delivery", "other"]),
        key: z.string().min(1).max(160),
        value: z.string().min(1).max(2000),
        excerpt: z.string().max(600),
        confidence: conf,
      }),
    )
    .max(60),
  injectionDetected: z.boolean(),
  notes: z.array(z.string().max(300)).max(10).default([]),
});

const companyKnowledge: AgentContract<z.infer<typeof knowledgeInput>, z.infer<typeof knowledgeOutput>> = {
  role: "company_knowledge",
  title: "Company knowledge",
  purpose: "Extracts tenant-specific facts (products, prices, policies, FAQs, offer terms) from authorized sources with excerpts and confidence.",
  nonGoals: ["Choosing between conflicting facts", "Browsing the web", "Using other tenants' data"],
  inputSchema: knowledgeInput,
  outputSchema: knowledgeOutput,
  allowedTools: ["read_source_text", "add_pending_fact"],
  disallowedActions: [...COMMON_DISALLOWED, "approve facts (facts are created as pending for human review)"],
  sourceRequirements: "Every fact must include a verbatim excerpt from the source.",
  minConfidence: 0.5,
  model: "default",
  timeoutMs: 120_000,
  maxRetries: 1,
  maxSteps: 3,
  maxTokens: 6000,
  budgetUsdPerRun: 0.5,
  escalation: ["Conflicting facts", "Prompt-injection text in the document", "Excerpt not found in source"],
  buildPrompt: (i, g) => [
    { role: "system", content: system("company knowledge analyst", `Extract up to ${i.maxFacts} factual statements about this business from the document. Include a short verbatim excerpt for each.`) },
    { role: "user", content: g.snippets.map((s) => quoteUntrusted(`document:${s.sourceTitle}`, s.text, 4000)).join("\n") },
  ],
  mock: (_i, g) => {
    const text = g.snippets.map((s) => s.text).join("\n");
    const facts: z.infer<typeof knowledgeOutput>["facts"] = [];
    for (const line of text.split(/\n+/)) {
      const m = line.match(/^\s*([A-Za-z][\w\s/&-]{1,60}):\s*(.{2,300})$/);
      if (m) facts.push({ category: /price|cost/i.test(m[1]!) ? "pricing" : /deliver|ship/i.test(m[1]!) ? "delivery" : /return|refund|policy/i.test(m[1]!) ? "policy" : "other", key: m[1]!.trim(), value: m[2]!.trim(), excerpt: line.trim().slice(0, 300), confidence: 0.6 });
      if (facts.length >= 30) break;
    }
    return { facts, injectionDetected: g.snippets.some((s) => s.injectionFlag), notes: [MOCK] };
  },
  postValidate: (o, _i, g) => {
    const corpus = g.snippets.map((s) => s.text.toLowerCase().replace(/\s+/g, " ")).join(" ");
    const kept = o.facts.filter((f) => f.confidence >= 0.3 && corpus.includes(f.excerpt.toLowerCase().replace(/\s+/g, " ").slice(0, 40)));
    const dropped = o.facts.length - kept.length;
    const reasons: string[] = [];
    if (dropped) reasons.push(`${dropped} extracted facts were dropped because their excerpt was not found in the source.`);
    const injection = o.injectionDetected || g.snippets.some((s) => s.injectionFlag);
    if (injection) reasons.push("Document contains instruction-like text; it was treated as data only.");
    return { output: { ...o, facts: kept, injectionDetected: injection }, escalate: reasons.length > 0, reasons };
  },
};

// ───────────────────────────── 3. Audience research ─────────────────────────────

export const SENSITIVE_TERMS = [/health|medical|disease|illness|pregnan|disab|diabet|cancer|depress|anxiety|hiv|aids\b|addict|weight loss|mental/i, /relig|church|mosque|temple/i, /politic|party|election/i, /sexual|gay|lesbian|lgbt/i, /ethnic|race|racial/i, /debt|bankrupt|low income|financial hardship/i, /criminal|arrest/i, /union member/i];

export const audienceInput = z.object({ objective: z.string().min(3).max(1000), productIds: z.array(z.uuid()).max(20).default([]) });
export const audienceOutput = z.object({
  hypotheses: z
    .array(
      z.object({
        name: z.string().max(100),
        description: z.string().max(600),
        rationale: z.string().max(600),
        targeting: z.object({
          countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(25),
          ageMin: z.number().int().min(18).max(65),
          ageMax: z.number().int().min(18).max(65),
          interests: z.array(z.string().max(80)).max(15),
        }),
        confidence: conf,
      }),
    )
    .min(1)
    .max(5),
  excludedSensitive: z.array(z.string()).default([]),
  caveats: z.array(z.string().max(300)).max(10),
});

const audienceResearch: AgentContract<z.infer<typeof audienceInput>, z.infer<typeof audienceOutput>> = {
  role: "audience_research",
  title: "Audience research",
  purpose: "Proposes audience hypotheses from first-party data and permitted Meta targeting options, with rationale.",
  nonGoals: ["Inferring sensitive personal attributes", "Promising exact or perfect targeting", "Using scraped data"],
  inputSchema: audienceInput,
  outputSchema: audienceOutput,
  allowedTools: ["read_company_facts", "read_products", "read_analytics"],
  disallowedActions: [...COMMON_DISALLOWED, "target or infer sensitive characteristics (health, religion, politics, sexuality, ethnicity, financial hardship)"],
  sourceRequirements: "Rationale must reference approved segments, facts or measured metrics; otherwise label as hypothesis.",
  minConfidence: 0.3,
  model: "default",
  timeoutMs: 90_000,
  maxRetries: 1,
  maxSteps: 3,
  maxTokens: 3000,
  budgetUsdPerRun: 0.2,
  escalation: ["Sensitive interest suggested and removed", "No first-party segment data"],
  retrievalQuery: (i) => i.objective,
  buildPrompt: (i, g) => [
    { role: "system", content: system("audience researcher", "Propose 2–4 audience hypotheses using only broad, permitted targeting (countries, age 18–65, general interests). Never use sensitive characteristics.") },
    { role: "user", content: `${groundingText(g)}\n\nOBJECTIVE: ${quoteUntrusted("user_objective", i.objective)}` },
  ],
  mock: (_i, g) => ({
    hypotheses: [
      {
        name: "Existing segment (hypothesis)",
        description: g.company.customerSegments?.[0] ?? "Adults interested in the product category",
        rationale: g.company.customerSegments?.length ? "From the approved company profile segments." : "No first-party data yet; broad hypothesis.",
        targeting: { countries: ["US"], ageMin: 25, ageMax: 54, interests: g.products.slice(0, 3).flatMap((p) => p.keywords.slice(0, 2)) },
        confidence: g.company.customerSegments?.length ? 0.5 : 0.3,
      },
    ],
    excludedSensitive: [],
    caveats: [MOCK, "Audience hypotheses must be validated with measured results; no targeting is exact."],
  }),
  postValidate: (o) => {
    const excluded: string[] = [];
    const hypotheses = o.hypotheses.map((h) => {
      const interests = h.targeting.interests.filter((t) => {
        const bad = SENSITIVE_TERMS.some((re) => re.test(t));
        if (bad) excluded.push(t);
        return !bad;
      });
      const ageMin = Math.min(h.targeting.ageMin, h.targeting.ageMax);
      const ageMax = Math.max(h.targeting.ageMin, h.targeting.ageMax);
      return { ...h, targeting: { ...h.targeting, interests, ageMin, ageMax } };
    });
    return {
      output: { ...o, hypotheses, excludedSensitive: [...new Set([...o.excludedSensitive, ...excluded])] },
      escalate: excluded.length > 0,
      reasons: excluded.length ? [`Removed sensitive targeting terms: ${excluded.join(", ")}`] : [],
    };
  },
};

// ───────────────────────────── 4. Content copywriter ─────────────────────────────

export const copywriterInput = z.object({
  brief: z.string().min(3).max(3000),
  format: z.enum(["post", "carousel", "story", "reel"]),
  language: z.string().max(20).default("en"),
  targetSegment: z.string().max(300).optional(),
  productIds: z.array(z.uuid()).max(10).default([]),
  variants: z.number().int().min(1).max(4).default(2),
});
export const copywriterOutput = z.object({
  variants: z
    .array(
      z.object({
        hook: z.string().max(200),
        caption: z.string().max(2200),
        cta: z.string().max(120),
        hashtags: z.array(z.string().regex(/^[\p{L}\p{N}_]+$/u)).max(15),
        altText: z.string().max(1000),
        carouselOutline: z.array(z.string().max(300)).max(10).default([]),
      }),
    )
    .min(1)
    .max(4),
  sourceFactIds: factIds,
  missingInformation: z.array(z.string().max(300)).max(10).default([]),
  confidence: conf,
});

const contentCopywriter: AgentContract<z.infer<typeof copywriterInput>, z.infer<typeof copywriterOutput>> = {
  role: "content_copywriter",
  title: "Content copywriter",
  purpose: "Writes captions, hooks, CTAs, carousel outlines, alt text and localized variants grounded in approved facts and current promotion terms.",
  nonGoals: ["Choosing publish times", "Creating claims not in the Company Brain", "False scarcity or urgency"],
  inputSchema: copywriterInput,
  outputSchema: copywriterOutput,
  allowedTools: ["read_company_facts", "search_knowledge", "read_products", "read_promotion", "create_draft_version"],
  disallowedActions: COMMON_DISALLOWED,
  sourceRequirements: "Cite fact ids used; only approved URLs; promotion terms copied exactly.",
  minConfidence: 0.4,
  model: "default",
  timeoutMs: 90_000,
  maxRetries: 1,
  maxSteps: 3,
  maxTokens: 3500,
  budgetUsdPerRun: 0.2,
  escalation: ["Brief requires facts not in the Company Brain", "Brand check blocks every variant"],
  retrievalQuery: (i) => i.brief,
  buildPrompt: (i, g) => [
    {
      role: "system",
      content: system("content copywriter", `Write ${i.variants} Instagram ${i.format} caption variants in language "${i.language}". Max 2200 characters, at most 15 hashtags (without #), include descriptive alt text. Only use links on approved domains.`),
    },
    { role: "user", content: `${groundingText(g, { promotion: true })}\n\nTARGET SEGMENT: ${i.targetSegment ?? "(not specified)"}\nBRIEF: ${quoteUntrusted("user_brief", i.brief)}` },
  ],
  mock: (i, g) => {
    const p = g.products.find((x) => i.productIds.includes(x.id)) ?? g.products[0];
    const promo = g.promotion as { discountType?: string; discountValue?: string | number; name?: string } | null | undefined;
    const offer = promo?.discountType === "percent" && promo.discountValue ? ` ${Number(promo.discountValue)}% off — ${promo.name ?? "limited-time offer"}.` : "";
    return {
      variants: Array.from({ length: i.variants }, (_, k) => ({
        hook: `${MOCK} ${p ? p.name : "Our brand"} — idea ${k + 1}`,
        caption: `${MOCK} ${i.brief.slice(0, 200)}${p ? `\n\n${p.name}${p.url ? ` → ${p.url}` : ""}` : ""}${offer}`,
        cta: p?.url ? "Tap the link to learn more" : "Send us a message to learn more",
        hashtags: (p?.keywords ?? []).slice(0, 3).map((k2) => k2.replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean),
        altText: p ? `Photo of ${p.name}` : "Brand image",
        carouselOutline: i.format === "carousel" ? ["Cover", "Problem", "How it helps", "Call to action"] : [],
      })),
      sourceFactIds: g.facts.slice(0, 3).map((f) => f.id),
      missingInformation: g.facts.length ? [] : ["Approved facts about the product"],
      confidence: 0.5,
    };
  },
  postValidate: (o, _i, g) => {
    const known = new Set(g.facts.map((f) => f.id));
    return { output: { ...o, sourceFactIds: o.sourceFactIds.filter((id) => known.has(id)) }, escalate: o.missingInformation.length > 0, reasons: o.missingInformation };
  },
};

// ───────────────────────────── 5. Creative director ─────────────────────────────

export const creativeInput = z.object({
  brief: z.string().min(3).max(3000),
  format: z.enum(["post", "carousel", "story", "reel"]),
  aspectRatio: z.enum(["1:1", "4:5", "9:16", "16:9"]).optional(),
  productIds: z.array(z.uuid()).max(10).default([]),
});
export const creativeOutput = z.object({
  visualBrief: z.string().max(2000),
  storyboard: z.array(z.object({ shot: z.number().int().min(1).max(20), description: z.string().max(500), onScreenText: z.string().max(200), durationSec: z.number().min(0.5).max(30) })).max(12),
  prompt: z.string().max(1500),
  aspectRatio: z.enum(["1:1", "4:5", "9:16", "16:9"]),
  durationSec: z.number().min(1).max(60).nullable(),
  audioGuidance: z.string().max(500).default(""),
  brandConstraints: z.array(z.string().max(300)).max(15),
  rightsNotes: z.array(z.string().max(300)).max(10).default([]),
});

const creativeDirector: AgentContract<z.infer<typeof creativeInput>, z.infer<typeof creativeOutput>> = {
  role: "creative_director",
  title: "Creative director",
  purpose: "Converts briefs into storyboards, shot lists, generation prompts, composition rules and brand constraints.",
  nonGoals: ["Generating media directly", "Depicting real people without documented consent", "Altering logos or product appearance"],
  inputSchema: creativeInput,
  outputSchema: creativeOutput,
  allowedTools: ["read_company_facts", "read_products", "read_media_rights"],
  disallowedActions: [...COMMON_DISALLOWED, "use likeness of real people without consent metadata"],
  sourceRequirements: "Product appearance must follow catalog/brand facts; note rights requirements for any reference asset.",
  minConfidence: 0.4,
  model: "default",
  timeoutMs: 90_000,
  maxRetries: 1,
  maxSteps: 3,
  maxTokens: 3000,
  budgetUsdPerRun: 0.2,
  escalation: ["Brief references a real person or third-party IP", "Missing visual identity"],
  retrievalQuery: (i) => i.brief,
  buildPrompt: (i, g) => [
    { role: "system", content: system("creative director", `Produce a ${i.format} visual plan with a single generation prompt. Default aspect ratio for reels/stories is 9:16 and for feed posts 4:5.`) },
    { role: "user", content: `${groundingText(g)}\n\nBRIEF: ${quoteUntrusted("user_brief", i.brief)}` },
  ],
  mock: (i, g) => {
    const video = i.format === "reel" || i.format === "story";
    const ar = i.aspectRatio ?? (video ? "9:16" : "4:5");
    return {
      visualBrief: `${MOCK} Clean product-focused visual for: ${i.brief.slice(0, 200)}`,
      storyboard: video
        ? [
            { shot: 1, description: "Hook: product close-up", onScreenText: g.products[0]?.name ?? "Brand", durationSec: 2 },
            { shot: 2, description: "Product in use", onScreenText: "", durationSec: 3 },
            { shot: 3, description: "CTA end card", onScreenText: "Link in bio", durationSec: 2 },
          ]
        : [],
      prompt: `Editorial product photograph, soft daylight, minimal background. Subject: ${g.products[0]?.name ?? "brand product"}. ${i.brief.slice(0, 300)}`,
      aspectRatio: ar,
      durationSec: video ? 7 : null,
      audioGuidance: video ? "Licensed or provider-generated music only." : "",
      brandConstraints: g.rules.filter((r) => r.kind === "voice").map((r) => r.text),
      rightsNotes: ["Do not depict real people unless consent is recorded on the reference asset."],
    };
  },
};

// ───────────────────────────── 6. Media producer (deterministic) ─────────────────────────────

export const mediaProducerInput = z.object({ prompt: z.string().min(3).max(1500), kind: z.enum(["image", "video"]), aspectRatio: z.string().optional() });
export const mediaProducerOutput = z.object({ modelId: z.string(), params: z.record(z.string(), z.unknown()), note: z.string() });

const mediaProducer: AgentContract<z.infer<typeof mediaProducerInput>, z.infer<typeof mediaProducerOutput>> = {
  role: "media_producer",
  title: "Media producer",
  purpose: "Selects a configured provider model and creates asynchronous generation jobs with cost estimates; validates outputs.",
  nonGoals: ["Claiming success for failed or unusable outputs", "Bypassing per-tenant media budgets"],
  inputSchema: mediaProducerInput,
  outputSchema: mediaProducerOutput,
  allowedTools: ["create_media_job", "read_media_jobs"],
  disallowedActions: COMMON_DISALLOWED,
  sourceRequirements: "Model ids must come from the verified provider catalog.",
  minConfidence: 1,
  model: "none",
  timeoutMs: 10_000,
  maxRetries: 0,
  maxSteps: 1,
  maxTokens: 0,
  budgetUsdPerRun: 0,
  escalation: ["Provider not connected", "Media budget exhausted", "Output failed validation"],
  mock: (i) => ({
    modelId: i.kind === "video" ? "kling-3-std-t2v" : "higgsfield-soul-v2",
    params: i.kind === "video" ? { duration: 5, aspect_ratio: i.aspectRatio === "16:9" ? "16:9" : "9:16", sound: "off" } : { aspect_ratio: i.aspectRatio ?? "4:5" },
    note: "Deterministic model selection from the verified catalog.",
  }),
};

// ───────────────────────────── 7. Community manager ─────────────────────────────

export const INTENTS = ["product_link", "price", "stock_variant", "delivery", "offer", "purchase_intent", "support", "complaint", "spam", "unknown"] as const;
export type Intent = (typeof INTENTS)[number];

export const communityInput = z.object({
  text: z.string().max(2200),
  channel: z.enum(["instagram_comment", "instagram_dm"]),
  mediaCaption: z.string().max(2200).optional(),
  linkedProductIds: z.array(z.string()).max(10).default([]),
});
export const communityOutput = z.object({
  intent: z.enum(INTENTS),
  confidence: conf,
  sentiment: z.enum(["positive", "neutral", "negative"]),
  language: z.string().max(10),
  productId: z.string().nullable(),
  productConfidence: conf,
  isLead: z.boolean(),
  escalate: z.boolean(),
  escalationReasons: z.array(z.string().max(200)).max(10),
  publicReply: z.string().max(300),
  privateReply: z.string().max(1000),
});

const communityManager: AgentContract<z.infer<typeof communityInput>, z.infer<typeof communityOutput>> = {
  role: "community_manager",
  title: "Community manager",
  purpose: "Classifies eligible inbound comments/DMs, matches products, drafts grounded public and private replies, and escalates sensitive or low-confidence cases.",
  nonGoals: ["Sending replies", "Treating a comment as permission for ongoing DMs", "Handling refunds, legal or safety issues"],
  inputSchema: communityInput,
  outputSchema: communityOutput,
  allowedTools: ["read_company_facts", "read_products", "search_knowledge", "create_reply_draft"],
  disallowedActions: [...COMMON_DISALLOWED, "promise refunds, exceptions or discounts not in approved terms"],
  sourceRequirements: "Prices, URLs, stock and delivery details only from the approved catalog; otherwise escalate.",
  minConfidence: 0.7,
  model: "fast",
  timeoutMs: 30_000,
  maxRetries: 1,
  maxSteps: 2,
  maxTokens: 1200,
  budgetUsdPerRun: 0.02,
  escalation: ["Complaint, refund, legal or safety topic", "Confidence below 0.7", "Ambiguous product", "Missing price/stock"],
  buildPrompt: (i, g) => [
    {
      role: "system",
      content: system(
        "community manager",
        "Classify the customer's message intent and draft a short friendly public reply (no links, no prices) and a private reply that may include the approved product URL and price. If the product is ambiguous, set productId null.",
      ),
    },
    {
      role: "user",
      content: `${groundingText(g, { snippets: false, promotion: true })}\n\nPOST CAPTION: ${quoteUntrusted("post_caption", i.mediaCaption ?? "", 800)}\nLINKED PRODUCT IDS: ${JSON.stringify(i.linkedProductIds)}\nCUSTOMER ${i.channel === "instagram_comment" ? "COMMENT" : "MESSAGE"}: ${quoteUntrusted("customer_message", i.text, 1000)}`,
    },
  ],
  mock: (i, g) => {
    // Deterministic classifier used when no LLM is configured (also the pre-LLM fast path).
    const c = classifyIntentRules(i.text);
    const product = g.products.find((p) => i.linkedProductIds.includes(p.id)) ?? (g.products.length === 1 ? g.products[0] : undefined);
    return {
      intent: c.intent,
      confidence: c.confidence,
      sentiment: c.intent === "complaint" ? "negative" : "neutral",
      language: "en",
      productId: product?.id ?? null,
      productConfidence: product ? (i.linkedProductIds.includes(product.id) ? 0.9 : 0.6) : 0,
      isLead: ["product_link", "price", "purchase_intent", "stock_variant", "offer"].includes(c.intent),
      escalate: ["complaint", "support", "unknown"].includes(c.intent),
      escalationReasons: c.intent === "complaint" ? ["Complaint"] : [],
      publicReply: "Thanks for your interest! We've sent you the details in a private message.",
      privateReply: product ? `Hi! Here's the ${product.name}${product.url ? `: ${product.url}` : ""}` : "",
    };
  },
};

/** Fast deterministic intent classifier (keyword rules). LLM classification may refine it. */
export function classifyIntentRules(text: string): { intent: Intent; confidence: number } {
  const t = text.toLowerCase().trim();
  if (!t) return { intent: "unknown", confidence: 0.2 };
  if (/(https?:\/\/|www\.)\S+/.test(t) && /(follow|free|crypto|dm me|promo|followers)/.test(t)) return { intent: "spam", confidence: 0.9 };
  if (/\b(refund|scam|broken|terrible|worst|never arrived|didn'?t arrive|complain|lawyer|sue|chargeback|damaged|angry|disappointed)\b/.test(t)) return { intent: "complaint", confidence: 0.9 };
  if (/\b(order|tracking|my package|cancel my|exchange|support|help with)\b/.test(t)) return { intent: "support", confidence: 0.75 };
  if (/^\s*link\s*[!.]*\s*$/.test(t) || /\b(send|share|drop|dm|give)\b.{0,20}\blink\b|\blink\b.{0,15}\b(please|pls|plz)\b|\bwhere (can|do) i (buy|get|order)\b|\blink\b\??$/.test(t)) {
    return { intent: "product_link", confidence: 0.92 };
  }
  if (/\b(price|cost|how much|\$\$|pricing)\b|^\s*(price|pp|pm)\s*\??\s*$/.test(t)) return { intent: "price", confidence: 0.9 };
  if (/\b(in stock|available|sizes?|colou?rs?|variant|restock|sold out)\b/.test(t)) return { intent: "stock_variant", confidence: 0.8 };
  if (/\b(ship|shipping|deliver|delivery|arrive)\b/.test(t)) return { intent: "delivery", confidence: 0.8 };
  if (/\b(discount|code|coupon|sale|offer|promo)\b/.test(t)) return { intent: "offer", confidence: 0.75 };
  if (/\b(want|need|buy|purchase|i'?ll take|ordering)\b/.test(t)) return { intent: "purchase_intent", confidence: 0.7 };
  return { intent: "unknown", confidence: 0.4 };
}

// ───────────────────────────── 8. Ads strategist ─────────────────────────────

export const adsStrategistInput = z.object({
  goal: z.string().min(3).max(1500),
  dailyBudgetMinor: z.number().int().positive().optional(),
  durationDays: z.number().int().min(1).max(90).optional(),
  destinationUrl: z.url().optional(),
});
export const adsStrategistOutput = z.object({
  campaignName: z.string().max(120),
  objective: z.enum(["OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_SALES"]),
  audienceHypothesis: z.object({ countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(25), ageMin: z.number().int().min(18).max(65), ageMax: z.number().int().min(18).max(65), interests: z.array(z.string().max(80)).max(10), rationale: z.string().max(600) }),
  placements: z.array(z.enum(["instagram_feed", "instagram_stories", "instagram_reels", "instagram_explore"])).min(1),
  dailyBudgetMinor: z.number().int().positive().nullable(),
  durationDays: z.number().int().min(1).max(90).nullable(),
  destinationUrl: z.string().max(1000).nullable(),
  conversionEvent: z.string().max(60).nullable(),
  creativeVariants: z.array(z.object({ headline: z.string().max(80), primaryText: z.string().max(500), cta: z.enum(["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "CONTACT_US", "GET_OFFER"]) })).min(1).max(4),
  trackingRequirements: z.array(z.string().max(300)).max(10),
  missingInformation: z.array(z.string().max(300)).max(10),
  risks: z.array(z.string().max(300)).max(10),
  assumptions: z.array(z.string().max(300)).max(10),
});

const adsStrategist: AgentContract<z.infer<typeof adsStrategistInput>, z.infer<typeof adsStrategistOutput>> = {
  role: "ads_strategist",
  title: "Ads strategist",
  purpose: "Prepares a costed Meta campaign proposal: objective, audience hypothesis, placements, budget, schedule, destination, tracking and creative variants.",
  nonGoals: ["Launching or changing ads", "Guaranteeing ROAS or reach", "Choosing a budget the user did not provide"],
  inputSchema: adsStrategistInput,
  outputSchema: adsStrategistOutput,
  allowedTools: ["read_company_facts", "read_products", "read_promotion", "read_analytics", "create_ad_draft"],
  disallowedActions: COMMON_DISALLOWED,
  sourceRequirements: "Budget and dates come from the user or approved promotion; destination must be on an approved domain.",
  minConfidence: 0.4,
  model: "default",
  timeoutMs: 90_000,
  maxRetries: 1,
  maxSteps: 3,
  maxTokens: 3000,
  budgetUsdPerRun: 0.2,
  escalation: ["Budget missing", "Destination not on allowlist", "Special ad category may apply"],
  retrievalQuery: (i) => i.goal,
  buildPrompt: (i, g) => [
    { role: "system", content: system("Meta ads strategist", "Propose one campaign with a single ad set. Use only the budget and dates provided; if absent set them to null and list them as missing. Never promise results.") },
    { role: "user", content: `${groundingText(g, { promotion: true })}\n\nUSER BUDGET (minor units/day): ${i.dailyBudgetMinor ?? "not provided"}\nDURATION DAYS: ${i.durationDays ?? "not provided"}\nDESTINATION: ${i.destinationUrl ?? "not provided"}\nGOAL: ${quoteUntrusted("user_goal", i.goal)}` },
  ],
  mock: (i, g) => ({
    campaignName: `${(g.company.name ?? "Brand").slice(0, 40)} — ${i.goal.slice(0, 50)}`,
    objective: /sale|purchase|buy/i.test(i.goal) ? "OUTCOME_SALES" : "OUTCOME_TRAFFIC",
    audienceHypothesis: { countries: ["US"], ageMin: 25, ageMax: 54, interests: g.products.flatMap((p) => p.keywords).slice(0, 5), rationale: `${MOCK} Broad hypothesis; refine with measured results.` },
    placements: ["instagram_feed", "instagram_reels", "instagram_stories"],
    dailyBudgetMinor: i.dailyBudgetMinor ?? null,
    durationDays: i.durationDays ?? null,
    destinationUrl: i.destinationUrl ?? g.products.find((p) => p.url)?.url ?? null,
    conversionEvent: /sale|purchase/i.test(i.goal) ? "PURCHASE" : null,
    creativeVariants: [{ headline: g.products[0]?.name ?? "Discover more", primaryText: `${MOCK} ${i.goal.slice(0, 200)}`, cta: "LEARN_MORE" }],
    trackingRequirements: ["Meta Pixel / dataset installed on destination", "UTM parameters on destination URL"],
    missingInformation: [...(i.dailyBudgetMinor ? [] : ["Daily budget"]), ...(i.durationDays ? [] : ["Campaign duration"])],
    risks: ["Delivery and results are controlled by Meta's auction and review."],
    assumptions: ["Audience is a hypothesis, not a guarantee."],
  }),
  postValidate: (o, i) => {
    const reasons = [...o.missingInformation];
    // The model may not invent a budget the user did not give.
    const output = { ...o, dailyBudgetMinor: i.dailyBudgetMinor ?? null, durationDays: i.durationDays ?? o.durationDays };
    if (!i.dailyBudgetMinor && !reasons.includes("Daily budget")) reasons.push("Daily budget");
    return { output, escalate: reasons.length > 0, reasons };
  },
};

// ───────────────────────────── 9. Ads operator (deterministic) ─────────────────────────────

export const adsOperatorInput = z.object({ adCampaignId: z.uuid(), action: z.enum(["launch", "pause", "resume"]) });
export const adsOperatorOutput = z.object({ executed: z.boolean(), note: z.string() });

const adsOperator: AgentContract<z.infer<typeof adsOperatorInput>, z.infer<typeof adsOperatorOutput>> = {
  role: "ads_operator",
  title: "Ads operator",
  purpose: "Executes only approved ads operations through the Marketing API within hard spend caps, with idempotency and reconciliation.",
  nonGoals: ["Deciding strategy", "Executing unapproved or over-cap changes", "Bypassing Meta review"],
  inputSchema: adsOperatorInput,
  outputSchema: adsOperatorOutput,
  allowedTools: ["execute_approved_ad_action"],
  disallowedActions: ["any action without a valid approval bound to the exact payload", "exceed workspace spend caps"],
  sourceRequirements: "Executes the approved payload verbatim.",
  minConfidence: 1,
  model: "none",
  timeoutMs: 60_000,
  maxRetries: 0,
  maxSteps: 1,
  maxTokens: 0,
  budgetUsdPerRun: 0,
  escalation: ["Approval invalid", "Spend cap exceeded", "Provider outcome unknown"],
  mock: () => ({ executed: false, note: "Ads operator runs as the ads.execute job, not as an LLM agent." }),
};

// ───────────────────────────── 10. Analytics analyst ─────────────────────────────

export const analyticsInput = z.object({ windowDays: z.number().int().min(1).max(90).default(28) });
export const analyticsOutput = z.object({
  summary: z.string().max(1500),
  findings: z.array(z.object({ statement: z.string().max(400), evidence: z.array(z.string().max(200)).min(1).max(5) })).max(10),
  recommendations: z.array(z.object({ action: z.string().max(300), rationale: z.string().max(400), evidence: z.array(z.string().max(200)).max(5) })).max(8),
  dataGaps: z.array(z.string().max(300)).max(10),
  causalCaveat: z.string().max(400),
});

const analyticsAnalyst: AgentContract<z.infer<typeof analyticsInput>, z.infer<typeof analyticsOutput>> = {
  role: "analytics_analyst",
  title: "Analytics analyst",
  purpose: "Summarizes measured metrics, separates facts from recommendations, and lists data gaps.",
  nonGoals: ["Inventing or imputing metrics", "Causal claims from weak data"],
  inputSchema: analyticsInput,
  outputSchema: analyticsOutput,
  allowedTools: ["read_analytics"],
  disallowedActions: COMMON_DISALLOWED,
  sourceRequirements: "Every finding cites a metric snapshot (source + window) supplied in the input.",
  minConfidence: 0.5,
  model: "default",
  timeoutMs: 60_000,
  maxRetries: 1,
  maxSteps: 2,
  maxTokens: 2500,
  budgetUsdPerRun: 0.1,
  escalation: ["No measured data available"],
  buildPrompt: (i, g) => [
    { role: "system", content: system("analytics analyst", `Analyze ONLY the measured metrics provided for the last ${i.windowDays} days. Every finding must cite evidence strings from the data. If there is no data, say so.`) },
    { role: "user", content: `MEASURED METRICS (source-labelled): ${JSON.stringify(g.metrics ?? {})}` },
  ],
  mock: (_i, g) => {
    const m = (g.metrics ?? {}) as { contentSnapshots?: unknown[]; adSnapshots?: unknown[] };
    const has = (m.contentSnapshots?.length ?? 0) + (m.adSnapshots?.length ?? 0) > 0;
    return {
      summary: has ? `${MOCK} ${m.contentSnapshots?.length ?? 0} content and ${m.adSnapshots?.length ?? 0} ad metric snapshots available.` : `${MOCK} No measured data yet. Connect Instagram insights or Meta ads to see results.`,
      findings: [],
      recommendations: [],
      dataGaps: has ? [] : ["No provider metrics have been synced for this window."],
      causalCaveat: "Correlation in small samples does not establish causation.",
    };
  },
  postValidate: (o, _i, g) => {
    const m = (g.metrics ?? {}) as { contentSnapshots?: unknown[]; adSnapshots?: unknown[] };
    const has = (m.contentSnapshots?.length ?? 0) + (m.adSnapshots?.length ?? 0) > 0;
    if (!has && (o.findings.length || o.recommendations.length)) {
      return { output: { ...o, findings: [], recommendations: [], dataGaps: ["No measured data; findings were discarded."] }, escalate: true, reasons: ["Model produced findings without measured data"] };
    }
    return { output: o, escalate: false, reasons: [] };
  },
};

// ───────────────────────────── 11. Compliance reviewer ─────────────────────────────

export const complianceInput = z.object({ text: z.string().max(5000), channel: z.string().max(40) });
export const complianceOutput = z.object({
  status: z.enum(["pass", "warning", "block"]),
  findings: z.array(z.object({ severity: z.enum(["block", "warning", "info"]), code: z.string().max(60), message: z.string().max(400) })).max(20),
});

const complianceReviewer: AgentContract<z.infer<typeof complianceInput>, z.infer<typeof complianceOutput>> = {
  role: "compliance_reviewer",
  title: "Compliance reviewer",
  purpose: "Checks claims, offer consistency, channel constraints, rights/consent metadata and policy risks; returns pass, warning or block with reasons.",
  nonGoals: ["Rewriting content", "Overriding deterministic blocks", "Providing legal advice"],
  inputSchema: complianceInput,
  outputSchema: complianceOutput,
  allowedTools: ["read_company_facts", "read_brand_rules", "read_promotion"],
  disallowedActions: [...COMMON_DISALLOWED, "downgrade a deterministic block"],
  sourceRequirements: "Each finding references a brand rule, approved claim, or channel constraint.",
  minConfidence: 0.5,
  model: "fast",
  timeoutMs: 30_000,
  maxRetries: 1,
  maxSteps: 2,
  maxTokens: 1500,
  budgetUsdPerRun: 0.02,
  escalation: ["Any block", "Health/financial/legal claims"],
  buildPrompt: (i, g) => [
    { role: "system", content: system("compliance reviewer", "Review the copy against the brand rules and approved claims. Flag unsubstantiated claims, offer inconsistencies and risky language. You may add findings, never remove deterministic ones.") },
    { role: "user", content: `${groundingText(g, { snippets: false, promotion: true })}\n\nCHANNEL: ${i.channel}\nCOPY: ${quoteUntrusted("draft_copy", i.text)}` },
  ],
  mock: () => ({ status: "pass", findings: [{ severity: "info", code: "mock_review", message: `${MOCK} Deterministic checks only.` }] }),
};

export const CONTRACTS: Record<AgentRole, AgentContract<never, unknown>> = {
  marketing_strategist: marketingStrategist,
  company_knowledge: companyKnowledge,
  audience_research: audienceResearch,
  content_copywriter: contentCopywriter,
  creative_director: creativeDirector,
  media_producer: mediaProducer,
  community_manager: communityManager,
  ads_strategist: adsStrategist,
  ads_operator: adsOperator,
  analytics_analyst: analyticsAnalyst,
  compliance_reviewer: complianceReviewer,
} as unknown as Record<AgentRole, AgentContract<never, unknown>>;

export const isAgentRole = (r: string): r is AgentRole => (AGENT_ROLES as readonly string[]).includes(r);
