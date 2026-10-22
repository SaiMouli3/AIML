import { describe, expect, it } from "vitest";
import { checkOfferConsistency, missingFields, parsePromotionRequest } from "@/server/services/promotions";
import { runBrandCheck } from "@/server/services/brand-check";
import { classifyIntentRules, CONTRACTS } from "@/server/agents/contracts";
import {
  normalizeMetaWebhook,
  planReplies,
  resolveProduct,
  validateGroundedText,
} from "@/server/services/inbox";
import {
  commentToDmConfigSchema,
  renderTemplate,
  triggerMatches,
  withinSchedule,
} from "@/server/services/automation-config";
import { canTransition } from "@/server/agents/orchestrator";
import { mapGraphError } from "@/server/providers/meta/graph";
import { capabilitiesFromScopes } from "@/server/providers/meta/instagram";
import { parseStatusPayload } from "@/server/providers/higgsfield/higgsfield";
import { derived } from "@/server/services/analytics";

describe("promotion parsing", () => {
  it("parses the canonical request without guessing", () => {
    const p = parsePromotionRequest("Run 50% off on our products for three days");
    expect(p).toMatchObject({
      discountType: "percent",
      discountValue: 50,
      durationDays: 3,
      allProducts: false,
      landingPageUrl: null,
      startHint: null,
    });
  });
  it("parses fixed, bogo, free shipping and links", () => {
    expect(
      parsePromotionRequest(
        "$10 off all products for 2 weeks starting tomorrow https://shop.example.com/sale",
      ),
    ).toMatchObject({
      discountType: "fixed_amount",
      discountValue: 10,
      currency: "USD",
      durationDays: 14,
      allProducts: true,
      startHint: "tomorrow",
      landingPageUrl: "https://shop.example.com/sale",
    });
    expect(parsePromotionRequest("BOGO on candles").discountType).toBe("bogo");
    expect(parsePromotionRequest("free shipping this weekend").discountType).toBe("free_shipping");
  });
  it("reports every essential missing field", () => {
    expect(
      missingFields({
        discountType: "percent",
        discountValue: "50",
        eligibleProductIds: [],
        eligibleDescription: null,
        startsAt: null,
        endsAt: null,
        timezone: null,
        landingPageUrl: null,
        terms: null,
      }),
    ).toEqual(["eligibleProducts", "startsAt", "endsAt", "timezone", "landingPageUrl", "terms"]);
  });
  it("validates identical discount terms across assets", () => {
    const promo = {
      discountType: "percent",
      discountValue: "50",
      endsAt: new Date(),
      landingPageUrl: "https://shop.example.com/sale",
      currency: null,
    };
    const issues = checkOfferConsistency(promo, [
      { label: "post", text: "50% off everything! https://shop.example.com/sale" },
      { label: "story", text: "Get 40% off now" },
      { label: "ad", text: "Half price, forever" },
    ]);
    expect(issues.filter((i) => i.asset === "post")).toHaveLength(0);
    expect(issues.find((i) => i.asset === "story" && i.severity === "block")?.message).toMatch(/40%/);
    expect(issues.find((i) => i.asset === "ad" && i.severity === "block")?.message).toMatch(/never ends/);
  });
});

