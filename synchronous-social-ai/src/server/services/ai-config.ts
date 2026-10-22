import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit/audit";
import type { Ctx } from "../context";
import { requirePermission, requireUser } from "../context";
import type { Tx } from "../db/client";
import * as s from "../db/schema";
import type { WorkspaceAiSettings } from "../db/schema";
import { env } from "../env";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { AppError } from "../lib/errors";

/**
 * Owner-managed AI configuration per workspace: gateway URL + key, models, image provider, prices and
 * Higgsfield keys. Anything not set falls back to the server environment, so a workspace works out of
 * the box and the owner can override only what they need.
 */

export const AI_SECRET_KEYS = ["llm_api_key", "higgsfield_key_id", "higgsfield_key_secret"] as const;
export type AiSecretKey = (typeof AI_SECRET_KEYS)[number];
const SECRET_LABELS: Record<AiSecretKey, string> = {
  llm_api_key: "AI gateway key",
  higgsfield_key_id: "Higgsfield key ID",
  higgsfield_key_secret: "Higgsfield key secret",
};

const modelId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:/@-]+$/, "Model IDs may contain letters, numbers and . _ : / @ -");

const price = z.object({ input: z.number().min(0).max(10_000), output: z.number().min(0).max(10_000) });

export const aiSettingsInput = z.object({
  /** Empty string = use the server default. */
  llmBaseUrl: z.string().trim().max(300).optional(),
  defaultModel: modelId.or(z.literal("")).optional(),
  fastModel: modelId.or(z.literal("")).optional(),
  imageModel: modelId.or(z.literal("")).optional(),
  imageProvider: z.enum(["auto", "higgsfield", "gateway", "off"]).optional(),
  prices: z.record(modelId, price).optional(),
  imagePriceUsd: z.number().min(0).max(100).nullable().optional(),
  /** New value sets the key, null removes it, omitted leaves it unchanged. Values are never returned. */
  secrets: z.partialRecord(z.enum(AI_SECRET_KEYS), z.string().trim().min(8).max(500).nullable()).optional(),
});
export type AiSettingsInput = z.infer<typeof aiSettingsInput>;

export const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
export const DEFAULT_IMAGE_PRICE_USD = 0.04;

export interface EffectiveAiConfig {
  llm: { baseUrl: string; apiKey: string | null; keySource: "workspace" | "server" | "none" };
  models: { default: string; fast: string; image: string };
  imageProvider: NonNullable<WorkspaceAiSettings["imageProvider"]>;
  prices: Record<string, { input: number; output: number }>;
  imagePriceUsd: number;
  higgsfield: { keyId: string; keySecret: string; source: "workspace" | "server" } | null;
}

// ───────────────────────────── Gateway URL safety (SSRF) ─────────────────────────────

function privateIp(ip: string) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
  return (
    v === "::" ||
    v === "::1" ||
    v.startsWith("fc") ||
    v.startsWith("fd") ||
    v.startsWith("fe8") ||
    v.startsWith("fe9") ||
    v.startsWith("fea") ||
    v.startsWith("feb")
  );
}

/**
 * The server sends the workspace's API key to this URL, so it must be a public HTTPS endpoint.
 * Development allows http://localhost for local gateways. Checked on save and before every test call.
 */
export async function assertSafeGatewayUrl(
  raw: string,
  resolve: (h: string) => Promise<string[]> = defaultResolve,
) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("VALIDATION_FAILED", "Gateway URL is not a valid URL");
  }
  const dev = !env().isProductionLike;
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
  if (dev && local && (u.protocol === "http:" || u.protocol === "https:"))
    return u.toString().replace(/\/$/, "");
  if (u.protocol !== "https:") throw new AppError("VALIDATION_FAILED", "Gateway URL must use https");
  if (u.username || u.password)
    throw new AppError("VALIDATION_FAILED", "Gateway URL must not contain credentials");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (!addrs.length) throw new AppError("VALIDATION_FAILED", `Could not resolve ${host}`);
  if (addrs.some(privateIp))
    throw new AppError("VALIDATION_FAILED", "Gateway URL points to a private or internal network address");
  return u.toString().replace(/\/$/, "");
}

async function defaultResolve(host: string) {
  return (await lookup(host, { all: true })).map((a) => a.address);
}

// ───────────────────────────── Secrets ─────────────────────────────

async function secretRows(tx: Tx, workspaceId: string) {
  return tx.select().from(s.workspaceSecrets).where(eq(s.workspaceSecrets.workspaceId, workspaceId));
}

async function aiSettingsOf(tx: Tx, workspaceId: string): Promise<WorkspaceAiSettings> {
  const ws = (await tx.select().from(s.workspaces).where(eq(s.workspaces.id, workspaceId)).limit(1))[0];
  return ws?.settings.ai ?? {};
}

