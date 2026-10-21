import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "./client";

async function main() {
  await migrate(db(), { migrationsFolder: "./drizzle" });
  process.stdout.write("migrations applied\n");
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
