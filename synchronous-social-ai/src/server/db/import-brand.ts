/**
 * Create a real (non-demo) workspace from a brand pack and fill its Company Brain:
 * profile, services catalog, website facts (each linked to the page it came from), brand rules,
 * the link allowlist, and the website pages themselves as searchable knowledge sources.
 *
 *   BRAND_EMAIL=you@company.com npm run brand:import -- seeds/brands/sutra-services.json
 *
 * BRAND_PASSWORD is optional: without it a strong password is generated and printed once.
 *
 * If the user already exists, a new workspace is added to their account. Website pages are fetched
 * live; a page that cannot be fetched is skipped (and reported), never invented.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import "../register";
import { closeDb } from "./client";
import { withSystem, withTenant } from "./tenant";
import * as s from "./schema";
import { createLogger } from "../lib/logger";
import type { Ctx } from "../context";
import { createAdditionalWorkspace, signup } from "../services/workspace";
import {
  addAllowedDomain,
  addBrandRule,
  addFact,
  brandRuleSchema,
  companyProfileSchema,
  FACT_CATEGORIES,
  updateProfile,
  upsertProduct,
} from "../services/company-brain";
import { addTextSource, extractText } from "../services/knowledge";

const packSchema = z.object({
  workspace: z.object({
    name: z.string().min(1),
    timezone: z.string(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  profile: companyProfileSchema,
  allowedDomains: z.array(z.string()).default([]),
  services: z
    .array(
      z.object({
        name: z.string(),
        url: z.url().optional(),
        description: z.string().optional(),
        keywords: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  facts: z
    .array(
      z.object({
        category: z.enum(FACT_CATEGORIES),
        key: z.string(),
        value: z.string(),
        page: z.string().optional(),
      }),
    )
    .default([]),
  brandRules: z.array(brandRuleSchema).default([]),
  sources: z.array(z.string()).default([]),
});

const PLACEHOLDERS = new Set(["your-own-password-here", "choose-12+-chars", "at least 12 chars", "…", "..."]);

/** Keep the page's <main> content (drops navigation and footer) when the page has one. */
function mainHtml(html: string) {
  const m = html.match(/<main[\s\S]*?<\/main>/i);
  return m ? m[0] : html;
}

async function fetchPage(url: string) {
  const res = await fetch(url, {
    headers: { "User-Agent": "SynchronousSocialAI-BrandImport/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? url).replace(/&amp;/g, "&").trim();
  const text = (await extractText(Buffer.from(mainHtml(html)), "text/html"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

async function main() {
  const file = process.argv[2];
  const email = process.env.BRAND_EMAIL;
  const password = process.env.BRAND_PASSWORD;
  if (!file || !email) {
    throw new Error(
      "Usage: BRAND_EMAIL=… [BRAND_PASSWORD=…] [BRAND_OWNER_NAME=…] npm run brand:import -- <pack.json>",
    );
  }
  const pack = packSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const existing = (
    await withSystem((tx) => tx.select().from(s.users).where(eq(s.users.email, email.toLowerCase())).limit(1))
  )[0];
  let userId: string;
  let workspaceId: string;
  let generatedPassword: string | null = null;
  if (existing) {
    const ws = await createAdditionalWorkspace(existing.id, pack.workspace.name, pack.workspace.timezone);
    userId = existing.id;
    workspaceId = ws.id;
    process.stdout.write(`Existing user ${email}: added workspace "${ws.name}".\n`);
  } else {
    // No password given → generate a strong one and print it once, so nobody has to share a password.
    if (password && PLACEHOLDERS.has(password.trim().toLowerCase()))
      throw new Error("BRAND_PASSWORD is still the example placeholder. Choose your own, or leave it unset.");
    if (password && password.length < 12) throw new Error("BRAND_PASSWORD must be at least 12 characters");
    const finalPassword = password || randomBytes(18).toString("base64url");
    generatedPassword = password ? null : finalPassword;
    const r = await signup(
      {
        name: process.env.BRAND_OWNER_NAME ?? pack.workspace.name,
        email,
        password: finalPassword,
        workspaceName: pack.workspace.name,
        timezone: pack.workspace.timezone,
      },
      { ip: "brand-import" },
    );
    userId = r.user.id;
    workspaceId = r.workspace.id;
    process.stdout.write(`Created user ${email} with workspace "${r.workspace.name}".\n`);
  }
  await withSystem((tx) =>
    tx
      .update(s.workspaces)
      .set({ currency: pack.workspace.currency })
      .where(eq(s.workspaces.id, workspaceId)),
  );
  const run = <T>(fn: (ctx: Ctx) => Promise<T>) =>
    withTenant(workspaceId, (tx) =>
      fn({
        workspaceId,
        userId,
        role: "owner",
        actorType: "user",
        actorId: userId,
        correlationId: "brand-import",
        tx,
        log: createLogger({ brandImport: true }),
      }),
    );

  await run((ctx) => updateProfile(ctx, pack.profile));
  for (const d of pack.allowedDomains) await run((ctx) => addAllowedDomain(ctx, d));
  for (const svc of pack.services)
    await run((ctx) =>
      upsertProduct(ctx, {
        name: svc.name,
        url: svc.url ?? null,
        description: svc.description ?? null,
        keywords: svc.keywords,
        stockStatus: "unknown",
        priceMinor: null,
        currency: pack.workspace.currency,
      }),
    );
  for (const r of pack.brandRules) await run((ctx) => addBrandRule(ctx, r));

  // Website pages → knowledge sources (searchable by agents, cited by facts).
  const base = pack.profile.website;
  const sourceByPage = new Map<string, string>();
  const skipped: string[] = [];
  if (base) {
    for (const page of pack.sources) {
      const url = new URL(page, base).toString();
      try {
        const { title, text } = await fetchPage(url);
        if (!text) throw new Error("empty page");
        const src = await run((ctx) =>
          addTextSource(ctx, `Website: ${title} (${new URL(url).pathname})`, `Source: ${url}\n\n${text}`),
        );
        sourceByPage.set(page, src.id);
      } catch (e) {
        skipped.push(`${url} (${(e as Error).message})`);
      }
    }
  }

  // Facts quoted from the owner's own website are approved; each links to its page when available.
  let facts = 0;
  for (const f of pack.facts) {
    await run((ctx) =>
      addFact(
        ctx,
        {
          category: f.category,
          key: f.key,
          value: f.value,
          sourceId: f.page ? (sourceByPage.get(f.page) ?? null) : null,
          sourceExcerpt: f.page && base ? `From ${new URL(f.page, base).toString()}` : null,
        },
        { origin: "user", status: "approved" },
      ),
    );
    facts++;
  }

  process.stdout.write(
    [
      `Company Brain filled for "${pack.workspace.name}":`,
      `  profile ✓, ${pack.services.length} services, ${facts} facts, ${pack.brandRules.length} brand rules, ${pack.allowedDomains.length} allowed domain(s)`,
      `  ${sourceByPage.size}/${pack.sources.length} website pages added as knowledge sources`,
      ...(skipped.length ? [`  skipped: ${skipped.join("; ")}`] : []),
      ...(generatedPassword
        ? [
            "",
            `Sign in as ${email} with this generated password (shown once, not stored anywhere else):`,
            `  ${generatedPassword}`,
            "Change it after signing in if you like.",
          ]
        : []),
      "",
    ].join("\n"),
  );
}

main()
  .catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
