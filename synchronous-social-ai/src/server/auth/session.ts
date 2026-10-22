import { and, eq, gt } from "drizzle-orm";
import { withSystem } from "../db/tenant";
import { memberships, sessions, users, workspaces } from "../db/schema";
import { randomToken, sha256 } from "../lib/crypto";
import { env } from "../env";
import { isRole, type Role } from "../rbac/roles";

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function sessionCookieName() {
  // __Host- prefix requires Secure + Path=/ + no Domain: prevents subdomain cookie injection.
  return env().APP_URL.startsWith("https://") ? "__Host-ssa_session" : "ssa_session";
}

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: env().APP_URL.startsWith("https://"),
    sameSite: "lax" as const,
    path: "/",
    expires,
  };
}

export async function createSession(userId: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const first = await withSystem((tx) =>
    tx
      .select({ workspaceId: memberships.workspaceId })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .limit(1),
  );
  await withSystem((tx) =>
    tx.insert(sessions).values({
      id: sha256(token),
      userId,
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      activeWorkspaceId: first[0]?.workspaceId ?? null,
    }),
  );
  return { token, expiresAt };
}

export async function destroySession(token: string) {
  await withSystem((tx) => tx.delete(sessions).where(eq(sessions.id, sha256(token))));
}

export interface SessionInfo {
  sessionId: string;
  user: { id: string; email: string; name: string };
  workspace: {
    id: string;
    name: string;
    slug: string;
    isDemo: boolean;
    killSwitch: boolean;
    timezone: string;
  } | null;
  role: Role | null;
  memberships: Array<{ workspaceId: string; name: string; role: Role }>;
}

/** Resolve a session token to user + active workspace membership. Membership is always re-verified. */
export async function resolveSession(
  token: string | undefined,
  workspaceOverride?: string | null,
): Promise<SessionInfo | null> {
  if (!token) return null;
  const sid = sha256(token);
  return withSystem(async (tx) => {
    const rows = await tx
      .select({ s: sessions, u: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, sid), gt(sessions.expiresAt, new Date())))
      .limit(1);
    const row = rows[0];
    if (!row || row.u.disabledAt) return null;
    const ms = await tx
      .select({
        workspaceId: memberships.workspaceId,
        role: memberships.role,
        name: workspaces.name,
        deletedAt: workspaces.deletedAt,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, row.u.id));
    const live = ms.filter((m) => !m.deletedAt && isRole(m.role));
    const wanted = workspaceOverride ?? row.s.activeWorkspaceId;
    const active = live.find((m) => m.workspaceId === wanted) ?? live[0];
    let workspace: SessionInfo["workspace"] = null;
    if (active) {
      const w = await tx.select().from(workspaces).where(eq(workspaces.id, active.workspaceId)).limit(1);
      if (w[0]) {
        workspace = {
          id: w[0].id,
          name: w[0].name,
          slug: w[0].slug,
          isDemo: w[0].isDemo,
          killSwitch: w[0].killSwitch,
          timezone: w[0].timezone,
        };
      }
    }
    // Sliding expiration: extend when less than half the TTL remains.
    if (row.s.expiresAt.getTime() - Date.now() < SESSION_TTL_MS / 2) {
      await tx
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
        .where(eq(sessions.id, sid));
    }
    return {
      sessionId: sid,
      user: { id: row.u.id, email: row.u.email, name: row.u.name },
      workspace,
      role: active ? (active.role as Role) : null,
      memberships: live.map((m) => ({ workspaceId: m.workspaceId, name: m.name, role: m.role as Role })),
    };
  });
}

export async function setActiveWorkspace(sessionId: string, userId: string, workspaceId: string) {
  return withSystem(async (tx) => {
    const m = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)))
      .limit(1);
    if (!m[0]) return false;
    await tx.update(sessions).set({ activeWorkspaceId: workspaceId }).where(eq(sessions.id, sessionId));
    return true;
  });
}
