import { Client } from "pg";
import { execSync } from "node:child_process";

/** Recreate the test schema and apply migrations once per test run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://sync:sync@localhost:5432/sync_test";
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await c.end();
  execSync("npx tsx src/server/db/migrate.ts", { env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
}
