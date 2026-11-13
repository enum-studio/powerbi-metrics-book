# Simple setup: four screens, with a guide beside each

Status: draft for review, 2026-10-29.

The first run is the first thing a company sees, and today it is ten steps
with eleven fields, two Entra app registrations, a security group, three
Power BI tenant settings and two expiry dates, with no help on where any
of it lives. On the first real run, on a live tenant that already had
everything set up, the admin put the scanner's client id in the sign-in
app's field, the check passed anyway, and Microsoft refused the sign-in
with an error our page never explained. This spec cuts the first run to
four screens and puts a guide beside every step: what to do, the link
that opens the right page in Entra or the Power BI admin portal, and the
value to copy.

It replaces "The first run" in `docs/specs/2026-10-25-powerbi-metrics-book.md`
(Setup and the admin section). Settings, secrets and their encryption do
not change.

## Goal

An admin who already has the app registrations, the group and the tenant
settings finishes setup in under 5 minutes, because each value comes with
the link to the page where it is shown. An admin starting from nothing
finishes in under 30, never guessing which value goes where or which page
to open.

## Decided

- Martin, 2026-10-29: no setup script. The admin does the Entra and Power
  BI work by hand, with a guide that links to each page. This drops the
  earlier draft's Cloud Shell script, its setup code and its public route.

## Settled in decomposition

- The first run is the api's steps `address`, `app_registration`,
  `scanner`, `what_to_sync` and `first_sync`. `setup.completed_at` is set
  when those five pass. `sign_in`, `who_gets_in`, `search`, `agents` and
  `security` stop being setup steps; their checks stay registered, so
  `/admin` and the daily check job run them as today.
- The setup session may run the `scanner` step, beside `address` and
  `app_registration`, because screen 2 comes before the sign-in. The link's
  holder can already set the sign-in app's secret, so this adds no new
  kind of trust. It moves a boundary all the same, so it gets a security
  review and a line in `docs/security/threat_model.md`.
- The screens' addresses: `/setup?step=address`, `microsoft`, `sign-in`,
  `sync` and `done`. The rail maps the api's steps onto them: screen 2 is
  `app_registration` and `scanner`; screen 3 is the confirm that
  `app_registration` already takes, then the Power BI connection; screen 4
  is `what_to_sync` then `first_sync`.

## Not in this spec

- Changing what the stack needs from Microsoft: two app registrations, a
  security group and three tenant settings stay, because the scanner must
  use read-only admin APIs as a service principal and people must query
  as themselves.
- A multi-tenant app published by us. Each company owns its registrations.
- Setting up Google, other OpenID Connect providers, passkeys, email and
  password, search or roles beyond the default during the first run. They
  stay in `/admin`, where they are today.
- Stills and clips of Microsoft's pages. The guide works without them,
  because every step links to its page and names Microsoft's own labels.
  They are added later, from a tenant with no company's data in it.

## The four screens

| Screen | The admin does | What happens |
|---|---|---|
| 1. Address | nothing, unless it is wrong | checked on load; shown only when it fails, with the one fix |
| 2. Connect your Microsoft tenant | goes through five items, each either "I have it" (paste the value) or "Make it" (follow the steps) | each item is ticked as its values check out |
| 3. Sign in | selects Sign in with Microsoft | they become the first admin; the page goes straight on to connect their Power BI, which Microsoft answers without asking again |
| 4. What to sync | keeps or changes the ticked workspaces, selects Start | the first sync starts |

Then a done screen, while the sync runs: what it has found so far, the MCP
address and the CLI line to copy, who gets in (everyone in the tenant as
viewer, with a link to change it), and the security checklist's result,
shown only when an item fails.

The step rail shows the four screens. Each is in one of five states, each
with its own look:

- To do.
- Waiting for you: the admin has something to do outside the page (in
  Entra, in Power BI, signing in).
- Waiting for Microsoft or the worker: a check is running.
- Done.
- Failed: the cause in one sentence and the one thing to change.

"Connect Power BI now" on today's step 2 is a Waiting for you, not a
Failed. Today's page shows it as a failure and offers the next step beside
it.

## The guide column

The right column of every screen is "Do this now". It follows the item
the admin has open, and shows that item's steps only, numbered. Each step
has:

