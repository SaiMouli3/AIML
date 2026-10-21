"use client";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown,
    readonly status: number,
    readonly correlationId?: string,
  ) {
    super(message);
  }
  /** Human-readable detail lines (validation issues or blocking reasons). */
  get lines(): string[] {
    if (Array.isArray(this.details)) return this.details.map((d) => (typeof d === "string" ? d : `${d.path ? `${d.path}: ` : ""}${d.message ?? JSON.stringify(d)}`));
    return [];
  }
}

/** Fetch wrapper for /api/v1: JSON, CSRF header, stable error contract. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? (init.body || init.form ? "POST" : "GET"),
    headers: { "x-ssa-csrf": "1", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    credentials: "same-origin",
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(e.code ?? "INTERNAL", e.message ?? `Request failed (${res.status})`, e.details, res.status, json?.correlationId);
  }
  return json as T;
}
