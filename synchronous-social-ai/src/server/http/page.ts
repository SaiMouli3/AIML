import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import "../register";
import { resolveSession, sessionCookieName, type SessionInfo } from "../auth/session";
import type { Ctx } from "../context";
import { withTenant } from "../db/tenant";
import { newCorrelationId } from "../lib/ids";
import { createLogger } from "../lib/logger";
import { can, type Permission } from "../rbac/roles";

export async function currentSession(): Promise<SessionInfo | null> {
  const jar = await cookies();
  return resolveSession(jar.get(sessionCookieName())?.value);
}

/** Server-component data loader: requires a session + workspace, runs `fn` in a tenant-scoped transaction. */
export async function loadPage<T>(
  fn: (ctx: Ctx, session: SessionInfo) => Promise<T>,
  opts: { permission?: Permission } = {},
): Promise<
  { data: T; session: SessionInfo; allowed: true } | { data: null; session: SessionInfo; allowed: false }
> {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (!session.workspace || !session.role) redirect("/onboarding");
  if (opts.permission && !can(session.role, opts.permission)) return { data: null, session, allowed: false };
  const h = await headers();
  const correlationId = h.get("x-correlation-id") ?? newCorrelationId();
  const data = await withTenant(session.workspace.id, (tx) =>
    fn(
      {
        workspaceId: session.workspace!.id,
        userId: session.user.id,
        role: session.role!,
        actorType: "user",
        actorId: session.user.id,
        correlationId,
        tx,
        log: createLogger({ correlationId, page: true }),
      },
      session,
    ),
  );
  return { data, session, allowed: true };
}

/** Type of a value after JSON round-trip: Dates become ISO strings. */
export type Serialized<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Serialized<U>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;

/** JSON-safe serialization for passing server data to client components (Dates → ISO strings). */
export function serialize<T>(v: T): Serialized<T> {
  return JSON.parse(JSON.stringify(v));
}
