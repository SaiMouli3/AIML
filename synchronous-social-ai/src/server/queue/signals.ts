/** Thrown by a job handler to poll again later without consuming a retry attempt. */
export class RescheduleSignal extends Error {
  constructor(
    readonly delayMs: number,
    readonly payload?: Record<string, unknown>,
  ) {
    super("reschedule");
    this.name = "RescheduleSignal";
  }
}
