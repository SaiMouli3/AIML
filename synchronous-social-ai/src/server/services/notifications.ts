import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Ctx } from "../context";
import * as s from "../db/schema";

/** In-app notifications. `userId` null means visible to every member. Email adapter: see docs/integrations.md. */
export async function notify(ctx: Ctx, n: { kind: string; title: string; body?: string; link?: string; userId?: string | null }) {
  await ctx.tx.insert(s.notifications).values({
    workspaceId: ctx.workspaceId,
    userId: n.userId ?? null,
    kind: n.kind,
    title: n.title.slice(0, 200),
    body: n.body?.slice(0, 1000) ?? null,
    link: n.link ?? null,
  });
}

export async function listNotifications(ctx: Ctx, limit = 30) {
  const mine = or(isNull(s.notifications.userId), eq(s.notifications.userId, ctx.userId ?? "00000000-0000-0000-0000-000000000000"));
  const items = await ctx.tx
    .select()
    .from(s.notifications)
    .where(and(eq(s.notifications.workspaceId, ctx.workspaceId), mine))
    .orderBy(desc(s.notifications.createdAt))
    .limit(limit);
  const [u] = await ctx.tx
    .select({ c: sql<number>`count(*)::int` })
    .from(s.notifications)
    .where(and(eq(s.notifications.workspaceId, ctx.workspaceId), mine, isNull(s.notifications.readAt)));
  return { items, unread: u?.c ?? 0 };
}

export async function markAllRead(ctx: Ctx) {
  await ctx.tx
    .update(s.notifications)
    .set({ readAt: new Date() })
    .where(and(eq(s.notifications.workspaceId, ctx.workspaceId), isNull(s.notifications.readAt)));
}
