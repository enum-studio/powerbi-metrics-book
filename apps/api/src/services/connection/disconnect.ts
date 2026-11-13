import type { ServiceContext } from "../../context.js";
import { writeAudit } from "../audit/write.js";
import { endConnection } from "./store.js";

/** Deletes both of the calling person's tokens. The row stays, so the account stays theirs. */
export async function disconnect(context: ServiceContext): Promise<void> {
  const { principal } = context;
  await context.db.transaction((tx) =>
    endConnection(tx, principal.id, { status: "disconnected" }),
  );
  await writeAudit(context, {
    principal,
    action: "powerbi.disconnect",
    resource: { kind: "powerbi_connection", id: principal.id },
    decision: "allow",
  });
}
