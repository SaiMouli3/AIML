/**
 * Demo/dev seed. Creates a workspace flagged `is_demo` (the UI shows a DEMO banner) with fictional
 * company data, mock integrations and drafts. It never creates performance metrics.
 * Refuses to run in staging/production.
 */
import { eq } from "drizzle-orm";
import "../register";
import { closeDb } from "./client";
import { withSystem, withTenant } from "./tenant";
import * as s from "./schema";
import { env } from "../env";
import { createLogger } from "../lib/logger";
import type { Ctx } from "../context";
import { signup } from "../services/workspace";
import {
  addAllowedDomain,
  addBrandRule,
  addFact,
  updateProfile,
  upsertProduct,
} from "../services/company-brain";
import { connectMockAccount } from "../services/integrations";
import { createContent } from "../services/content";
import { createRule } from "../services/automations";
import { createPromotionFromRequest } from "../services/promotions";

async function main() {
  if (env().isProductionLike) throw new Error("Refusing to seed demo data in staging/production");
  const email = process.env.SEED_EMAIL ?? "demo@lumen.example";
  const password = process.env.SEED_PASSWORD ?? "demo password 123";
  const existing = await withSystem((tx) =>
    tx.select().from(s.users).where(eq(s.users.email, email)).limit(1),
  );
  if (existing[0]) {
    process.stdout.write(`Seed user ${email} already exists — nothing to do.\n`);
    return;
  }
  const { user, workspace } = await signup(
    {
      name: "Demo Owner",
      email,
      password,
      workspaceName: "Lumen Candle Co (Demo)",
      timezone: "Asia/Kolkata",
    },
    { ip: "seed" },
  );
  await withSystem((tx) =>
    tx
      .update(s.workspaces)
      .set({ isDemo: true, monthlyAdSpendCapMinor: 500000, currency: "INR" })
      .where(eq(s.workspaces.id, workspace.id)),
  );
  const run = <T>(fn: (ctx: Ctx) => Promise<T>) =>
    withTenant(workspace.id, (tx) =>
      fn({
        workspaceId: workspace.id,
        userId: user.id,
        role: "owner",
        actorType: "user",
        actorId: user.id,
        correlationId: "seed",
        tx,
        log: createLogger({ seed: true }),
      }),
    );
  await run((ctx) =>
    updateProfile(ctx, {
      name: "Lumen Candle Co (Demo)",
      website: "https://lumen.example.com",
      description: "Fictional demo brand: hand-poured soy candles made in small batches.",
      industry: "Home fragrance",
      markets: ["India"],
      customerSegments: ["Gift buyers", "Home decor enthusiasts"],
      objectives: ["Grow online orders", "Build a repeat-customer base"],
      differentiators: ["Natural soy wax", "Cotton wicks"],
      brandVoice: {
        tone: "Warm, calm, plain-spoken",
        do: ["Describe scent notes concretely"],
        dont: ["Overclaim health benefits"],
      },
      policies: "Free shipping over ₹999. 7-day returns on unused items.",
      deliveryRegions: ["India"],
      escalationContact: "support@lumen.example.com",
    }),
  );
  await run((ctx) => addAllowedDomain(ctx, "lumen.example.com"));
  const aurora = await run((ctx) =>
    upsertProduct(ctx, {
      name: "Aurora Candle",
      url: "https://lumen.example.com/aurora",
      priceMinor: 89900,
      currency: "INR",
      variants: ["Small", "Large"],
      stockStatus: "in_stock",
      deliveryPolicy: "Ships in 2 business days within India",
      keywords: ["aurora", "candle"],
    }),
  );
  await run((ctx) =>
    upsertProduct(ctx, {
      name: "Nimbus Diffuser",
      url: "https://lumen.example.com/nimbus",
      priceMinor: 149900,
      currency: "INR",
      stockStatus: "low",
      keywords: ["nimbus", "diffuser"],
    }),
  );
  await run((ctx) =>
    addFact(ctx, { category: "product", key: "Burn time (Aurora, large)", value: "Approximately 40 hours" }),
  );
  await run((ctx) => addBrandRule(ctx, { kind: "forbidden_claim", text: "cures anxiety" }));
  await run((ctx) => addBrandRule(ctx, { kind: "approved_claim", text: "100% soy wax" }));
  const ig = await run((ctx) => connectMockAccount(ctx, "instagram"));
  await run((ctx) => connectMockAccount(ctx, "meta_ads"));
  await run((ctx) =>
    createContent(ctx, {
      title: "Aurora launch post",
      format: "post",
      connectedAccountId: ig.id,
      productIds: [aurora.id],
      version: {
        caption: "Meet Aurora: 100% soy wax, hand-poured in small batches. https://lumen.example.com/aurora",
        hashtags: ["soycandle"],
        altText: "A lit amber candle on a wooden table",
      },
    }),
  );
  await run((ctx) =>
    createContent(ctx, {
      title: "Behind the pour (reel idea)",
      format: "reel",
      status: "concept",
      version: { caption: "", brief: { concept: "Hands pouring wax, wick trimming, final glow" } },
    }),
  );
  await run((ctx) =>
    createRule(ctx, {
      kind: "comment_to_dm",
      name: "LINK → Aurora product link",
      approvalMode: "approve_every",
      accountId: ig.id,
      config: { triggers: ["LINK"], allowedIntents: ["product_link", "price"], productIds: [aurora.id] },
    }),
  );
  await run((ctx) => createPromotionFromRequest(ctx, "Run 50% off on our candles for three days"));
  process.stdout.write(`Seeded demo workspace. Sign in as ${email} / ${password}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
