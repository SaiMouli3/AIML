import { redact } from "./redact";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const l = (process.env.LOG_LEVEL as Level | undefined) ?? (process.env.APP_ENV === "test" ? "warn" : "info");
  return ORDER[l] ?? 20;
}

/** Structured JSON logger. All fields are redacted before output. */
function write(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields) as object) });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export interface Logger {
  debug(msg: string, f?: Record<string, unknown>): void;
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
  child(f: Record<string, unknown>): Logger;
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, f) => write("debug", m, { ...base, ...f }),
    info: (m, f) => write("info", m, { ...base, ...f }),
    warn: (m, f) => write("warn", m, { ...base, ...f }),
    error: (m, f) => write("error", m, { ...base, ...f }),
    child: (f) => createLogger({ ...base, ...f }),
  };
}

export const logger = createLogger({ service: "synchronous-social-ai" });