/** Effective configuration for a workspace: workspace values first, then server environment. */
export async function resolveAiConfig(ctx: Pick<Ctx, "tx" | "workspaceId">): Promise<EffectiveAiConfig> {
  const e = env();
  const ai = await aiSettingsOf(ctx.tx, ctx.workspaceId);
  const secrets = new Map(
    (await secretRows(ctx.tx, ctx.workspaceId)).map((r) => [
      r.key as AiSecretKey,
      decryptSecret(r.encryptedValue),
    ]),
  );
  const wsKey = secrets.get("llm_api_key");
  const hfId = secrets.get("higgsfield_key_id");
  const hfSecret = secrets.get("higgsfield_key_secret");
  return {
    llm: {
      baseUrl: (ai.llmBaseUrl || e.LLM_BASE_URL).replace(/\/$/, ""),
      apiKey: wsKey ?? e.LLM_API_KEY ?? null,
      keySource: wsKey ? "workspace" : e.LLM_API_KEY ? "server" : "none",
    },
    models: {
      default: ai.defaultModel || e.LLM_MODEL_DEFAULT,
      fast: ai.fastModel || e.LLM_MODEL_FAST,
      image: ai.imageModel || DEFAULT_IMAGE_MODEL,
    },
    imageProvider: ai.imageProvider ?? "auto",
    prices: ai.prices ?? {},
    imagePriceUsd: ai.imagePriceUsd ?? DEFAULT_IMAGE_PRICE_USD,
    higgsfield:
      hfId && hfSecret
        ? { keyId: hfId, keySecret: hfSecret, source: "workspace" }
        : e.HIGGSFIELD_API_KEY_ID && e.HIGGSFIELD_API_KEY_SECRET
          ? { keyId: e.HIGGSFIELD_API_KEY_ID, keySecret: e.HIGGSFIELD_API_KEY_SECRET, source: "server" }
          : null,
  };
}

/** Owner view: settings plus which keys are saved (last 4 characters only) and the server defaults. */
export async function getAiSettings(ctx: Ctx) {
  requirePermission(ctx, "ai.configure");
  const e = env();
  const ai = await aiSettingsOf(ctx.tx, ctx.workspaceId);
  const rows = await secretRows(ctx.tx, ctx.workspaceId);
  const eff = await resolveAiConfig(ctx);
  return {
    settings: ai,
    secrets: Object.fromEntries(
      AI_SECRET_KEYS.map((k) => {
        const r = rows.find((x) => x.key === k);
        return [k, r ? { saved: true, hint: r.hint, updatedAt: r.updatedAt } : { saved: false }];
      }),
    ) as Record<AiSecretKey, { saved: boolean; hint?: string; updatedAt?: Date }>,
    serverDefaults: {
      llmBaseUrl: e.LLM_BASE_URL,
      defaultModel: e.LLM_MODEL_DEFAULT,
      fastModel: e.LLM_MODEL_FAST,
      imageModel: DEFAULT_IMAGE_MODEL,
      imagePriceUsd: DEFAULT_IMAGE_PRICE_USD,
      hasServerLlmKey: Boolean(e.LLM_API_KEY),
      hasServerHiggsfield: Boolean(e.HIGGSFIELD_API_KEY_ID && e.HIGGSFIELD_API_KEY_SECRET),
    },
    effective: {
      llmBaseUrl: eff.llm.baseUrl,
      keySource: eff.llm.keySource,
      models: eff.models,
      imageProvider: eff.imageProvider,
      higgsfieldSource: eff.higgsfield?.source ?? "none",
    },
  };
}

