import { z } from "zod";
import { INTENTS } from "../agents/contracts";

/** Placeholders allowed in reply templates. Values are filled from verified tenant data only. */
export const TEMPLATE_PLACEHOLDERS = ["username", "product_name", "product_url", "price", "variants", "stock", "delivery", "offer", "offer_end"] as const;

export const commentToDmConfigSchema = z.object({
  triggers: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  allowedIntents: z.array(z.enum(INTENTS)).min(1).max(10),
  productIds: z.array(z.uuid()).max(50).default([]),
  sendPublicReply: z.boolean().default(true),
  sendPrivateReply: z.boolean().default(true),
  publicReplyTemplate: z.string().max(300).default("Thanks @{username}! We've sent you the details in a private message."),
  privateReplyTemplate: z.string().max(1000).default("Hi @{username}! Here's {product_name}: {product_url}"),
  limits: z
    .object({
      maxPerHour: z.number().int().min(1).max(500).default(30),
      maxPerDay: z.number().int().min(1).max(5000).default(200),
      perUserCooldownHours: z.number().int().min(1).max(168).default(24),
    })
    .default({ maxPerHour: 30, maxPerDay: 200, perUserCooldownHours: 24 }),
  minConfidence: z.number().min(0.5).max(1).default(0.8),
  schedule: z
    .object({
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
      startHour: z.number().int().min(0).max(23).default(0),
      endHour: z.number().int().min(1).max(24).default(24),
    })
    .default({ days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 }),
  escalation: z
    .object({
      complaints: z.literal(true).default(true),
      ambiguousProduct: z.literal(true).default(true),
      missingPriceOrStock: z.literal(true).default(true),
      lowConfidence: z.literal(true).default(true),
    })
    .default({ complaints: true, ambiguousProduct: true, missingPriceOrStock: true, lowConfidence: true }),
});
export type CommentToDmConfig = z.infer<typeof commentToDmConfigSchema>;

export function templatePlaceholders(t: string): string[] {
  return [...t.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!);
}

export function renderTemplate(t: string, values: Partial<Record<(typeof TEMPLATE_PLACEHOLDERS)[number], string | null | undefined>>) {
  const missing: string[] = [];
  const text = t.replace(/\{([a-z_]+)\}/g, (_, k: string) => {
    const v = values[k as keyof typeof values];
    if (v === undefined || v === null || v === "") {
      missing.push(k);
      return "";
    }
    return v;
  });
  return { text: text.replace(/[ \t]{2,}/g, " ").trim(), missing };
}

/** Is `now` inside the rule's weekly schedule, evaluated in the rule's timezone? */
export function withinSchedule(cfg: CommentToDmConfig, timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")!.value);
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  return cfg.schedule.days.includes(wd) && hour >= cfg.schedule.startHour && hour < cfg.schedule.endHour;
}

export function triggerMatches(cfg: CommentToDmConfig, text: string) {
  if (!cfg.triggers.length) return true;
  const t = text.toLowerCase();
  return cfg.triggers.some((tr) => new RegExp(`(^|[^\\p{L}\\p{N}])${tr.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(t));
}
