/** Stable error codes returned to clients. Never include raw provider errors or secrets in `message`. */
export const ErrorCodes = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  APPROVAL_REQUIRED: 409,
  APPROVAL_INVALIDATED: 409,
  POLICY_BLOCKED: 403,
  KILL_SWITCH_ACTIVE: 423,
  SPEND_CAP_EXCEEDED: 403,
  BUDGET_EXCEEDED: 402,
  INTEGRATION_NOT_CONNECTED: 424,
  CAPABILITY_UNAVAILABLE: 424,
  PROVIDER_ERROR: 502,
  NEEDS_INPUT: 422,
  CSRF_FAILED: 403,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = ErrorCodes[code];
    this.details = details;
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

export function assertFound<T>(value: T | undefined | null, what = "Resource"): T {
  if (value === undefined || value === null) throw new AppError("NOT_FOUND", `${what} not found`);
  return value;
}
