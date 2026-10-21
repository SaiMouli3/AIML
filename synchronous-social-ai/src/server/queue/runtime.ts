import type { Ctx } from "../context";
import { withSystem, withTenant } from "../db/tenant";
import type { Tx } from "../db/client";
import { createLogger, type Logger } from "../lib/logger";
import { newCorrelationId } from "../lib/ids";
import type { JobRow } from "./queue";

export interface JobContext {
  job: JobRow;
  workspaceId: string | null;
  correlationId: string;
  log: Logger;
  /** Run a short, committed tenant transaction. Never hold a transaction open across provider calls. */
  tenant<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T>;
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface JobHandler {
  /** True when the job performs external mutations (blocked by kill switch, never blindly retried). */
  external?: boolean;
  /** True when a lost worker leaves the outcome uncertain (requires reconciliation instead of retry). */
  uncertainOnCrash?: boolean;
  run(jc: JobContext, payload: Record<string, unknown>): Promise<unknown>;
}

const registry = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler) {
  registry.set(type, handler);
}
export const getJobHandler = (type: string) => registry.get(type);
export const registeredJobTypes = () => [...registry.keys()];
export const externalJobTypes = () => [...registry.entries()].filter(([, h]) => h.external).map(([t]) => t);
export const uncertainJobTypes = () => [...registry.entries()].filter(([, h]) => h.uncertainOnCrash).map(([t]) => t);

export function workerCtx(workspaceId: string, tx: Tx, correlationId: string, log: Logger): Ctx {
  return {
    workspaceId,
    userId: null,
    role: "admin",
    actorType: "worker",
    actorId: "worker",
    correlationId,
    tx,
    log,
  };
}

export function makeJobContext(job: JobRow): JobContext {
  const correlationId = job.correlationId ?? newCorrelationId();
  const log = createLogger({ jobId: job.id, jobType: job.type, workspaceId: job.workspaceId, correlationId });
  return {
    job,
    workspaceId: job.workspaceId,
    correlationId,
    log,
    tenant: (fn) => {
      if (!job.workspaceId) throw new Error(`Job ${job.type} has no workspace`);
      return withTenant(job.workspaceId, (tx) => fn(workerCtx(job.workspaceId!, tx, correlationId, log)));
    },
    system: (fn) => withSystem(fn),
  };
}