describe("brand checks", () => {
  const base = {
    cta: null,
    altText: "alt",
    hashtags: [],
    format: "post" as const,
    media: [{ kind: "image", mimeType: "image/jpeg", width: 1080, height: 1350 }],
    rules: [{ kind: "forbidden_word", text: "cheap" }],
    allowedDomains: ["shop.example.com"],
    products: [{ name: "Mug", priceMinor: 1500, currency: "USD" }],
    promotion: null,
  };
  it("blocks forbidden words, unapproved links and offer mismatch", () => {
    expect(runBrandCheck({ ...base, caption: "So cheap!" }).status).toBe("block");
    expect(runBrandCheck({ ...base, caption: "Buy at https://evil.example.org" }).status).toBe("block");
    expect(
      runBrandCheck({
        ...base,
        caption: "30% off",
        promotion: { discountType: "percent", discountValue: "50", endsAt: null },
      }).findings.some((f) => f.code === "offer_mismatch"),
    ).toBe(true);
  });
  it("warns on unverified prices and unsubstantiated claims", () => {
    const r = runBrandCheck({ ...base, caption: "Only $9 — guaranteed results" });
    expect(r.status).toBe("warning");
    expect(r.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["unverified_price", "unsubstantiated_claim"]),
    );
  });
  it("passes clean copy with the right price", () => {
    expect(runBrandCheck({ ...base, caption: "Our Mug is $15. https://shop.example.com/mug" }).status).toBe(
      "pass",
    );
  });
  it("enforces Instagram limits", () => {
    expect(runBrandCheck({ ...base, caption: "x".repeat(2201) }).status).toBe("block");
    expect(
      runBrandCheck({ ...base, caption: "ok", hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`) })
        .status,
    ).toBe("block");
  });
});

describe("comment intent classification", () => {
  it.each([
    ["Please send me the link", "product_link"],
    ["LINK", "product_link"],
    ["Where can I buy this?", "product_link"],
    ["Price?", "price"],
    ["how much is it", "price"],
    ["Is the blue one in stock?", "stock_variant"],
    ["Do you ship to Canada?", "delivery"],
    ["Any discount code?", "offer"],
    ["My order never arrived, I want a refund", "complaint"],
    ["Follow me for free followers https://spam.biz", "spam"],
    ["🔥🔥🔥", "unknown"],
  ])("%s → %s", (text, intent) => expect(classifyIntentRules(text).intent).toBe(intent));
});

const prod = (id: string, name: string, extra: Partial<Record<string, unknown>> = {}) =>
  ({
    id,
    workspaceId: "w",
    name,
    sku: null,
    description: null,
    url: `https://shop.example.com/${id}`,
    priceMinor: 2500,
    currency: "USD",
    variants: ["Blue", "Red"],
    stockStatus: "in_stock",
    deliveryPolicy: "Ships in 2 days",
    keywords: [name.toLowerCase().split(" ")[0]!],
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  }) as never;

describe("product resolution", () => {
  const catalog = [prod("p1", "Aurora Candle"), prod("p2", "Nimbus Mug")];
  it("uses the single product linked to the post", () => {
    expect(resolveProduct("link please", ["p1"], catalog).product?.id).toBe("p1");
  });
  it("is ambiguous when the post features several products and the comment does not say which", () => {
    const r = resolveProduct("link please", ["p1", "p2"], catalog);
    expect(r.product).toBeNull();
    expect(r.reason).toMatch(/2 products/);
  });
  it("disambiguates by name", () => {
    expect(resolveProduct("link for the mug please", ["p1", "p2"], catalog).product?.id).toBe("p2");
  });
});

describe("reply planning & escalation", () => {
  const catalog = [prod("p1", "Aurora Candle")];
  const base = {
    username: "jo",
    promotion: null,
    rule: null,
    minConfidence: 0.7,
    injectionFlag: false,
    allowedDomains: ["shop.example.com"],
  };
  it("drafts a grounded private reply with the approved URL", () => {
    const plan = planReplies({
      ...base,
      intent: "product_link",
      confidence: 0.92,
      resolution: resolveProduct("link", ["p1"], catalog),
    });
    expect(plan.escalate).toBe(false);
    expect(plan.privateReply).toContain("https://shop.example.com/p1");
    expect(plan.publicReply).not.toMatch(/https?:/);
  });
  it.each([
    ["complaint", 0.9, ["p1"], /Complaint/],
    ["product_link", 0.5, ["p1"], /confidence/],
    ["product_link", 0.9, [], /ambiguous/],
  ])("escalates %s", (intent, confidence, linked, re) => {
    const plan = planReplies({
      ...base,
      intent: intent as never,
      confidence: confidence as number,
      resolution: resolveProduct("link", linked as string[], catalog),
    });
    expect(plan.escalate).toBe(true);
    expect(plan.escalationReasons.join()).toMatch(re);
  });
  it("escalates price questions without an approved price and unapproved URLs", () => {
    const noPrice = [prod("p1", "Aurora Candle", { priceMinor: null })];
    expect(
      planReplies({
        ...base,
        intent: "price",
        confidence: 0.9,
        resolution: resolveProduct("price", ["p1"], noPrice),
      }).escalationReasons.join(),
    ).toMatch(/price/);
    const badUrl = [prod("p1", "Aurora Candle", { url: "https://evil.example.org/p1" })];
    expect(
      planReplies({
        ...base,
        intent: "product_link",
        confidence: 0.9,
        resolution: resolveProduct("link", ["p1"], badUrl),
      }).escalate,
    ).toBe(true);
  });
  it("rejects LLM replies containing invented prices or links", () => {
    const p = catalog[0] as never;
    expect(validateGroundedText("It's $9 at https://shop.example.com/p1", p, base.allowedDomains).ok).toBe(
      false,
    );
    expect(validateGroundedText("It's $25 at https://shop.example.com/p1", p, base.allowedDomains).ok).toBe(
      true,
    );
    expect(validateGroundedText("Go to https://other.example.net", p, base.allowedDomains).ok).toBe(false);
  });
});

describe("rule config & templates", () => {
  const cfg = commentToDmConfigSchema.parse({ triggers: ["LINK"], allowedIntents: ["product_link"] });
  it("matches whole-word triggers case-insensitively", () => {
    expect(triggerMatches(cfg, "link please")).toBe(true);
    expect(triggerMatches(cfg, "linked in")).toBe(false);
  });
  it("reports missing template values instead of rendering blanks", () => {
    expect(renderTemplate("Hi {username}: {product_url}", { username: "jo" }).missing).toEqual([
      "product_url",
    ]);
  });
  it("evaluates schedule in the rule timezone", () => {
    const c = commentToDmConfigSchema.parse({
      allowedIntents: ["price"],
      schedule: { days: [1], startHour: 9, endHour: 17 },
    });
    expect(withinSchedule(c, "UTC", new Date("2026-10-19T10:00:00Z"))).toBe(true); // Monday
    expect(withinSchedule(c, "UTC", new Date("2026-10-19T18:00:00Z"))).toBe(false);
  });
});

describe("webhook normalization", () => {
  it("handles Instagram-login and Facebook-login comment shapes and messaging", () => {
    const igl = normalizeMetaWebhook({
      object: "instagram",
      entry: [
        {
          id: "IG1",
          time: 1700000000,
          field: "comments",
          value: {
            id: "C1",
            text: "link",
            from: { id: "U1", username: "jo" },
            media: { id: "M1", media_product_type: "REELS" },
          },
        },
      ],
    });
    expect(igl.events[0]).toMatchObject({
      kind: "comment",
      commentId: "C1",
      mediaId: "M1",
      fromUsername: "jo",
      isEcho: false,
    });
    const fbl = normalizeMetaWebhook({
      object: "instagram",
      entry: [
        {
          id: "IG1",
          time: 1700000000,
          changes: [{ field: "comments", value: { id: "C2", text: "price?", from: { id: "U2" } } }],
        },
      ],
    });
    expect(fbl.events[0]?.commentId).toBe("C2");
    const dm = normalizeMetaWebhook({
      object: "instagram",
      entry: [
        {
          id: "IG1",
          time: 1,
          messaging: [
            {
              sender: { id: "U3" },
              recipient: { id: "IG1" },
              timestamp: 1700000000000,
              message: { mid: "MID1", text: "hi" },
            },
          ],
        },
      ],
    });
    expect(dm.events[0]).toMatchObject({ kind: "dm", eventKey: "message:MID1" });
  });
  it("marks our own replies as echoes and ignores malformed entries", () => {
    const echo = normalizeMetaWebhook({
      object: "instagram",
      entry: [{ id: "IG1", field: "comments", value: { id: "C3", text: "thanks", from: { id: "IG1" } } }],
    });
    expect(echo.events[0]?.isEcho).toBe(true);
    expect(normalizeMetaWebhook({ nope: true }).events).toHaveLength(0);
  });
});

describe("workflow state machine", () => {
  it("allows the happy path and forbids skipping approval", () => {
    expect(canTransition("REQUESTED", "PLANNING")).toBe(true);
    expect(canTransition("AWAITING_APPROVAL", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "QUEUED")).toBe(true);
    expect(canTransition("DRAFTING", "EXECUTING")).toBe(false);
    expect(canTransition("VALIDATING", "EXECUTING")).toBe(false);
    expect(canTransition("CANCELLED", "PLANNING")).toBe(false);
  });
});

describe("provider error mapping", () => {
  it.each([
    [400, { error: { code: 190, message: "expired" } }, "auth"],
    [403, { error: { code: 10 } }, "permission"],
    [400, { error: { code: 200 } }, "permission"],
    [400, { error: { code: 4 } }, "rate_limit"],
    [400, { error: { code: 613 } }, "rate_limit"],
    [500, { error: { code: 2 } }, "transient"],
    [400, { error: { code: 100 } }, "invalid"],
    [400, { error: { code: 368 } }, "policy"],
  ])("HTTP %i %o → %s", (status, body, kind) => expect(mapGraphError(status, body).kind).toBe(kind));
  it("capabilities reflect granted scopes, not assumptions", () => {
    const caps = capabilitiesFromScopes(["instagram_business_basic"]);
    expect(caps.find((c) => c.capability === "publish_image")?.status).toBe("unavailable");
    expect(caps.find((c) => c.capability === "private_reply")?.status).toBe("unavailable");
    expect(caps.find((c) => c.capability === "messaging")?.reason).toMatch(
      /instagram_business_manage_messages/,
    );
  });
  it("higgsfield status and webhook payloads parse to the same shape", () => {
    expect(
      parseStatusPayload({
        status: "completed",
        request_id: "r",
        images: [{ url: "https://cdn.example.com/a.jpg" }],
      }).outputs,
    ).toHaveLength(1);
    expect(
      parseStatusPayload({
        request_id: "r",
        status: "completed",
        error: null,
        payload: { video: { url: "https://cdn.example.com/v.mp4" } },
      }).outputs[0]?.kind,
    ).toBe("video");
    expect(() => parseStatusPayload({ status: "weird" })).toThrow();
  });
});

describe("analytics derivations never impute", () => {
  it("returns null when inputs are missing", () => {
    expect(derived({ impressions: null, clicks: 10, spendMinor: 100, conversions: null })).toEqual({
      ctr: null,
      cpcMinor: 10,
      cpmMinor: null,
      cpaMinor: null,
    });
    expect(derived({ impressions: 1000, clicks: 0, spendMinor: 500, conversions: 0 }).cpcMinor).toBeNull();
  });
});

describe("agent contracts (adversarial outputs)", () => {
  it("audience research strips sensitive targeting", () => {
    const c = CONTRACTS.audience_research;
    const r = c.postValidate!(
      {
        hypotheses: [
          {
            name: "x",
            description: "",
            rationale: "",
            targeting: {
              countries: ["US"],
              ageMin: 30,
              ageMax: 25,
              interests: ["Diabetes", "Hiking", "Religion"],
            },
            confidence: 0.5,
          },
        ],
        excludedSensitive: [],
        caveats: [],
      } as never,
      {} as never,
      {} as never,
    ) as {
      output: { hypotheses: Array<{ targeting: { interests: string[]; ageMin: number } }> };
      escalate: boolean;
    };
    expect(r.output.hypotheses[0]!.targeting.interests).toEqual(["Hiking"]);
    expect(r.output.hypotheses[0]!.targeting.ageMin).toBe(25);
    expect(r.escalate).toBe(true);
  });
  it("ads strategist cannot invent a budget", () => {
    const r = CONTRACTS.ads_strategist.postValidate!(
      { dailyBudgetMinor: 999999, durationDays: 3, missingInformation: [] } as never,
      { goal: "x" } as never,
      {} as never,
    ) as { output: { dailyBudgetMinor: number | null }; escalate: boolean };
    expect(r.output.dailyBudgetMinor).toBeNull();
    expect(r.escalate).toBe(true);
  });
  it("analytics analyst discards findings without measured data", () => {
    const r = CONTRACTS.analytics_analyst.postValidate!(
      {
        summary: "",
        findings: [{ statement: "Reels drove 300% growth", evidence: ["x"] }],
        recommendations: [],
        dataGaps: [],
        causalCaveat: "",
      } as never,
      {} as never,
      { metrics: { contentSnapshots: [], adSnapshots: [] } } as never,
    ) as { output: { findings: unknown[] }; escalate: boolean };
    expect(r.output.findings).toHaveLength(0);
  });
  it("knowledge agent drops facts whose excerpt is not in the source", () => {
    const g = {
      snippets: [
        {
          sourceId: "s",
          sourceTitle: "t",
          text: "Price: $20 per candle. Ships in 3 days.",
          injectionFlag: true,
        },
      ],
    };
    const r = CONTRACTS.company_knowledge.postValidate!(
      {
        facts: [
          {
            category: "pricing",
            key: "price",
            value: "$20",
            excerpt: "Price: $20 per candle",
            confidence: 0.9,
          },
          {
            category: "pricing",
            key: "discount",
            value: "90% off",
            excerpt: "Everything is 90% off",
            confidence: 0.9,
          },
        ],
        injectionDetected: false,
        notes: [],
      } as never,
      {} as never,
      g as never,
    ) as { output: { facts: unknown[]; injectionDetected: boolean } };
    expect(r.output.facts).toHaveLength(1);
    expect(r.output.injectionDetected).toBe(true);
  });
  it("every contract forbids external actions and lists no tier 3/4 tools except the operator", () => {
    for (const [role, c] of Object.entries(CONTRACTS)) {
      expect(c.disallowedActions.length).toBeGreaterThan(0);
      if (role !== "ads_operator") expect(c.allowedTools).not.toContain("execute_approved_ad_action");
      expect(c.maxSteps).toBeLessThanOrEqual(3);
    }
  });
});