- what to do, in one sentence, naming the button or field by the label
  Microsoft shows ("Select New registration");
- a link that opens that exact page in a new tab, labelled with where it
  goes ("Open App registrations in Entra"), never a bare URL;
- the value to copy, if any, with a copy button (an app's name, a
  redirect URI);
- a live line under the step once the page can see its result
  ("Checked: this app signs in", "Waiting for you").

Under the steps, "Why this is needed" in two sentences, and "Read the full
guide" to the docs page for the screen.

On a phone the column moves under the item it belongs to.

## Screen 2: connect your Microsoft tenant

### The five items

The screen is a list of five items, in this order. Each is ticked when it
checks out. For each, one sentence on what it is, one on why the stack
needs it, and one on what it can never do:

| Item | What it is | Why | What it can never do |
|---|---|---|---|
| Your tenant | the Microsoft tenant your company signs in with | every other item lives in it | |
| The sign-in app | an app registration, suggested name `Power BI Metrics Book (<host>)` | people sign in with Microsoft through it, and query Power BI as themselves | run a query as anyone but the person signed in |
| The scanner app | an app registration, suggested name `Power BI Metrics Book scanner (<host>)` | reads the workspaces' tables, measures and DAX through Power BI's read-only admin APIs | read report data, or change anything in Power BI |
| The scanner's security group | a security group holding the scanner | Power BI lets the scanner in through this group | grant any person any access |
| Three Power BI tenant settings | read-only admin APIs, detailed metadata, DAX expressions | Power BI keeps the admin APIs shut until they are on | apply to anyone outside the group they name |

Above the list, one question: "Have you set these up before, for this or
another tool?" Yes opens every item on "I have it"; No opens every item
on "Make it". Each item can switch on its own, so an admin with the apps
but no group answers Yes and switches one item.

One item is open at a time. Finishing one opens the next.

### Each item

**Your tenant.** The page asks for the admin's work email, finds the
tenant id from its domain through Microsoft's OpenID configuration
(`https://login.microsoftonline.com/<domain>/v2.0/.well-known/openid-configuration`)
and shows the tenant id with the domain it came from, for them to confirm
against "Tenant ID" on the Overview page in Entra. The OpenID
configuration names no company, so the page shows none. "I have it" is a
field for the tenant id, with "Open the Overview page in Entra" where it
is shown.

**The sign-in app.**

- I have it: fields for the client id, the client secret and, optional,
  the secret's end date. Once the client id is in, the guide's links go
  to that app's own pages: "Open this app's Overview" (where the client id
  is shown as "Application (client) ID"), "Open Certificates & secrets"
  (where the end date is shown as "Expires"; the secret's value is shown
  only when it is made, so the admin pastes the one they saved, or makes
  a new one there), "Open Authentication" (to check the two redirect
  URIs, each with a copy button) and "Open API permissions" (to check the
  four permissions and "Granted for <tenant>").
- Make it: "Open New registration in Entra", the name to copy, "Accounts
  in this organizational directory only", Web, the first redirect URI to
  copy; then, on the app's pages, the second redirect URI, the delegated
  permissions (Power BI Service `Dataset.Read.All`; Microsoft Graph
  `openid`, `profile`, `email`, `offline_access`, `User.Read`), "Grant
  admin consent for <tenant>", and a new client secret; then the same
  fields as "I have it".

**The scanner app.** The same two ways, with no API permission and one
less step. The client id is refused when it is the sign-in app's: "These
are the same app. The scanner needs its own registration." This is the
mistake from the first real run.

**The scanner's security group.**

- I have it: "Open Groups in Entra", find the group, and check that the
  scanner app is a member.
- Make it: "Open New group in Entra", Security, the name to copy, then
  Members, Add members, and the scanner app by its name.
- No field: the stack does not need the group's id. The check below
  proves it.

**Three Power BI tenant settings.** One step per setting, each naming the
setting as Microsoft labels it in "Admin portal, Tenant settings, Admin
API settings", with "Open Tenant settings in Power BI"
(`https://app.powerbi.com/admin-portal/tenantSettings`) and the words to
type into its search box:

1. "Service principals can access read-only admin APIs": Enabled,
   Specific security groups, the scanner's group.
