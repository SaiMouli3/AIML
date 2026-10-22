import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Executor = DB | Tx;

const globalForDb = globalThis as unknown as { __ssaPool?: Pool; __ssaDb?: DB };

export function pool(): Pool {
  if (!globalForDb.__ssaPool) {
    globalForDb.__ssaPool = new Pool({ connectionString: env().DATABASE_URL, max: 10 });
  }
  return globalForDb.__ssaPool;
}

export function db(): DB {
  if (!globalForDb.__ssaDb) globalForDb.__ssaDb = drizzle(pool(), { schema });
  return globalForDb.__ssaDb;
}

export async function closeDb() {
  await globalForDb.__ssaPool?.end();
  globalForDb.__ssaPool = undefined;
  globalForDb.__ssaDb = undefined;
}

export { schema };
