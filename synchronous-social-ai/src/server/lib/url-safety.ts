/**
 * URL validation for links placed in public replies, DMs and ads. Only https URLs on a workspace's
 * approved domains are allowed; IP literals, credentials, odd ports and URL shorteners are rejected.
 */
const SHORTENERS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
]);

export interface UrlCheck {
  ok: boolean;
  reason?: string;
  normalized?: string;
  host?: string;
}

export function normalizeDomain(d: string): string {
  return d
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

export function checkUrl(raw: string, allowedDomains: string[]): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "Only https links are allowed" };
  if (u.username || u.password)
    return { ok: false, reason: "Links with embedded credentials are not allowed" };
  if (u.port && u.port !== "443") return { ok: false, reason: "Non-standard ports are not allowed" };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[")) {
    return { ok: false, reason: "IP address links are not allowed" };
  }
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "Internal hostnames are not allowed" };
  }
  if (/xn--/.test(host)) return { ok: false, reason: "Punycode domains require manual review" };
  const bare = host.replace(/^www\./, "");
  if (SHORTENERS.has(bare)) return { ok: false, reason: "URL shorteners are not allowed" };
  const allowed = allowedDomains.map(normalizeDomain).some((d) => bare === d || bare.endsWith(`.${d}`));
  if (!allowed) return { ok: false, reason: `Domain ${bare} is not on the approved link allowlist` };
  return { ok: true, normalized: u.toString(), host: bare };
}

/** Extract every URL-looking token from free text (model output, templates). */
export function extractUrls(text: string): string[] {
  return [...text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi)].map((m) =>
    m[0].startsWith("www.") ? `https://${m[0]}` : m[0].replace(/[.,!?;:]+$/, ""),
  );
}

/** Validate every URL in a piece of text. Returns the failing URLs with reasons. */
export function findUnsafeUrls(
  text: string,
  allowedDomains: string[],
): Array<{ url: string; reason: string }> {
  return extractUrls(text)
    .map((url) => ({ url, check: checkUrl(url, allowedDomains) }))
    .filter((r) => !r.check.ok)
    .map((r) => ({ url: r.url, reason: r.check.reason ?? "Rejected" }));
}