export async function updateAiSettings(ctx: Ctx, raw: z.input<typeof aiSettingsInput>) {
  requirePermission(ctx, "ai.configure");
  const userId = requireUser(ctx);
  const input = aiSettingsInput.parse(raw);
  const ws = (
    await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1)
  )[0]!;
  const prev = ws.settings.ai ?? {};
  const next: WorkspaceAiSettings = { ...prev };
  const setOrClear = <K extends keyof WorkspaceAiSettings>(
    k: K,
    v: WorkspaceAiSettings[K] | "" | null | undefined,
  ) => {
    if (v === undefined) return;
    if (v === "" || v === null) delete next[k];
    else next[k] = v as WorkspaceAiSettings[K];
  };
  if (input.llmBaseUrl !== undefined)
    setOrClear("llmBaseUrl", input.llmBaseUrl ? await assertSafeGatewayUrl(input.llmBaseUrl) : "");
  setOrClear("defaultModel", input.defaultModel);
  setOrClear("fastModel", input.fastModel);
  setOrClear("imageModel", input.imageModel);
  setOrClear("imageProvider", input.imageProvider);
  setOrClear("imagePriceUsd", input.imagePriceUsd);
  if (input.prices !== undefined) next.prices = input.prices;
  await ctx.tx
    .update(s.workspaces)
    .set({ settings: { ...ws.settings, ai: next } })
    .where(eq(s.workspaces.id, ctx.workspaceId));

  const changedSecrets: Record<string, "set" | "removed"> = {};
  for (const [key, value] of Object.entries(input.secrets ?? {}) as Array<[AiSecretKey, string | null]>) {
    if (value === null) {
      await ctx.tx
        .delete(s.workspaceSecrets)
        .where(and(eq(s.workspaceSecrets.workspaceId, ctx.workspaceId), eq(s.workspaceSecrets.key, key)));
      changedSecrets[key] = "removed";
      continue;
    }
    await ctx.tx
      .insert(s.workspaceSecrets)
      .values({
        workspaceId: ctx.workspaceId,
        key,
        encryptedValue: encryptSecret(value),
        hint: value.slice(-4),
        updatedBy: userId,
      })
      .onConflictDoUpdate({
        target: [s.workspaceSecrets.workspaceId, s.workspaceSecrets.key],
        set: {
          encryptedValue: encryptSecret(value),
          hint: value.slice(-4),
          updatedBy: userId,
          updatedAt: new Date(),
        },
      });
    changedSecrets[key] = "set";
  }
  // Audit what changed — never the secret values.
  await audit(ctx, {
    action: "ai.settings_updated",
    targetType: "workspace",
    targetId: ctx.workspaceId,
    metadata: {
      before: prev,
      after: next,
      // Labels only (the redactor hides any field named like a secret, which would hide what changed).
      keysChanged: Object.entries(changedSecrets).map(([k, v]) => `${SECRET_LABELS[k as AiSecretKey]}: ${v}`),
    },
  });
  return getAiSettings(ctx);
}

// ───────────────────────────── Gateway discovery ─────────────────────────────

export interface GatewayModel {
  id: string;
  structuredOutput: boolean;
  emitsImages: boolean;
  contextTokens: number | null;
  /** USD per 1M tokens, when the gateway publishes it. */
  price: { input: number; output: number } | null;
}

/** Parse an OpenAI-compatible /models listing, including Experiential Labs pricing fields. */
export function parseGatewayModels(body: unknown): GatewayModel[] {
  const arr = Array.isArray(body) ? body : ((body as { data?: unknown[] })?.data ?? []);
  const out: GatewayModel[] = [];
  for (const m of arr as Array<Record<string, unknown>>) {
    if (typeof m?.id !== "string") continue;
    const p = (m.pricing ?? {}) as Record<string, unknown>;
    const nano = (k: string) => (typeof p[k] === "number" ? (p[k] as number) / 1e9 : null);
    const usd = (k: string) => (typeof m[k] === "number" ? (m[k] as number) : null);
    const input = nano("input_nano_usd_per_million_tokens") ?? usd("input_cost_per_million_tokens_usd");
    const output = nano("output_nano_usd_per_million_tokens") ?? usd("output_cost_per_million_tokens_usd");
    out.push({
      id: m.id,
      structuredOutput: m.supports_structured_output !== false,
      emitsImages: m.emits_images === true || m.supports_image_generation === true,
      contextTokens: typeof m.context_window_tokens === "number" ? m.context_window_tokens : null,
      price: input !== null && output !== null ? { input, output } : null,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Check the gateway with the saved (or a just-typed, unsaved) URL and key, and return its models and
 * prices so the owner can pick from a list. Nothing is stored here.
 */
export async function testGateway(
  ctx: Ctx,
  override: { llmBaseUrl?: string; apiKey?: string } = {},
  fetchImpl: typeof fetch = fetch,
) {
  requirePermission(ctx, "ai.configure");
  const eff = await resolveAiConfig(ctx);
  const baseUrl = await assertSafeGatewayUrl(override.llmBaseUrl || eff.llm.baseUrl);
  const apiKey = override.apiKey || eff.llm.apiKey;
  if (!apiKey) throw new AppError("VALIDATION_FAILED", "Add an API key first");
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch (e) {
    throw new AppError(
      "PROVIDER_ERROR",
      `Could not reach the gateway: ${(e as Error).message}`.slice(0, 300),
    );
  }
  if (res.status === 401 || res.status === 403)
    throw new AppError("PROVIDER_ERROR", "The gateway rejected the API key");
  if (!res.ok) throw new AppError("PROVIDER_ERROR", `Gateway returned HTTP ${res.status}`);
  const models = parseGatewayModels(await res.json().catch(() => null));
  return { ok: true, latencyMs: Date.now() - started, baseUrl, count: models.length, models };
}
