/**
 * PII and secret redaction for logs, traces and audit metadata.
 * Keys that look sensitive are replaced entirely; string values are scrubbed for
 * tokens, signed URL signatures, emails and phone numbers.
 */
const SENSITIVE_KEY =
  /(pass(word)?|secret|token|authorization|cookie|api[-_]?key|access[-_]?key|signature|sig|session|credential|private[-_]?key|encrypted)/i;

const PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Key)\s+[A-Za-z0-9._:\-]{8,}/g, "$1 [REDACTED]"],
  [/\bxpl_[A-Za-z0-9]{8,}\b/g, "[REDACTED_KEY]"],
  [/\b(EAA|IGQ|IGA)[A-Za-z0-9]{20,}\b/g, "[REDACTED_TOKEN]"],
  [/([?&](sig|signature|X-Amz-Signature|X-Amz-Credential|access_token|token)=)[^&\s"]+/gi, "$1[REDACTED]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]"],
  // Phone numbers, but not digit runs inside identifiers such as UUIDs.
  [/(?<![\w-])\+?\d[\d\s().-]{8,}\d(?![\w-])/g, "[PHONE]"],
];

export function redactString(value: string): string {
  let out = value;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
  }
  return out;
}
