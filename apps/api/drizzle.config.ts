import { defineConfig } from "drizzle-kit";

// Only `drizzle-kit generate` reads this, and it needs no database: migrations
// are applied by src/db/migrate.ts, as the migrator.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
});
