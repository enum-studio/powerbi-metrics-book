import { LINK, PageFrame } from "../layout/ui";
import type { FieldSpec } from "./fields";
import { Section } from "./section";

const APP: FieldSpec[] = [
  { key: "powerbi.tenant_id", label: "Tenant id", kind: "text" },
  { key: "powerbi.app_client_id", label: "Client id", kind: "text" },
];
const SCANNER: FieldSpec[] = [
  { key: "powerbi.scanner_client_id", label: "Client id", kind: "text" },
];
const SYNC: FieldSpec[] = [
  {
    key: "powerbi.sync.workspaces.include",
    label: "Workspaces to include",
    kind: "include",
    hint: "all, or one workspace id per line. An empty list syncs none.",
  },
  {
    key: "powerbi.sync.workspaces.exclude",
    label: "Workspaces to exclude",
    kind: "list",
    hint: "One workspace id per line. Skipped even when included.",
  },
  {
    key: "powerbi.sync.workspaces.personal",
    label: "Personal workspaces",
    kind: "bool",
    hint: "Read people's personal workspaces too.",
  },
  {
    key: "powerbi.sync.schedule",
    label: "Incremental scan schedule",
    kind: "cron",
    hint: "A cron line: minute, hour, day, month, weekday.",
  },
  {
    key: "powerbi.sync.full_scan_schedule",
    label: "Full scan schedule",
    kind: "cron",
    hint: "A cron line. The full scan also finds what was deleted.",
  },
];
const ACCESS: FieldSpec[] = [
  {
    key: "powerbi.service_account_queries",
    label: "Service-account queries",
    kind: "bool",
    hint: "Let service accounts run queries as the app's own service principal.",
  },
  {
    key: "powerbi.connection_requires_matching_email",
    label: "Matching email",
    kind: "bool",
    hint: "A person may connect Power BI only with the email they signed in with.",
  },
  {
    key: "powerbi.keep_connections_alive_days",
    label: "Keep connections alive (days)",
    kind: "number",
    hint: "Refresh a connection idle this many days so it never expires. Empty leaves them to expire.",
  },
];
const CLOUD: FieldSpec[] = [
  {
    key: "powerbi.authority",
    label: "Microsoft identity address",
    kind: "text",
  },
  { key: "powerbi.api_url", label: "Power BI REST API address", kind: "text" },
  { key: "powerbi.graph_url", label: "Microsoft Graph address", kind: "text" },
];

export function PowerBiPage() {
  return (
    <PageFrame
      title="Power BI"
      lede="The two app registrations, what the sync reads and when, and who may connect."
      help={
        <>
          <p>
            Each section ends in its Check. A failed check says what is wrong
            and the one thing to change.
          </p>
          <a className={LINK} href="/docs/set-up/app-registration/">
            The app registration guide
          </a>
          <a className={LINK} href="/docs/set-up/scanner/">
            The scanner guide
          </a>
        </>
      }
    >
      <Section
        title="App registration"
        fields={APP}
        secrets={() => ["powerbi_app_client_secret"]}
        checkName="app_registration"
        note="The web app that signs people in and holds their Power BI connections."
      />
      <Section
        title="Scanner registration"
        fields={SCANNER}
        secrets={() => ["powerbi_scanner_client_secret"]}
        checkName="scanner"
        note="A second app with no API permissions. Only the worker reads its secret."
      />
      <Section title="What to sync" fields={SYNC} checkName="what_to_sync" />
      <Section title="Query access" fields={ACCESS} />
      <Section
        title="National clouds"
        fields={CLOUD}
        note="For a sovereign cloud or the mock. An operator decision, so these are set only in the environment."
      />
    </PageFrame>
  );
}
