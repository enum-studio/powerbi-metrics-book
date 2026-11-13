import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { declareGrants } from "../grants.js";

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

/**
 * The company's logo, one row at most (id is always true). Uploaded, never
 * fetched from a URL, and never SVG, which can carry script.
 */
export const brandLogo = pgTable(
  "brand_logo",
  {
    id: boolean("id").primaryKey().default(true),
    content_type: text("content_type", {
      enum: ["image/png", "image/jpeg", "image/webp"],
    }).notNull(),
    bytes: bytea("bytes").notNull(),
    sha256: text("sha256").notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("brand_logo_single_row", sql`${t.id}`),
    check(
      "brand_logo_content_type",
      sql`${t.content_type} in ('image/png', 'image/jpeg', 'image/webp')`,
    ),
    check("brand_logo_size", sql`octet_length(${t.bytes}) <= 262144`),
    check("brand_logo_digest", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

declareGrants({
  brand_logo: {
    api_rw: ["select", "insert", "update", "delete"],
    worker_rw: [],
    audit_writer: [],
  },
});
