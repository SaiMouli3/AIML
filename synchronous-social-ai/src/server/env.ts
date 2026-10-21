import { z } from "zod";

/**
 * Server-side environment validation. Never import this module from client components:
 * it reads secrets. Values are validated once and cached.
 */
const boolish = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "true" || v === "1"));

const schema = z.object({
  APP_ENV: z.enum(["development", "test", "demo", "staging", "production"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1).default("postgres://sync:sync@localhost:5432/sync_dev"),
  SESSION_SECRET: z.string().min(32).optional(),
  ENCRYPTION_KEY: z.string().optional(),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default(".data/storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  LLM_BASE_URL: z.url().default("https://api.experientiallabs.ai/v1"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL_DEFAULT: z.string().default("claude-sonnet-5.5"),
  LLM_MODEL_FAST: z.string().default("claude-haiku-5.5"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default("v26.0"),
  META_ADS_TEST_MODE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  THREADS_APP_ID: z.string().optional(),
  THREADS_APP_SECRET: z.string().optional(),
  THREADS_GRAPH_HOST: z.url().default("https://graph.threads.com"),
  THREADS_AUTHORIZE_URL: z.url().default("https://threads.com/oauth/authorize"),
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),
  X_API_BASE: z.url().default("https://api.x.com"),
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  TIKTOK_API_BASE: z.url().default("https://open.tiktokapis.com"),
  HIGGSFIELD_API_KEY_ID: z.string().optional(),
  HIGGSFIELD_API_KEY_SECRET: z.string().optional(),
  HIGGSFIELD_WEBHOOK_TOKEN: z.string().optional(),
  ALLOW_MOCK_PROVIDERS: boolish,
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  WORKER_TENANT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema> & {
  sessionSecret: string;
  encryptionKey: Buffer;
  mocksAllowed: boolean;
  isProductionLike: boolean;
};

let cached: Env | undefined;

const DEV_ONLY_SECRET = "dev-only-insecure-session-secret-change-me-0000";
const DEV_ONLY_KEY = Buffer.alloc(32, 7);

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  const isProductionLike = e.APP_ENV === "production" || e.APP_ENV === "staging";
  if (isProductionLike) {
    if (!e.SESSION_SECRET) throw new Error("SESSION_SECRET is required in staging/production");
    if (!e.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is required in staging/production");
  }
  let encryptionKey = DEV_ONLY_KEY;
  if (e.ENCRYPTION_KEY) {
    encryptionKey = Buffer.from(e.ENCRYPTION_KEY, "base64");
    if (encryptionKey.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  // Development mocks exist only in development/test/demo. They can never be enabled in staging/production.
  const mocksAllowed = !isProductionLike && e.ALLOW_MOCK_PROVIDERS !== false;
  cached = {
    ...e,
    sessionSecret: e.SESSION_SECRET ?? DEV_ONLY_SECRET,
    encryptionKey,
    mocksAllowed,
    isProductionLike,
  };
  return cached;
}

/** Test helper: forget cached env so tests can change process.env. */
export function resetEnvCache() {
  cached = undefined;
}

export const integrationsConfigured = {
  llm: () => Boolean(env().LLM_API_KEY),
  meta: () => Boolean(env().META_APP_ID && env().META_APP_SECRET),
  metaWebhooks: () => Boolean(env().META_APP_SECRET && env().META_WEBHOOK_VERIFY_TOKEN),
  threads: () => Boolean(env().THREADS_APP_ID && env().THREADS_APP_SECRET),
  x: () => Boolean(env().X_CLIENT_ID && env().X_CLIENT_SECRET),
  tiktok: () => Boolean(env().TIKTOK_CLIENT_KEY && env().TIKTOK_CLIENT_SECRET),
  higgsfield: () => Boolean(env().HIGGSFIELD_API_KEY_ID && env().HIGGSFIELD_API_KEY_SECRET),
};
