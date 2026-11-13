import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { SCHEMA_OPTIONS } from "./better-auth.js";

/*
 * Read by Better Auth's CLI only, to write the tables of every plugin the api
 * may turn on into src/db/schema/auth.ts. From apps/api:
 *
 *   pnpm dlx auth@1.7.12 generate --config src/services/auth/schema-config.ts --output src/db/schema/auth.ts
 *
 * then add the grants back at the end of the file and run db:generate.
 */
export const auth = betterAuth({
  ...SCHEMA_OPTIONS,
  database: drizzleAdapter({}, { provider: "pg" }),
  telemetry: { enabled: false },
});
