import { hmacSha256, safeEqual } from "./crypto";

/** Meta X-Hub-Signature-256: "sha256=" + hex HMAC-SHA256(app secret, raw request body). */
export function verifyMetaSignature(raw: string, header: string | null, secret: string | undefined) {
  if (!secret || !header?.startsWith("sha256=")) return false;
  return safeEqual(header.slice(7), hmacSha256(secret, raw));
}
