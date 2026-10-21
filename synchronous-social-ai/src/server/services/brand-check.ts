import { findUnsafeUrls } from "../lib/url-safety";
import { detectInjection } from "../lib/injection";

export type Severity = "block" | "warning" | "info";
export interface Finding {
  severity: Severity;
  code: string;
  message: string;
}
export interface BrandCheckResult {
  status: "pass" | "warning" | "block";
  findings: Finding[];
  checkedAt: string;
}

export interface BrandCheckInput {
  caption: string;
  cta?: string | null;
  altText?: string | null;
  hashtags: string[];
  format: "post" | "carousel" | "story" | "reel";
  media: Array<{ kind: string; mimeType: string; width?: number | null; height?: number | null }>;
  rules: Array<{ kind: string; text: string }>;
  allowedDomains: string[];
  products: Array<{ name: string; priceMinor: number | null; currency: string | null }>;
  promotion?: { discountType: string | null; discountValue: string | number | null; endsAt: Date | null } | null;
}

const RISKY_CLAIMS = [/\bguarantee(d|s)?\b/i, /\b(best|#1|number one) in\b/i, /\bcure[sd]?\b/i, /\b100% (safe|effective|natural)\b/i, /\brisk[- ]free\b/i, /\bclinically proven\b/i, /\bonly \d+ left\b/i, /\blast chance\b/i];

const fmtMinor = (minor: number) => (minor / 100).toFixed(2).replace(/\.00$/, "");

/**
 * Deterministic compliance checks (the compliance_reviewer's non-LLM layer). Blocks cannot be overridden
 * by content-generation agents; they must be fixed in the content.
 */
export function runBrandCheck(i: BrandCheckInput): BrandCheckResult {
  const findings: Finding[] = [];
  const text = [i.caption, i.cta ?? "", i.hashtags.map((h) => `#${h}`).join(" ")].join("\n");
  const lower = text.toLowerCase();

  if (i.caption.length > 2200) findings.push({ severity: "block", code: "caption_too_long", message: `Caption is ${i.caption.length} characters; Instagram allows 2,200.` });
  if (i.hashtags.length > 30) findings.push({ severity: "block", code: "too_many_hashtags", message: "Instagram allows at most 30 hashtags." });
  if (!i.caption.trim() && i.format !== "story") findings.push({ severity: "warning", code: "empty_caption", message: "Caption is empty." });

  for (const r of i.rules) {
    const needle = r.text.toLowerCase().trim();
    if (!needle) continue;
    if ((r.kind === "forbidden_word" || r.kind === "forbidden_claim") && lower.includes(needle)) {
      findings.push({ severity: "block", code: r.kind, message: `Contains forbidden ${r.kind === "forbidden_word" ? "word" : "claim"}: “${r.text}”.` });
    }
    if (r.kind === "required_disclaimer" && !lower.includes(needle)) {
      findings.push({ severity: "warning", code: "missing_disclaimer", message: `Required disclaimer missing: “${r.text}”.` });
    }
  }

  const approvedClaims = i.rules.filter((r) => r.kind === "approved_claim").map((r) => r.text.toLowerCase());
  for (const re of RISKY_CLAIMS) {
    const m = text.match(re);
    if (m && !approvedClaims.some((c) => c.includes(m[0].toLowerCase()))) {
      findings.push({ severity: "warning", code: "unsubstantiated_claim", message: `“${m[0]}” is not an approved claim. Remove it or add substantiation.` });
    }
  }

  for (const u of findUnsafeUrls(text, i.allowedDomains)) {
    findings.push({ severity: "block", code: "unapproved_link", message: `${u.url}: ${u.reason}.` });
  }

  // Prices mentioned must match the approved catalog.
  const priceMentions = [...text.matchAll(/(?:[$€£₹]\s?)(\d+(?:[.,]\d{1,2})?)/g)].map((m) => m[1]!.replace(",", "."));
  if (priceMentions.length) {
    const known = new Set(i.products.filter((p) => p.priceMinor != null).map((p) => fmtMinor(p.priceMinor!)));
    for (const pm of priceMentions) {
      const norm = String(Number(pm)).replace(/\.0+$/, "");
      if (![...known].some((k) => String(Number(k)) === norm)) {
        findings.push({ severity: "warning", code: "unverified_price", message: `Price ${pm} does not match any approved product price.` });
      }
    }
  }

  // Discount terms must match the linked promotion exactly.
  const percents = [...text.matchAll(/(\d{1,3})\s?%/g)].map((m) => Number(m[1]));
  if (i.promotion) {
    if (i.promotion.discountType === "percent" && i.promotion.discountValue != null) {
      const expected = Number(i.promotion.discountValue);
      for (const p of percents) if (p !== expected) findings.push({ severity: "block", code: "offer_mismatch", message: `Mentions ${p}% but the approved offer is ${expected}%.` });
      if (!percents.includes(expected)) findings.push({ severity: "warning", code: "offer_not_stated", message: `Offer value ${expected}% is not stated in the copy.` });
    }
    if (i.promotion.endsAt && /\b(no end|forever|always|permanent)\b/i.test(text)) {
      findings.push({ severity: "block", code: "offer_duration_mismatch", message: "Copy implies the offer does not end, but it has an end date." });
    }
  } else if (percents.length && /\b(off|discount|sale)\b/i.test(text)) {
    findings.push({ severity: "warning", code: "offer_without_promotion", message: "Copy mentions a discount but is not linked to an approved promotion." });
  }

  // Channel constraints (Instagram Content Publishing API).
  const images = i.media.filter((m) => m.kind === "image");
  const videos = i.media.filter((m) => m.kind === "video");
  if (i.format === "post" && i.media.length === 0) findings.push({ severity: "warning", code: "no_media", message: "Feed posts need an image before they can be published." });
  if (i.format === "post" && images.length + videos.length > 1) findings.push({ severity: "warning", code: "use_carousel", message: "Multiple assets: use the carousel format." });
  if (i.format === "carousel" && (i.media.length < 2 || i.media.length > 10)) findings.push({ severity: "warning", code: "carousel_count", message: "Carousels need 2–10 items (API supports up to 20; Instagram app shows 10)." });
  if (i.format === "reel" && videos.length !== 1) findings.push({ severity: "warning", code: "reel_needs_video", message: "Reels need exactly one video asset." });
  for (const img of images) {
    if (img.mimeType !== "image/jpeg") findings.push({ severity: "warning", code: "jpeg_required", message: "Instagram publishing accepts JPEG images only; convert before publishing." });
    if (img.width && img.height) {
      const ratio = img.width / img.height;
      if (ratio < 0.8 || ratio > 1.91) findings.push({ severity: "warning", code: "aspect_ratio", message: `Image aspect ratio ${ratio.toFixed(2)} is outside 4:5–1.91:1 and will be cropped.` });
    }
  }
  if ((i.format === "post" || i.format === "carousel") && images.length && !i.altText?.trim()) {
    findings.push({ severity: "warning", code: "missing_alt_text", message: "Add alt text for accessibility." });
  }
  if (detectInjection(text).flagged) findings.push({ severity: "warning", code: "suspicious_instructions", message: "Copy contains instruction-like text; review for prompt-injection artifacts." });

  const status = findings.some((f) => f.severity === "block") ? "block" : findings.some((f) => f.severity === "warning") ? "warning" : "pass";
  return { status, findings, checkedAt: new Date().toISOString() };
}