2. "Enhance admin APIs responses with detailed metadata": the same.
3. "Enhance admin APIs responses with DAX and mashup expressions": the
   same. Power BI offers this one only once the second is on.

"I have it" shows the same three, as a list to check against. Then
"Check the scanner", which runs today's scanner check in the worker and
shows its result on this item. A change in Power BI's tenant settings
"can take up to 15 minutes" to apply, so a refusal from the admin APIs in
that time shows as "Waiting for Microsoft, up to 15 minutes", retried each
minute, not as a failure.

### The checks

- Each field checks as it is filled, and the item's tick says what was
  checked ("Checked: this app signs in"), so a pass means something.
- The sign-in app's check gets a token with its client id and secret, as
  today. The scanner's check calls the admin APIs, as today.
- An expired secret's refusal from Microsoft (`AADSTS7000222`) shows as
  "The client secret has expired: make a new one in Certificates &
  secrets and enter it here", with the link.
- The secret's end date is optional. Left empty, the status page says the
  expiry is unknown.
- Before screen 3, the page shows the two redirect URIs again with "Open
  Authentication" for the sign-in app, and says what `AADSTS500113` and
  `AADSTS50011` mean, because Microsoft shows those on its own page and
  never sends the admin back.

### The links

Every link is built from a fixed Microsoft address and, where it opens one
app, the client id the admin entered, checked to be a GUID first. They
open in a new tab. The addresses:

| Link | Address |
|---|---|
| Overview (tenant id) | `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/TenantOverview.ReactView` |
| App registrations | `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade` |
| New registration | `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade` |
| One app's page | `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/<page>/appId/<client id>`, where page is `Overview`, `Authentication`, `Credentials` or `CallAnAPI` |
| Groups | `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupsManagementMenuBlade/~/AllGroups` |
| Power BI tenant settings | `https://app.powerbi.com/admin-portal/tenantSettings` |

The implementer opens each one on a real tenant before the work is done,
since Microsoft moves its portal's addresses without notice. The table
lives in one module in `apps/web`, and the docs' setup guide uses the same
addresses.

## Screen 3: sign in, then Power BI

The admin selects Sign in with Microsoft. After the callback makes them
the first admin, the page sends them on to connect Power BI. Microsoft has
the consent already, so it answers at once and the admin sees one sign-in.
No change to how sign-in or the connection keep their tokens.

## Screen 4: what to sync

The screen lists the workspaces the scanner's check found, all ticked,
and the default schedule. Personal workspaces are off by default, and
while they are off the check keeps only their count, never their names:
the screen shows "N personal workspaces, not synced" beside the toggle.
Turning it on saves the setting and runs the check again, which then
lists them. Start saves the choice and starts the first sync. Each of
today's scanner failures keeps its own sentence, now with the link to the
Power BI admin page where it is fixed.

## Expiry dates

Today's warnings at 30 and 7 days stay. "Renew" on the status page links
to the app's Certificates & secrets page and opens the secret's field.

## Security

The changes on a trust boundary, for the security review and
`docs/security/threat_model.md`:

- The tenant lookup fetches Microsoft's OpenID configuration for a domain
  the admin types, through the guarded fetcher, with the domain checked
  as a hostname first. It reads only `issuer`, and from it the tenant id.
- The guide's links go only to `entra.microsoft.com` and
  `app.powerbi.com`, built from a fixed table and a GUID. No address comes
  from the admin's input or from a response.
- The setup session may now run the scanner step, so the link's holder
  sets the scanner's secret before an admin exists, as it already sets the
  sign-in app's.
- One new route, `POST /api/setup/tenant`, behind the setup's existing
  credential check. No new credential or secret. The fields save through
  today's settings service.

## Tests

- The api: the tenant lookup through the mock's OpenID configuration,
  including a domain that is not a hostname and a domain Microsoft does
  not know; the same-app refusal; the optional end date.
- The web app: the guide follows the open item; Yes and No open the items
  on the right way; a link to an app's page carries its client id and
  none is made from a malformed one; the five states.
- An e2e on the mock: the whole first run by "I have it", then by "Make
  it", at 390 and 1440 px, light and dark.

## Build tasks

