import type { LinkProps } from "@tanstack/react-router";
import {
  Activity,
  Bot,
  Cable,
  Database,
  EyeOff,
  Gauge,
  KeyRound,
  LogIn,
  type LucideIcon,
  Plug,
  Ruler,
  ScrollText,
  Search,
  Settings,
  Users,
} from "lucide-react";

/**
 * Every admin page, in the order the second lane shows them. A later admin issue adds
 * its page with one entry here and one in routes/admin/pages.ts, and its path
 * to SPA_PATHS in apps/api/src/http/static.ts and to the public list in
 * public-paths.ts (with a line in its security test), or the api serves the
 * page's address only to someone who has signed in already.
 *
 * `owns` names what the page answers for: a failing check whose name is one of
 * these, or starts with one followed by "." or "_", is linked to this page.
 */
export type NavSection = "Data" | "Access" | "System";

export type NavItem = {
  label: string;
  /** A path of a route in the router: a page with no route fails to compile, and nav.test.ts checks it again. */
  to: LinkProps["to"] & `/admin${string}`;
  /** The section of the second lane it is listed in; Status has none, it has its own row in the first lane. */
  section: NavSection | null;
  icon: LucideIcon;
  owns: readonly string[];
};

export const ADMIN_SECTIONS: readonly NavSection[] = [
  "Data",
  "Access",
  "System",
];

export const ADMIN_NAV: NavItem[] = [
  {
    label: "Status",
    to: "/admin",
    section: null,
    icon: Activity,
    owns: ["address", "agents", "first_sync", "full_sync", "security"],
  },
  {
    label: "Power BI",
    to: "/admin/powerbi",
    section: "Data",
    icon: Cable,
    owns: ["powerbi", "app_registration", "scanner", "what_to_sync"],
  },
  {
    label: "Datasets",
    to: "/admin/datasets",
    section: "Data",
    icon: Database,
    owns: ["powerbi.datasets"],
  },
  {
    label: "PII",
    to: "/admin/pii",
    section: "Data",
    icon: EyeOff,
    owns: ["pii"],
  },
  {
    label: "Conventions",
    to: "/admin/conventions",
    section: "Data",
    icon: Ruler,
    owns: [],
  },
  {
    label: "Authentication",
    to: "/admin/sign-in",
    section: "Access",
    icon: LogIn,
    owns: ["sign_in", "email", "resend_api_key"],
  },
  {
    label: "Users and roles",
    to: "/admin/people",
    section: "Access",
    icon: Users,
    owns: ["who_gets_in"],
  },
  {
    label: "Service accounts",
    to: "/admin/service-accounts",
    section: "Access",
    icon: Bot,
    owns: [],
  },
  {
    label: "Secrets",
    to: "/admin/secrets",
    section: "Access",
    icon: KeyRound,
    owns: ["result_link_key", "expiry"],
  },
  {
    label: "General",
    to: "/admin/general",
    section: "System",
    icon: Settings,
    owns: ["branding"],
  },
  {
    label: "Search",
    to: "/admin/search",
    section: "System",
    icon: Search,
    owns: ["search", "openai_api_key", "gemini_api_key"],
  },
  {
    label: "Limits",
    to: "/admin/limits",
    section: "System",
    icon: Gauge,
    owns: ["results", "queries"],
  },
  {
    label: "Audit log",
    to: "/admin/audit",
    section: "System",
    icon: ScrollText,
    owns: [],
  },
];

/** A person's own settings: the first section of the second lane, shown to everyone, as Linear's Account comes before its administration. */
export const ACCOUNT_SECTION = "Account";

export type AccountItem = {
  label: string;
  to: LinkProps["to"] & `/settings${string}`;
  icon: LucideIcon;
};

/** Where the Settings row goes: the first page of the second lane, the one every person has. */
export const SETTINGS_HOME = "/settings/connections";

export const ACCOUNT_NAV: readonly AccountItem[] = [
  { label: "Connections", to: SETTINGS_HOME, icon: Plug },
];

/** The page a failing check, setting or secret belongs to, or undefined when no page claims it. */
export function pageOf(name: string): NavItem | undefined {
  let match: NavItem | undefined;
  let longest = -1;
  for (const item of ADMIN_NAV) {
    for (const own of item.owns) {
      if (
        own.length > longest &&
        (name === own ||
          name.startsWith(`${own}.`) ||
          name.startsWith(`${own}_`))
      ) {
        match = item;
        longest = own.length;
      }
    }
  }
  return match;
}
