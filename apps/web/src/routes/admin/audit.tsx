import { AuditLog } from "../../admin/access/audit";
import { PageFrame } from "../../admin/layout/ui";

export function AuditPage() {
  return (
    <PageFrame
      title="Audit log"
      lede="Who did what, and whether it was allowed, newest first."
    >
      <AuditLog />
    </PageFrame>
  );
}
