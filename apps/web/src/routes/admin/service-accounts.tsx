import { ServiceAccounts } from "../../admin/access/accounts";
import { PageFrame } from "../../admin/layout/ui";

export function ServiceAccountsPage() {
  return (
    <PageFrame
      title="Service accounts"
      lede="Callers that are not people, what they may reach, and the keys they sign in with."
    >
      <ServiceAccounts />
    </PageFrame>
  );
}
