import { eq } from "drizzle-orm";
import { withSystem } from "../db/tenant";
import * as s from "../db/schema";
import { enqueue } from "./queue";

/**
 * Periodic work, enqueued with time-bucketed idempotency keys so multiple worker replicas never
 * double-schedule. Safe to call every minute.
 */
export async function schedulePeriodicJobs(now = new Date()) {
  const hour = now.toISOString().slice(0, 13);
  const sixHour = `${now.toISOString().slice(0, 10)}T${String(Math.floor(now.getUTCHours() / 6) * 6).padStart(2, "0")}`;
  await withSystem(async (tx) => {
    await enqueue(tx, {
      type: "integrations.token_health",
      workspaceId: null,
      idempotencyKey: `token_health:${hour}`,
    });
    await enqueue(tx, {
      type: "automation.scheduled_drafts",
      workspaceId: null,
      idempotencyKey: `scheduled_drafts:${hour}`,
    });
    const wss = await tx
      .select({ id: s.workspaces.id })
      .from(s.workspaces)
      .where(eq(s.workspaces.killSwitch, false));
    for (const w of wss) {
      await enqueue(tx, {
        type: "analytics.sync_content",
        workspaceId: w.id,
        idempotencyKey: `analytics.sync_content:${w.id}:${sixHour}`,
      });
      await enqueue(tx, {
        type: "ads.sync_insights",
        workspaceId: w.id,
        idempotencyKey: `ads.sync_insights:${w.id}:${sixHour}`,
      });
    }
  });
}