Shape: sequential, eight tasks on one branch, `feat/simple-setup` from
`main`. Each task is implemented (Codex first, else the `implementer`
agent), then reviewed by the `reviewer` agent before the next starts. Tasks
2 and 3 move a trust boundary and also get the `security-reviewer`. Task
8's link check runs in the main session, because it drives a browser. The prototype is
https://claude.ai/artifact/XmamCRPxn8KFuTnxDjjESd (`project/Main.dc.html`
holds every item's guide text and links).

### 1. The first run is five api steps

- files: `apps/api/src/services/setup/steps.ts`, `steps.test.ts`,
  `setup.test.ts`, `checks.ts`, `app-registration-check.ts` and its test,
  `apps/api/test/setup-support.ts`
- depends: none
- verify: `pnpm --filter @powerbi-metrics-book/api exec vitest run src/services/setup src/routes/setup.test.ts && pnpm typecheck`
- budget: 250 lines changed
- What: `STEPS` keeps all ten checks registered, but a new exported
  `FIRST_RUN: readonly StepId[] = ["address", "app_registration",
  "scanner", "what_to_sync", "first_sync"]` decides `setup.completed_at`
  in `markStep`, and `setupState` returns only those five in `steps`. The
  scanner step refuses a `powerbi.scanner_client_id` equal to the stored
  or given `powerbi.app_client_id` with `ServiceError("invalid", "These
  are the same app. The scanner needs its own registration.")`. The
  app registration check turns Microsoft's `AADSTS7000222` into "The
  client secret has expired: make a new one in Certificates & secrets and
  enter it here."
- First failing test: a setup whose five first-run steps pass has
  `completed_at` set while `search` has never run.

### 2. The setup session runs the scanner step

- files: `apps/api/src/services/setup/steps.ts` (`SETUP_SESSION_STEPS`),
  `apps/api/src/routes/setup.ts`, `apps/api/src/services/setup/setup_link_security_test.ts`,
  `docs/security/threat_model.md`
- depends: 1
- verify: `pnpm --filter @powerbi-metrics-book/api exec vitest run src/services/setup src/routes/setup.test.ts`
- budget: 120 lines changed
- What: `SETUP_SESSION_STEPS` becomes `["address", "app_registration",
  "scanner"]`. The security test gains: the setup session runs the scanner
  step while no admin exists, and is refused it (404, as today) once an
  admin exists. No existing assertion is loosened (rule 15).
- First failing test: a setup session posts the scanner step and gets a
  result, not a 404.

### 3. The tenant lookup

- files: `apps/api/src/services/setup/tenant-lookup.ts`,
  `tenant-lookup.test.ts`, `tenant_lookup_security_test.ts`,
  `apps/api/src/routes/setup.ts`, `packages/powerbi-mock/src/entra/routes.ts`
  and its test, `docs/security/threat_model.md`
- depends: 2
- verify: `pnpm --filter @powerbi-metrics-book/api exec vitest run src/services/setup src/routes/setup.test.ts && pnpm --filter @powerbi-metrics-book/powerbi-mock test`
- budget: 250 lines changed
- What: `lookupTenant(deps, email: string): Promise<{ tenant_id: string;
  domain: string }>` takes the part after `@`, refuses anything that is not
  a hostname, fetches
  `<authority origin>/<domain>/v2.0/.well-known/openid-configuration`
  through the guarded fetcher, reads only `issuer`, and returns the GUID in
  it. An unknown domain is `ServiceError("not_found", "Microsoft knows no
  tenant for <domain>. Paste the tenant ID from the Overview page in
  Entra instead.")`. `POST /api/setup/tenant` with `{ email }` sits behind
  the same credential middleware and rate limit as the steps, for the
  setup session and an admin. The mock answers that address for its
  tenant id and the sample tenant's domains, and 400 for any other, as
  Microsoft does.
- First failing test: the lookup of the sample tenant's domain on the mock
  returns the sample tenant's id.

### 4. The four screens and the rail

- files: `apps/web/src/routes/setup.tsx`, `apps/web/src/setup/rail.tsx`,
  `apps/web/src/setup/screens.ts` and its test, `apps/web/src/setup/done.tsx`,
  `apps/web/src/setup/api.ts`
