import { hostname } from "node:os";
import { env } from "../env";
import { logger } from "../lib/logger";
import { claimJobs, completeJob, failJob, recoverStaleJobs, type JobRow } from "./queue";
import { externalJobTypes, getJobHandler, makeJobContext, uncertainJobTypes } from "./runtime";
import { RescheduleSignal } from "./signals";
import { rescheduleJob } from "./queue";

export async function runJob(job: JobRow) {
  const handler = getJobHandler(job.type);
  const jc = makeJobContext(job);
  if (!handler) {
    await failJob({ ...job, attempts: job.maxAttempts }, new Error(`No handler registered for ${job.type}`));
    return "dead";
  }
  try {
    const result = await handler.run(jc, (job.payload ?? {}) as Record<string, unknown>);
    await completeJob(job.id, result);
    return "succeeded";
  } catch (e) {
    if (e instanceof RescheduleSignal) {
      await rescheduleJob(job.id, e.delayMs, e.payload);
      return "rescheduled";
    }
    jc.log.warn("job_failed", { error: e, attempts: job.attempts });
    return failJob(job, e);
  }
}

/** Process up to `limit` runnable jobs once. Used by the worker loop and by tests. */
export async function drainOnce(limit = 10, workerId = `${hostname()}-${process.pid}`) {
  const claimed = await claimJobs({
    workerId,
    limit,
    tenantConcurrency: env().WORKER_TENANT_CONCURRENCY,
    externalTypes: externalJobTypes(),
  });
  const results = await Promise.all(claimed.map((j) => runJob(j)));
  return results.length;
}

/** Drain until the queue has no runnable work (tests / E2E helpers). */
export async function drainAll(maxRounds = 50) {
  let total = 0;
  for (let i = 0; i < maxRounds; i++) {
    const n = await drainOnce(20);
    total += n;
    if (n === 0) break;
  }
  return total;
}

export async function startWorkerLoop(signal: AbortSignal) {
  const workerId = `${hostname()}-${process.pid}`;
  const concurrency = env().WORKER_CONCURRENCY;
  let inflight = 0;
  let lastRecovery = 0;
  logger.info("worker_started", { workerId, concurrency });
  while (!signal.aborted) {
    try {
      if (Date.now() - lastRecovery > 60_000) {
        await recoverStaleJobs(10 * 60_000, uncertainJobTypes());
        lastRecovery = Date.now();
      }
      const free = concurrency - inflight;
      if (free > 0) {
        const claimed = await claimJobs({
          workerId,
          limit: free,
          tenantConcurrency: env().WORKER_TENANT_CONCURRENCY,
          externalTypes: externalJobTypes(),
        });
        for (const job of claimed) {
          inflight++;
          void runJob(job).finally(() => inflight--);
        }
      }
    } catch (e) {
      logger.error("worker_loop_error", { error: e });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  while (inflight > 0) await new Promise((r) => setTimeout(r, 200));
  logger.info("worker_stopped", { workerId });
}
