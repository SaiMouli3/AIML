import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError, type ZodType } from "zod";
import { resolveSession, sessionCookieName, type SessionInfo } from "../auth/session";
import type { Ctx } from "../context";
import { withTenant } from "../db/tenant";
import { db } from "../db/client";
import { env } from "../env";
import { AppError, isAppError } from "../lib/errors";
import { newCorrelationId } from "../lib/ids";
import { createLogger } from "../lib/logger";
import { consumeRateLimit } from "../lib/rate-limit";
import { can, type Permission } from "../rbac/roles";

export const CSRF_HEADER = "x-ssa-csrf";

type Params = Record<string, string | string[] | undefined>;

interface RouteOptions<B extends ZodType | undefined, Q extends ZodType | undefined> {
  auth?: "workspace" | "user" | "none";
  permission?: Permission;
  body?: B;
  query?: Q;
  /** requests per minute per user (or IP when unauthenticated) */
  rateLimit?: number;
}

export interface RouteArgs<B, Q> {
  req: NextRequest;
  params: Params;
  body: B;
  query: Q;
  ctx: Ctx;
  session: SessionInfo | null;
  correlationId: string;
}

type Infer<T> = T extends ZodType ? z.infer<T> : undefined;

export function clientIp(req: NextRequest): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
}

export function errorResponse(e: unknown, correlationId: string) {
  if (e instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Request validation failed",
          details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        correlationId,
      },
      { status: 422, headers: { "x-correlation-id": correlationId } },
    );
  }
  if (isAppError(e)) {
    return NextResponse.json(
      { error: { code: e.code, message: e.message, details: e.details ?? null }, correlationId },
      { status: e.status, headers: { "x-correlation-id": correlationId } },
    );
  }
  createLogger({ correlationId }).error("unhandled_error", { error: e });
  return NextResponse.json(
    {
      error: {
        code: "INTERNAL",
        message: "Something went wrong. Reference the correlation ID when reporting.",
      },
      correlationId,
    },
    { status: 500, headers: { "x-correlation-id": correlationId } },
  );
}

/** CSRF: mutating requests must carry the custom header and, when present, a same-origin Origin. */
function checkCsrf(req: NextRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  if (req.headers.get(CSRF_HEADER) !== "1") throw new AppError("CSRF_FAILED", "Missing CSRF header");
  const origin = req.headers.get("origin");
  if (origin) {
    const allowed = new URL(env().APP_URL).origin;
    const self = req.nextUrl.origin;
    if (origin !== allowed && origin !== self)
      throw new AppError("CSRF_FAILED", "Cross-origin request rejected");
  }
}

/**
 * Wraps an API route: correlation IDs, CSRF, authentication, workspace membership + RBAC,
 * runtime schema validation, rate limiting, tenant-scoped transaction and stable error contracts.
 */
export function route<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined>(
  opts: RouteOptions<B, Q>,
  handler: (args: RouteArgs<Infer<B>, Infer<Q>>) => Promise<unknown>,
) {
  return async (req: NextRequest, context: { params: Promise<Params> }) => {
    const correlationId = req.headers.get("x-correlation-id")?.slice(0, 64) || newCorrelationId();
    const log = createLogger({ correlationId, method: req.method, path: req.nextUrl.pathname });
    try {
      const params = (await context.params) ?? {};
      const authMode = opts.auth ?? "workspace";
      if (authMode !== "none") checkCsrf(req);

      let session: SessionInfo | null = null;
      if (authMode !== "none") {
        session = await resolveSession(
          req.cookies.get(sessionCookieName())?.value,
          req.headers.get("x-workspace-id"),
        );
        if (!session) throw new AppError("UNAUTHENTICATED", "Sign in required");
      }

      const ip = clientIp(req);
      if (opts.rateLimit) {
        await consumeRateLimit(
          db(),
          `api:${req.nextUrl.pathname}:${session?.user.id ?? ip ?? "anon"}`,
          opts.rateLimit,
          60,
          {
            throwOnLimit: true,
          },
        );
      }

      const query = opts.query
        ? opts.query.parse(Object.fromEntries(req.nextUrl.searchParams.entries()))
        : undefined;
      let body: unknown = undefined;
      if (opts.body) {
        let raw: unknown;
        try {
          raw = await req.json();
        } catch {
          throw new AppError("VALIDATION_FAILED", "Request body must be valid JSON");
        }
        body = opts.body.parse(raw);
      }

      const run = async (ctx: Ctx) => {
        const result = await handler({
          req,
          params,
          body: body as Infer<B>,
          query: query as Infer<Q>,
          ctx,
          session,
          correlationId,
        });
        if (result instanceof Response) {
          result.headers.set("x-correlation-id", correlationId);
          return result;
        }
        return NextResponse.json(result ?? { ok: true }, { headers: { "x-correlation-id": correlationId } });
      };

      if (authMode === "workspace") {
        if (!session?.workspace || !session.role) throw new AppError("FORBIDDEN", "No workspace membership");
        if (opts.permission && !can(session.role, opts.permission)) {
          throw new AppError("FORBIDDEN", `Your role (${session.role}) does not allow ${opts.permission}`);
        }
        const s = session;
        return await withTenant(s.workspace!.id, (tx) =>
          run({
            workspaceId: s.workspace!.id,
            userId: s.user.id,
            role: s.role!,
            actorType: "user",
            actorId: s.user.id,
            correlationId,
            tx,
            log: log.child({ workspaceId: s.workspace!.id, userId: s.user.id }),
            ip,
          }),
        );
      }
      // "user" / "none" routes receive a placeholder ctx without tenant scope; they must not use ctx.tx for tenant data.
      return await db().transaction((tx) =>
        run({
          workspaceId: "",
          userId: session?.user.id ?? null,
          role: "analyst",
          actorType: session ? "user" : "system",
          actorId: session?.user.id ?? "anonymous",
          correlationId,
          tx,
          log,
          ip,
        }),
      );
    } catch (e) {
      return errorResponse(e, correlationId);
    }
  };
}

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(100).optional(),
});
