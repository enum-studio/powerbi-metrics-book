import type { StepId } from "./api";

/*
 * What each step tells the person, in the words of the docs' setup guide:
 * what to do and why, and every value to copy. The API gives the steps,
 * their fields and their checks; this gives the instructions around them.
 */

export type CopyValue = { label: string; value: string };
export type Guide = {
  why: string;
  todo: string[];
  copy: (origin: string) => CopyValue[];
  /** The button that saves the step and runs its check, named for what it checks. */
  button: string;
  /** What the button sends besides the step's fields: the worker's checks and the sync are started by name, and a POST without it only reads where they stand. */
  starts?: "start_check" | "start_sync";
};

const none = () => [];

/** What connecting an agent or the CLI needs: the setup's Agents step and a person's connections page show these same values. The CLI takes the address as --url (`pbmb login --help`). */
export const agentValues = (origin: string): CopyValue[] => [
  { label: "MCP address", value: `${origin}/api/mcp` },
  {
    label: "Install the CLI",
    value: "uv tool install powerbi-metrics-book",
  },
  { label: "Sign the CLI in", value: `pbmb login --url ${origin}` },
];

export const GUIDES: Record<StepId, Guide> = {
  address: {
    why: "Sign-in, the Power BI connection and every agent send people back to one address, and the cookies that keep people signed in travel over https only.",
    todo: [
      "Check that the address below is the one people will use.",
      "If it is not, set PUBLIC_BASE_URL in the server's .env to that address, restart the api, and open a new setup link.",
    ],
    copy: (origin) => [{ label: "This page's address", value: origin }],
    button: "Check the address",
  },
  app_registration: {
    why: "People sign in with Microsoft, and query Power BI as themselves, through one app registration in your Entra tenant.",
    todo: [
      "In Entra, open App registrations and choose New registration: Single tenant only (Accounts in this organizational directory only, in an older portal), platform Web.",
      "Add both redirect URIs below.",
      "Under API permissions, add the delegated permissions below and no permission of type Application, then grant admin consent.",
      "Under Certificates & secrets, add a client secret. Copy its Value, not its Secret ID, and note when it expires.",
      "Enter the tenant id, the client id and the secret here.",
    ],
    copy: (origin) => [
      {
        label: "Sign-in redirect URI",
        value: `${origin}/api/auth/callback/microsoft`,
      },
      {
        label: "Power BI connection redirect URI",
        value: `${origin}/api/v1/powerbi/callback`,
      },
      { label: "Power BI Service, delegated", value: "Dataset.Read.All" },
      {
        label: "Microsoft Graph, delegated",
        value: "openid profile email offline_access User.Read",
      },
    ],
    button: "Check the app registration",
  },
  scanner: {
    why: "The scanner reads every workspace's tables, measures and DAX through Power BI's read-only admin APIs. It is a second app registration with no API permission at all: Power BI lets it in through a security group named in the tenant settings.",
    todo: [
      "Register a second app, in this directory only, and give it no API permission.",
      "Add a client secret and note when it expires.",
      "Create a security group with the purpose below, and add the scanner app's service principal to it.",
      "In Power BI's admin portal, under Tenant settings, turn on the three settings below for that group only.",
      "Enter the scanner's client id and secret here.",
    ],
    copy: () => [
      {
        label: "The security group's purpose",
        value:
          "Lets Power BI Metrics Book's scanner call Power BI's read-only admin APIs.",
      },
      {
        label: "Tenant setting",
        value: "Service principals can access read-only admin APIs",
      },
      {
        label: "Tenant setting",
        value: "Enhance admin APIs responses with detailed metadata",
      },
      {
        label: "Tenant setting",
        value: "Enhance admin APIs responses with DAX and mashup expressions",
      },
    ],
    button: "Check the scanner",
    starts: "start_check",
  },
  what_to_sync: {
    why: "The sync reads the workspaces you choose, on the schedule you set. The check counts what the first scan would read.",
    todo: [
      "Choose the workspaces, whether to read personal ones, and when the sync runs.",
    ],
    copy: none,
    button: "Check what the first sync scans",
    starts: "start_check",
  },
  sign_in: {
    why: "Microsoft sign-in is always on, through the app registration. Add Google or any OpenID Connect provider (Okta, Auth0, Keycloak) beside it, and passkeys, so a person who signed in once comes back without Microsoft.",
    todo: [
      "For each provider you add, copy its redirect URI into the provider's own console.",
      "Enter its client id here, and its client secret under Credentials.",
      "Choose whether people may add a passkey.",
    ],
    copy: none,
    button: "Check the sign-in providers",
  },
  who_gets_in: {
    why: "Everyone in your tenant can get in with one role, or nobody until they are given one. Power BI still decides which datasets each person sees.",
    todo: [
      "Give admins and curators their role, by person, email domain or Microsoft group.",
      "Choose the role everyone else in the tenant gets, and who sees a dataset's description.",
    ],
    copy: none,
    button: "Check who gets in",
  },
  search: {
    why: "Search by meaning embeds each metric's text with OpenAI or Gemini, so an agent finds a metric from a question. Without it, agents find metrics by name and by filters.",
    todo: [
      "Choose a provider, or none.",
      "Enter the provider's API key and the model to use.",
    ],
    copy: none,
    button: "Check search",
  },
  agents: {
    why: "Agents read the book through its connector (MCP) or the command line. Nothing to enter here: connect your own agent, and the check sees it arrive.",
    todo: [
      "Add the MCP address to Claude, Codex or Cursor as a remote connector, and sign in when it asks.",
      "Ask the agent to run whoami.",
      "For the command line, install the CLI and sign in with it.",
    ],
    copy: agentValues,
    button: "Check that an agent reached the connector",
  },
  first_sync: {
    why: "The first sync reads every workspace you chose and groups the measures into drafts for your agent to describe. It runs in the worker and can take some minutes.",
    todo: ["Start the sync, and keep this page open to see what it found."],
    copy: none,
    button: "Start the first sync",
    starts: "start_sync",
  },
  security: {
    why: "The checklist of what keeps this server safe. Each item passes, or says why not and what to change.",
    todo: ["Run the checklist, and fix each item that fails."],
    copy: none,
    button: "Check the security checklist",
  },
};

export const isStepId = (id: string): id is StepId => Object.hasOwn(GUIDES, id);
