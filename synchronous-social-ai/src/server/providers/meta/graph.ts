import { ProviderError } from "../errors";

export interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
    is_transient?: boolean;
  };
}

/**
 * Map a Meta Graph API error to a ProviderError kind.
 * Codes per Meta "Handle Errors" docs: 190 OAuthException (token), 10 & 200–299 permissions,
 * 4/17/32/613/80001–80014 throttling, 1/2 temporary, 100 invalid parameter, 368 policy block.
 */
export function mapGraphError(status: number, body: GraphErrorBody, provider = "meta"): ProviderError {
  const e = body.error ?? {};
  const code = e.code ?? 0;
  const meta = { status, code, subcode: e.error_subcode, traceId: e.fbtrace_id };
  const msg =
    `${e.type ?? "GraphError"} ${code}${e.error_subcode ? `/${e.error_subcode}` : ""}: ${e.message ?? "unknown"}`.slice(
      0,
      500,
    );
  if (code === 190 || code === 102 || code === 463 || code === 467)
    return new ProviderError("auth", provider, msg, meta);
  if (code === 10 || (code >= 200 && code <= 299) || code === 3)
    return new ProviderError("permission", provider, msg, meta);
  if ([4, 17, 32, 613].includes(code) || (code >= 80001 && code <= 80014))
    return new ProviderError("rate_limit", provider, msg, { ...meta, retryAfterMs: 15 * 60_000 });
  if (code === 368 || code === 2207051) return new ProviderError("policy", provider, msg, meta);
  if (code === 803 || status === 404) return new ProviderError("not_found", provider, msg, meta);
  if (code === 1 || code === 2 || e.is_transient || status >= 500)
    return new ProviderError("transient", provider, msg, meta);
  return new ProviderError("invalid", provider, msg, meta);
}

export interface GraphRequest {
  method: "GET" | "POST" | "DELETE";
  url: string;
  token: string;
  params?: Record<string, string | number | boolean | undefined>;
  /** Mutations that fail at the network layer have an unknown outcome. */
  mutation?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function graphCall<T>(req: GraphRequest, provider = "meta"): Promise<T> {
  const f = req.fetchImpl ?? fetch;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.params ?? {})) if (v !== undefined) params.set(k, String(v));
  const url =
    req.method === "GET" || req.method === "DELETE"
      ? `${req.url}${params.size ? `?${params}` : ""}`
      : req.url;
  let res: Response;
  try {
    res = await f(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${req.token}`,
        ...(req.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: req.method === "POST" ? params.toString() : undefined,
      signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new ProviderError(
      req.mutation ? "unknown_outcome" : "transient",
      provider,
      `Network error: ${(e as Error).message}`,
    );
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    if (!res.ok)
      throw new ProviderError(
        res.status >= 500 ? (req.mutation ? "unknown_outcome" : "transient") : "invalid",
        provider,
        `HTTP ${res.status}`,
      );
  }
  if (!res.ok || (body as GraphErrorBody)?.error) {
    const err = mapGraphError(res.status, (body ?? {}) as GraphErrorBody, provider);
    // A 5xx on a mutation may still have succeeded on Meta's side.
    if (req.mutation && err.kind === "transient")
      throw new ProviderError("unknown_outcome", provider, err.message, err.meta);
    throw err;
  }
  return body as T;
}
