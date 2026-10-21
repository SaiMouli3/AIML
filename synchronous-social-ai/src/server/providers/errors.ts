/**
 * Provider error taxonomy. Adapters map raw provider errors into these kinds; raw messages are kept
 * server-side (redacted) and never returned to clients verbatim.
 */
export type ProviderErrorKind =
  | "auth" // token expired/revoked → mark account, do not retry
  | "permission" // missing scope / feature not approved → do not retry
  | "rate_limit" // retry later
  | "transient" // provider 5xx / temporary → retry with backoff
  | "invalid" // bad request → do not retry
  | "policy" // blocked by platform policy / moderation → do not retry
  | "not_found"
  | "unknown_outcome"; // network failure during a mutation → reconcile before any retry

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly provider: string,
    message: string,
    readonly meta: { status?: number; code?: number | string; subcode?: number; traceId?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }
  get retryable() {
    return this.kind === "rate_limit" || this.kind === "transient";
  }
  /** Safe message for UI/API responses. */
  get publicMessage() {
    const map: Record<ProviderErrorKind, string> = {
      auth: "The connected account's access token is expired or revoked. Reconnect the account.",
      permission: "The connected account lacks a required permission or feature access.",
      rate_limit: "The provider rate limit was reached. The action will be retried later.",
      transient: "The provider is temporarily unavailable.",
      invalid: "The provider rejected the request as invalid.",
      policy: "The provider blocked this action under its platform policies.",
      not_found: "The provider could not find the referenced object.",
      unknown_outcome: "The provider outcome is uncertain. Reconciliation is required before retrying.",
    };
    return map[this.kind];
  }
}

export const isProviderError = (e: unknown): e is ProviderError => e instanceof ProviderError;
