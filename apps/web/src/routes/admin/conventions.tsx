import { Conventions } from "../../admin/access/conventions";
import { PageFrame } from "../../admin/layout/ui";

export function ConventionsPage() {
  return (
    <PageFrame
      title="Conventions"
      lede="The company's rules for naming, describing and verifying metrics, as agents read them."
    >
      <Conventions />
    </PageFrame>
  );
}
