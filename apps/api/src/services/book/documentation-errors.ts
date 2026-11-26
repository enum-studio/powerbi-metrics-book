import pg from "pg";
import { ServiceError } from "../../errors.js";
const MESSAGES: Record<string, string> = {
  metric_edge_isolation_check:
    "Metric graph writes require READ COMMITTED isolation. Retry in a new READ COMMITTED transaction.",
  metric_documentation_choice_check:
    "Choose a value allowed by the current conventions, then save again.",
  metric_edge_cycle_check:
    "This edge would make a cycle. Choose a child that does not lead back to the parent.",
  metric_edge_operation_consistency_check:
    "A parent uses one operation. Remove its existing edges before changing from sum to product.",
  metric_link_reason_check: "Explain why these metrics move together.",
};
export function documentationError(error: unknown): never {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof pg.DatabaseError && cause.constraint) {
      const message = MESSAGES[cause.constraint];
      if (message) throw new ServiceError("invalid", message);
    }
  }
  throw error;
}