- depends: 3
- verify: `pnpm --filter @powerbi-metrics-book/web exec vitest run src/setup && pnpm --filter @powerbi-metrics-book/web typecheck`
- budget: 400 lines changed
- What: `screens.ts` exports `SCREENS` (address, microsoft, sign-in,
  sync, done), `screenOf(setup): ScreenId` and `standing(setup, screen):
  "to_do" | "you" | "waiting" | "done" | "failed"`, the five states. The
  rail shows four screens in those states. The route takes
  `?step=<screen>`. The done screen holds the MCP address and CLI lines
  (`agentValues`), who gets in with a link to `/admin`, and the security
  checklist's failing items only. Today's step panel stays the body of
  screens 1, 3 and 4 until tasks 6 and 7 replace them.
- First failing test: `standing` gives "waiting" for screen 2 while the
  scanner's check is pending in the worker.

### 5. The guide's links and words

- files: `apps/web/src/setup/links.ts` and its test,
  `apps/web/src/setup/guide.ts` and `guide.test.ts`
- depends: 4
- verify: `pnpm --filter @powerbi-metrics-book/web exec vitest run src/setup`
- budget: 350 lines changed
- What: `links.ts` holds the spec's link table as data, `appPage(page:
  "Overview" | "Authentication" | "Credentials" | "CallAnAPI", clientId:
  string): string | null` (null unless the id is a GUID), and nothing that
  builds an address from anything else. `guide.ts` becomes the five
  items' guides, each `{ have: GuideStep[]; make: GuideStep[]; why:
  string }` with `GuideStep = { text: string; links: Link[]; copies:
  CopyValue[] }`, worded as in the prototype.
- First failing test: `appPage("Authentication", "not-a-guid")` is null.

### 6. Screen 2: the five items and the guide column

- files: `apps/web/src/setup/microsoft.tsx`,
  `apps/web/src/setup/guide-column.tsx`, `apps/web/src/setup/fields.tsx`,
  `apps/web/src/setup/step.tsx`
- depends: 5
- verify: `pnpm --filter @powerbi-metrics-book/web exec vitest run src/setup && pnpm --filter @powerbi-metrics-book/web typecheck && pnpm --filter @powerbi-metrics-book/web check:ui`
- budget: 450 lines changed
- What: as the prototype's boards 1 to 6. The "set up before" question,
  one item open at a time, "I have it" and "Make it" per item, fields under
  their item, the scanner's same-app refusal shown as the client types,
  the expiry fields optional, "Check the scanner" with "Waiting for
  Microsoft, up to 15 minutes" retried each minute, and the redirect URIs
  with "Open Authentication" before screen 3. The guide column follows the
  open item; on a phone it moves under the item.
- First failing test: pasting a GUID as the sign-in app's client id turns
  the guide's links into that app's own pages.

### 7. Screens 3 and 4, and the end to end test

- files: `apps/web/src/setup/sign-in.tsx`, `apps/web/src/setup/sync.tsx`,
  `apps/web/src/setup/step.tsx`, `apps/web/e2e/setup.spec.ts`
- depends: 6
- verify: `pnpm --filter @powerbi-metrics-book/web test:e2e -- setup.spec.ts`
- budget: 400 lines changed
- What: screen 3 is the sign-in, the confirm, then straight on to the
  Power BI connection. Screen 4 lists the workspaces from the
  `what_to_sync` check, all ticked, with only a count of personal ones
  while they are off, and Start saves
  them and starts `first_sync`. The e2e runs the whole first run on the
  mock by "I have it" and by "Make it", at 390 and 1440 px, light and dark.
- First failing test: the e2e's "I have it" run reaches the done screen.

### 8. The docs, and every link on a real tenant

- files: `apps/docs/src/content/docs/set-up/*`,
  `apps/docs/scripts/check-setup-sentences.mjs`
- depends: 7
- verify: `pnpm --filter @powerbi-metrics-book/docs check && node scripts/check-text.mjs apps/docs/src/content/docs/set-up`
- budget: 500 lines changed, most of it prose
- What: the set-up pages follow the four screens and use the addresses in
  `links.ts`; the check script fails when a page lacks one. The main
  session opens every address in `links.ts` on a real tenant, read-only,
  and fixes any that Microsoft has moved.

Then tier 3 (`pnpm check:all`) once, and one pull request.
