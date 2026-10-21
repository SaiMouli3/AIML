import { execSync } from "node:child_process";
import { Client } from "pg";

export default async function setup() {
  const url = process.env.E2E_DATABASE_URL ?? "postgres://sync:sync@localhost:5432/sync_e2e";
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;",
  );
  await c.end();
  execSync("npx tsx src/server/db/migrate.ts", {
    env: { ...process.env, DATABASE_URL: url, APP_ENV: "test" },
    stdio: "inherit",
  });
}
