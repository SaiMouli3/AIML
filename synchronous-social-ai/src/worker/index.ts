import "../server/register";
import { closeDb } from "../server/db/client";
import { env } from "../server/env";
import { logger } from "../server/lib/logger";
import { startWorkerLoop } from "../server/queue/worker";
import { schedulePeriodicJobs } from "../server/queue/scheduler";

/** Worker process: durable job execution + periodic scheduling. Graceful shutdown on SIGTERM/SIGINT. */
async function main() {
  env(); // fail fast on invalid configuration
  const controller = new AbortController();
  const stop = () => {
    logger.info("worker_shutdown_requested");
    controller.abort();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const tick = async () => {
    try {
      await schedulePeriodicJobs();
    } catch (e) {
      logger.error("scheduler_error", { error: e });
    }
  };
  await tick();
  const timer = setInterval(tick, 60_000);
  await startWorkerLoop(controller.signal);
  clearInterval(timer);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
