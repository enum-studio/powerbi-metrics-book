import type { ServiceContext } from "../../context.js";
import { type AuditQuery, readAudit } from "../audit/read.js";
import { requireAdmin } from "./guard.js";

/** The audit log, newest first, for admin:read_audit; reading it is not itself an event. */
export async function listAudit(context: ServiceContext, query: AuditQuery) {
  await requireAdmin(context, "read_audit");
  return readAudit(context.db, query);
}
