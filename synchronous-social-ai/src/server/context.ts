import type { Tx } from "./db/client";
import type { Logger } from "./lib/logger";
import type { Role, Permission } from "./rbac/roles";
import { can } from "./rbac/roles";
import { AppError } from "./lib/errors";

export type ActorType = "user" | "agent" | "system" | "worker" | "webhook";

/** Request/job context passed to every service. `tx` is already scoped to `workspaceId` via RLS. */
export interface Ctx {
  workspaceId: string;
  userId: string | null;
  role: Role;
  actorType: ActorType;
  actorId: string;
  correlationId: string;
  tx: Tx;
  log: Logger;
  ip?: string | null;
}

export function requirePermission(ctx: Ctx, permission: Permission) {
  if (!can(ctx.role, permission)) {
    throw new AppError("FORBIDDEN", `Your role (${ctx.role}) does not allow ${permission}`);
  }
}

export function requireUser(ctx: Ctx): string {
  if (!ctx.userId || ctx.actorType !== "user") throw new AppError("FORBIDDEN", "This action requires a human user");
  return ctx.userId;
}
