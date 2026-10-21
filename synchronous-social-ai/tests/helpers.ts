import { randomUUID } from "node:crypto";
import "@/server/register";
import type { Ctx } from "@/server/context";
import { withTenant } from "@/server/db/tenant";
import { createLogger } from "@/server/lib/logger";
import type { Role } from "@/server/rbac/roles";
import { signup } from "@/server/services/workspace";
import { drainAll } from "@/server/queue/worker";

export interface Tenant {
  userId: string;
  workspaceId: string;
  email: string;
}

export async function makeTenant(name = "Acme"): Promise<Tenant> {
  const email = `${randomUUID()}@example.test`;
  const r = await signup({ name: "Owner", email, password: "correct horse battery staple", workspaceName: `${name} ${randomUUID().slice(0, 6)}`, timezone: "UTC" }, { ip: randomUUID() });
  return { userId: r.user.id, workspaceId: r.workspace.id, email };
}

export function as<T>(t: Tenant, fn: (ctx: Ctx) => Promise<T>, opts: { role?: Role; actorType?: Ctx["actorType"]; userId?: string } = {}): Promise<T> {
  return withTenant(t.workspaceId, (tx) =>
    fn({
      workspaceId: t.workspaceId,
      userId: opts.userId ?? t.userId,
      role: opts.role ?? "owner",
      actorType: opts.actorType ?? "user",
      actorId: opts.userId ?? t.userId,
      correlationId: `test_${randomUUID().slice(0, 8)}`,
      tx,
      log: createLogger({ test: true }),
    }),
  );
}

export const drain = () => drainAll(100);
