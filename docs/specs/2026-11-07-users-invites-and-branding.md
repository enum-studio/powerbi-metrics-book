# Users, invites, sign-in and branding

An admin adds the people who should have access, and each gets a standard
invite: an email (or a link to send) that names who invited them, the role,
and when it expires. People are stored in the app, can be deactivated and
reactivated, and the sign-in and invite pages carry the company's own name
and logo. A small company starts with nothing but Microsoft sign-in and
invites; an enterprise later adds allowed domains, Entra groups, SCIM and
single sign-on only, without a rewrite.

Status: draft for Martin's review, 2026-11-07. Mode: spec fast. A sensitive
path (auth): every build task ends in a security review and an update to
`docs/security/threat_model.md`.

## What Martin asked, and what is assumed

Asked:

- User management lives in the app and is stored in the app. An admin adds
  people; they get a standard invite with sending, expiry, resend and revoke.
- Easy for a small company, flexible enough for an enterprise.
- A new deployment lets in only invited people (answered 2026-11-07).
- Roles on screen are Admin, Curator and Viewer (answered 2026-11-07).
- The sign-in page should look much better (2026-11-07, with a screenshot
  of today's page: a wide card holding one button under the app header).
- A company can add its logo and brand name so the product feels like its
  own (2026-11-07).

Assumed, for Martin to correct:

- Microsoft stays the main way in. A password is for people the company does
  not want to send through Microsoft, as today.
- Deactivate is the main way to remove someone. Delete exists only for a
  person already deactivated.
- An invite lasts 7 days.
- Branding is a name and a logo. Colors stay the product's own.

## Non-goals

- Billing, seats or plans.
- Guest access to part of the book. Visibility already follows Power BI.
- Accent colors, custom fonts, a custom domain per company, or a favicon from
  the logo. Listed under Later.
- SMTP. The stack sends only over HTTPS through the guarded fetcher.
- Any change to rule 5: every query still runs with the person's own
  delegated Power BI token. Nothing here touches the query path.

## What exists today

Read on 2026-11-07 at `0e413156`.

| Part | Where | What it does |
|---|---|---|
| People | Better Auth `user`, `account`, `session` (`apps/api/src/db/schema/auth.ts`) | A `user` row is made at the first sign-in, or when a password invite is accepted. Email is unique. Implicit account linking is off. |
| Roles | `role_assignment` (`schema/roles.ts`), `resolveRoles` (`services/auth/roles.ts`) | A role reaches a person by verified email, by email domain (only when a sign-in vouched for the domain), by group within the provider that named it (Entra groups by object id), or by being in the tenant. Resolved on every request, never kept in a session. `access.default_role` covers a tenant member no assignment reaches; its default is `viewer`. |
| Shipped roles | `services/access/shipped-roles.ts`, `access/policies/` | `viewer`, `curator`, `admin`, `pii_reader`. Others need `--custom`. Admin and pii_reader go to a person or group only (a database CHECK). |
| Last admin | `services/admin/people.ts` `hasAdmin`, `db/sql/tenant.sql` `deployment_has_admin()` | The last admin assignment to a person cannot be revoked. No admin reopens the setup link. |
| Invites | `invite` table (`schema/invites.ts`), `invitePerson` (`services/auth/invites.ts`) | Assigns the role to the email at once, then sends a password link (72 hours) when password sign-in is on, or a bare "Sign in" email. Inviting again ends the earlier link. No list, no resend, no revoke. |
| Sign-in gate | `admitAtSignIn`, `admitSession` (`services/auth/sign-in.ts`) | Refuses anyone no role reaches, before an account is made and again when a session is made. |
| Microsoft identity | `mapProfileToUser` in `better-auth.ts`, `person_identity` | Email is the `email` claim, else `preferred_username`. It counts as verified only when `tid` is the configured tenant. The account row keeps the Microsoft account, so later sign-ins find the person by it. |
| Email | `services/auth/email.ts` | Resend's `/emails` through `deps.fetcher.fetchFixed`, with `resend_api_key` and `email.from`. The mock keeps an outbox the tests read. |
| Admin UI | `apps/web/src/admin/access/` | **Users and roles**: an Invite by email form, a Users table (email, sign-in method, last seen, roles and where each comes from, Power BI connection, MCP and CLI grants with Revoke), role assignments, and Who would get in. |
| Sign-in page | `apps/web/src/routes/sign-in.tsx`, `GET /api/auth/config` | The app header, a heading, and one wide card of provider buttons. |

What is missing: invited people are invisible until they sign in; an invite
cannot be listed, resent or revoked; an expired invite still lets the person
in, because the role was assigned at once; nobody can be deactivated, and a
person the default role reaches gets back in after their assignments are
revoked; there is no branding.

## The design

### 1. People have a status

A person is **Invited**, **Active** or **Deactivated**.

- **Invited**: an open invite and no `user` row yet. Listed under Pending
  invites, not under Users.
- **Active**: a `user` row and no deactivation.
- **Deactivated**: a row in the new `person_deactivation` table. Deactivation
  beats every assignment, group, domain, the default role and the setup's
  sign-in.

The check sits in one place: `roleSubject` reads the deactivation, and
`resolveRoles` answers `[]` for a deactivated person. Sign-in, every session
and bearer request (`principal.ts`), and the Users list all go through those
two functions, so no path can miss it.

### 2. An invite holds the role until it is accepted

Today the role is assigned when the invite is sent. That makes expiry and
revoke meaningless for Microsoft sign-in. From now on:

- The invite row carries the role. While it is open and unexpired, it reaches
  the person exactly as a person assignment would: by verified email.
- **Accepting** an invite converts it: in one transaction, the invite gets
  `accepted_at` and `accepted_user_id`, and a person assignment of its role to
  the user's stored email is inserted (unless an equal one exists).
- A person accepts by signing in with a verified email that has an open
  invite, by any enabled provider. They do not need to click the link. The
  link only opens the invite page.
- Expired or revoked, the invite reaches nobody.

Invites already sent keep their assignments: the migration (Data changes)
does not remove any `role_assignment` row.

### 3. Sending, expiry, resend and revoke

- **Invite people** takes 1 to 50 emails and one role: Viewer, Curator or
  Admin (a custom role through the CLI's `--custom`). PII stays a separate
  switch on the person, given after they join.
- **Expiry**: 7 days from the last send.
- **Delivery** is `email` or `link`:
  - `email` sends the invite through Resend. It needs `resend_api_key` and
    `email.from`.
  - `link` shows the admin the link once, to send themselves in Teams or
    Slack. It needs no email setup. With email not set up, `link` is the only
    choice and the dialog says why.
- **Resend** makes a new token, ends the old one, moves expiry to 7 days from
  now and sets `last_sent_at`. A `link` invite resent shows a new link. At
  most once a minute and 10 times a day per invite (`countRequest`).
- **Revoke** sets `revoked_at` and `revoked_by`. The link and the email's
  sign-in stop working at once.
- Inviting an email that has an open invite resends it with the new role.
  Inviting an Active person is refused: "x is already a user. Change their
  role instead." Inviting a Deactivated person is refused: "Reactivate x
  instead."
- An admin may invite only within `access.invite_domains` when it is set
  (Later; the check point is `invitePerson`).

### 4. How an invited person signs in

Microsoft, Google and any OpenID Connect provider prove the email
themselves, so for them the invite token is not a credential. It only lets
the invite page show who invited whom. A password is different: setting it
through the link is what proves the mailbox, as today.

| Way in | Needs | Proves the email by |
|---|---|---|
| Microsoft (always on) | an account in the configured tenant, guests included | the tenant's directory (`tid` matches) |
| Google, OpenID Connect | the provider on in Authentication | the provider's verified email |
| Password | `sign_in.email_password` on, and the invite sent by email | opening the link from the mailbox |

Rules:

- An invite with delivery `link` can never set a password: the admin saw the
  link, so it proves nothing about the mailbox. `/invites/accept` refuses it
  with the same sentence as an invalid token.
- A person who already has a provider account cannot set a password, as
  today.

**Binding to an Entra identity.** The first Microsoft sign-in that accepts
the invite stores the Microsoft account in `account` and its object id in
`person_identity`, as every Microsoft sign-in does. From then on Better Auth
finds the person by that account, not by email, so a later change of email in
Entra does not make a new person. The role assignment stays on the email
stored at acceptance, which Better Auth does not overwrite on sign-in.

Matching an invite trusts the email Microsoft sends, and Entra fills the
`email` claim from the directory's `mail` attribute, which on-premises
directory staff can write in a hybrid tenant. So sign-in issue i-2kcc lands
first: the email claim counts only when Entra verified it (`xms_edov`), else
the UPN, whose domain the tenant verified. Without it, someone who can write
their own `mail` attribute could take an open admin invite.

When the Microsoft account's email differs from the invite (an alias, or a
UPN that differs from the mail address), the sign-in is refused with
`not_assigned`. The invite page prevents most of these: it says "Sign in as
x". SCIM (Later) removes the rest by binding the object id before the first
sign-in.

### 5. Roles

Admin, Curator and Viewer on screen, `admin`, `curator` and `viewer` in the
data and CLI. One direct role per person, chosen on the Users page:

| Role | On screen |
|---|---|
| Viewer | Reads the book and queries Power BI with their own rights. |
| Curator | Also changes metrics, terms and categories. |
| Admin | Also manages users, settings and the Power BI connection. |

- **Change role** replaces the person's direct shipped-role assignment (person
  kind, roles viewer, curator or admin) with the new one in one transaction,
  under the last-admin rule.
- A role that comes from a group, domain or the default role shows as "Viewer
  from group Finance" and is changed where it comes from.
- **Can read PII** is a switch on the person that adds or removes their
  `pii_reader` assignment. It stays apart from the role, because admins do
  not get PII by being admins.
- Custom roles stay where they are: role assignments and `pbmb admin roles`.

### 6. Who can sign in, by default

- A new deployment lets in only invited people: the first-run setup stores
  `access.default_role` = `none` when it binds the tenant, in the same
  transaction, unless a value is stored or set in the environment.
- A deployment that already finished setup keeps what it has: the registry
  default stays `viewer`, so one that never stored a choice still lets in its
  tenant as viewers. No migration writes a setting (a migration is only what
  `db:generate` writes, docs/decisions/architecture.md).
- The setup's Who gets in screen leads with **Only people I invite**, then
  **Everyone at the company as Viewer**, then **as Curator**. Its add field
  sends invites instead of writing assignments.
- The Users page states it in one line above the table: "Who can sign in:
  only people you invite. Change", which opens the same choice.

### 7. Deactivate, reactivate and delete

**Deactivate** (on the person's menu, with a confirm naming them):

1. Inserts `person_deactivation`.
2. Deletes every session of the person.
3. Revokes every MCP and CLI grant (`revokeGrantsOf`).
4. Ends their Power BI connection: clears its delegated tokens and marks it
   disconnected, so no delegated token of theirs stays stored.

Steps 1 to 4 run in one transaction. Then it audits `people.deactivate`
through the audit role's own connection, as every audit row is written, so
the row follows the commit rather than sharing it. Their book changes, threads and audit rows keep their
name. Their role assignments stay, so Reactivate restores them as they were.

Refused: deactivating yourself ("Ask another admin"), and deactivating the
last active admin.

**Reactivate** deletes the row and audits `people.reactivate`. The person
signs in again and reconnects Power BI.

**Delete** (only for a Deactivated person, with a typed confirm of the email)
deletes the `user` row, which cascades to sessions, accounts, passkeys, the
Power BI connection and sign-ins, and deletes their `person_identity` row
(it has no foreign key) and the person assignments to their email. History then names them "a removed person" (`REMOVED_PERSON`). The
audit log keeps its rows, email included, as the record of who had access.
If a group, domain or the default role still reaches the email, the person
can sign in again as a new user; the confirm says so.

**The last-admin rule** now counts only admin person assignments whose email
belongs to no deactivated user, in both `hasAdmin` and
`deployment_has_admin()`.

### 8. Email

Resend stays the one sender, through `fetchFixed` and `email.base_url`. No
new outbound host.

The invite email:

- Subject: `{inviter name} invited you to {brand name}`
- Body: "{inviter name} invited you to {brand name} as a {Role}. {brand name}
  lets your AI agent look up what your Power BI numbers mean and query them
  with your own Power BI rights." A button **Accept invite** to the invite
  page. "This invite expires on {date}." "If you did not expect it, you can
  ignore this email."
- The logo, when set, as an `<img>` of the public logo address, with the brand
  name as its alt text.
- Every value is escaped in HTML. Plain text and HTML parts, as today.

The reset email gets the same brand name and logo. `sendEmail` keeps its
signature, so a second sender later (Microsoft Graph `sendMail` from a shared
mailbox) is one more implementation behind it.

### 9. The Users and roles page

References: [Plane members with pending invites](https://mobbin.com/screens/d1e224bf-6308-4010-8a47-506f2a89662a),
[Canny invited and active, with Resend and Revoke](https://mobbin.com/screens/a4516f0d-22bf-4657-a006-a6fa58a2d173),
[Calendly pending users with date invited and last sent](https://mobbin.com/screens/3cd7e903-497a-4087-aa32-e4efd0ba2810),
[Plain role picker with one line per role](https://mobbin.com/screens/a35e7ed0-236e-420d-8c46-981f92d0c464).
Tokens, type and radius come from `@enum-studio/tokens`, as on every admin
page.

- Title **Users and roles**, with **Invite people** as the primary button on
  the right.
- The Who can sign in line (6).
- Tabs: **Users** (count), **Pending invites** (count), **Groups and
  domains** (today's role assignments and Who would get in).
- **Users** table: Name and email, Role (a select for a direct role; text for
  an inherited one), Status (Active or Deactivated), Signs in with, Last seen,
  and a menu: Change role, Can read PII, Deactivate or Reactivate, Delete.
  Clicking a row opens a side panel with every role and where it comes from,
  the Power BI connection, and the MCP and CLI connections with Revoke.
- **Pending invites** table: Email, Role, Invited by, Last sent, Expires (or an
  Expired badge), and Resend, Copy link (for a `link` invite) and Revoke.
- **Invite people** dialog: emails separated by commas or spaces, shown as
  chips; the role as three radio rows with their one line each; **Send
  invites**, and **Create invite link instead** (one email only). Without
  email set up: only **Create invite link**, with "Email is not set up, so you
  send the link yourself. Set up email in Authentication."
- At phone width the tables stack into one card per row, as PR 58 did for the
  other admin tables.

### 10. The sign-in and invite pages

References: [Plain sign-in with Last used](https://mobbin.com/screens/42ecbd80-9dc0-4982-8143-950274a2149e),
[Twenty](https://mobbin.com/screens/835d1dd7-22aa-4027-b448-591fce5b32c2),
[Gumloop](https://mobbin.com/screens/ffb9ac48-4dce-4c7d-bdcd-389048d6e01a).
All three are a narrow centered column with the mark above it, the provider
buttons with their real logos, and nothing else on the page.

**Sign-in** (`/sign-in`):

- No app header. A centered column 22rem wide on every screen.
- The company logo when set, else the product mark. Under it: "Sign in to
  {brand name}", and one line: "Use your {company} Microsoft account." when
  only invited people get in, or the host name when no company name is set.
- Provider buttons with their own marks: Microsoft's four squares (Microsoft's
  sign-in button guidance), Google's G, a key for an OpenID Connect provider
  with its name. A **Last used** tag on the button used last on this browser
  (kept in `localStorage`, read in a try).
- When password sign-in is on: a divider "or", then email and password, and
  Forgot password.
- A refusal shows inside the column as an alert with the next step, for
  example `not_assigned`: "You do not have access yet. Ask an admin of
  {brand name} to invite you."
- Footer: "Only people an admin invites can sign in." (or "Anyone at
  {company} can sign in with Microsoft.") and, when a brand is set, "Powered by
  Power BI Metrics Book". The Sample data badge stays above the heading on the
  sample tenant (rule 17). The theme switch moves to the bottom corner.

**Invite** (`/invite#token=<token>`, the token in the fragment and removed on mount,
as `/set-password` does):

- The same column. "{inviter name} invited you to {brand name}", "You will
  join as a {Role}." and "Sign in as {email}."
- The provider buttons, and **Set a password** when password sign-in is on
  and the invite was emailed.
- Expired: "This invite expired on {date}. Ask {inviter name} to send a new
  one." Revoked, unknown or already used: "This invite is no longer valid.
  Sign in, or ask an admin for a new one." with a link to sign in.

`/set-password` and `/forgot-password` move into the same column.

### 11. Branding

- **Settings, General** (a new admin nav item in System, first in its
  section): Company name and Logo.
- `branding.name`: text, 1 to 60 characters, null by default. The brand name
  is this, else "Power BI Metrics Book".
- `branding.company`: text, 1 to 60 characters, null by default, used in "Use
  your {company} Microsoft account." When null, that line names the host.
- Logo: PNG, JPEG or WebP, at most 256 KB, read from its first bytes and never
  from the client's content type. SVG is refused, because an SVG can carry
  script. Never fetched from a URL, so no outbound request. Square works
  best; the page shows it at 40 pixels high.
- Shown on: the sign-in, invite, set-password and forgot-password pages, the
  app header (logo and name in place of the product mark and name), the
  browser title ("{page} · {brand name}"), and the invite and reset emails.
- `pbmb whoami` and the MCP instructions keep the product name, so an agent
  always knows what it is talking to.

## Interfaces

### Data changes (one migration)

The migration is exactly what `db:generate` writes. `invite` keeps
`used_at` in this change. The next release stops reading it, and migration
0004 drops it, so no replica still serving reads a column that is gone.
`token_sha256` stays the primary key, with `id` unique beside it:
drizzle-kit cannot generate the drop of a key declared on a column
(`docs/decisions/architecture.md`).

`invite`, reworked:

```ts
invite = pgTable("invite", {
  token_sha256: text("token_sha256").primaryKey(), // hex64, as today's CHECK
  id: uuid("id").notNull().unique().defaultRandom(),
  email: text("email").notNull(),                 // lower case, as today's CHECK
  role: text("role").notNull(),                   // same CHECK as role_assignment_role
  delivery: text("delivery", { enum: ["email", "link"] }).notNull().default("email"),
  invited_by: text("invited_by").notNull(),
  created_at: timestamptz("created_at").notNull().defaultNow(),
  last_sent_at: timestamptz("last_sent_at"),     // null only on an invite made before 0003
  used_at: timestamptz("used_at"),                // dropped by 0004
  expires_at: timestamptz("expires_at").notNull(),
  accepted_at: timestamptz("accepted_at"),
  accepted_user_id: text("accepted_user_id").references(() => user.id, { onDelete: "set null" }),
  revoked_at: timestamptz("revoked_at"),
  revoked_by: text("revoked_by"),
});
// unique index invite_open_email on (email) where used_at is null and accepted_at is null and revoked_at is null
// (0004: where accepted_at is null and revoked_at is null)
// check: accepted_at is null or revoked_at is null
// grants: api_rw select, insert, update
```

Existing rows: `id` generated and `delivery` = `email` by their defaults,
and `last_sent_at` null until `db/sql/upgrade_invites.sql` sets it. That
file, idempotent and run on every start, ended the old used invites: a row
with `used_at` set and neither `accepted_at` nor `revoked_at` became
accepted (`accepted_at` = `used_at`, `accepted_user_id` = the user of that
email) when a user with a credential account had that email, and revoked
(`revoked_at` = `used_at`) otherwise. Those two statements went with
`used_at` in 0004.

`person_deactivation`, new:

```ts
personDeactivation = pgTable("person_deactivation", {
  user_id: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  deactivated_at: timestamptz("deactivated_at").notNull().defaultNow(),
  deactivated_by: text("deactivated_by").notNull(),
});
// grants: api_rw select, insert, delete
```

`brand_logo`, new, one row at most:

```ts
brandLogo = pgTable("brand_logo", {
  id: boolean("id").primaryKey().default(true),   // CHECK id
  content_type: text("content_type", { enum: ["image/png", "image/jpeg", "image/webp"] }).notNull(),
  bytes: bytea("bytes").notNull(),                // CHECK octet_length(bytes) <= 262144
  sha256: text("sha256").notNull(),
  updated_at: timestamptz("updated_at").notNull().defaultNow(),
});
// grants: api_rw select, insert, update, delete
```

Settings (`services/settings/registry.ts`): `access.default_role` keeps its
default `viewer`, and setup stores `none` (section 6); new `branding.name`
and `branding.company` (string 1 to 60, nullable).

`db/sql/tenant.sql`: `deployment_has_admin()` gains the deactivation
condition, with the same predicate as `hasAdmin`.

### Services

```ts
// services/auth/roles.ts
type RoleSubject = { /* as today */ deactivated: boolean; open_invite_role: string | null };
// roleSubject reads person_deactivation by user id, and the open unexpired invite by verified email.
// resolveRoles: deactivated → []; open_invite_role joins the roles found.

// services/auth/invites.ts
invitePeople(context, input: { emails: string[]; role: string; delivery: "email" | "link"; custom?: boolean })
  : Promise<{ invites: { id: string; email: string; expires_at: Date; link: string | null }[] }>
listInvites(context): Promise<InviteRow[]>            // open and expired, not accepted or revoked
resendInvite(context, id: string): Promise<{ expires_at: Date; link: string | null }>
revokeInvite(context, id: string): Promise<void>
acceptOpenInvite(db: Db, person: Person, now: Date): Promise<boolean>   // called from admitSession
lookupInvite(deps, token: string): Promise<InviteLookup>                // public, rate limited

type InviteLookup =
  | { state: "open"; email: string; role: string; inviter_name: string; expires_at: Date; password_allowed: boolean }
  | { state: "expired"; inviter_name: string; expires_at: Date }
  | { state: "invalid" };                                               // revoked, accepted or unknown

// services/admin/people.ts
deactivatePerson(context, userId: string): Promise<void>
reactivatePerson(context, userId: string): Promise<void>
deletePerson(context, userId: string): Promise<void>   // only when deactivated
setPersonRole(context, userId: string, role: "viewer" | "curator" | "admin"): Promise<void>
setPiiReader(context, userId: string, allowed: boolean): Promise<void>
// listPeople adds status: "active" | "deactivated" and deactivated_at.

// services/admin/branding.ts
putLogo(context, bytes: Uint8Array): Promise<void>     // sniffs type, refuses SVG and > 256 KB
deleteLogo(context): Promise<void>
readLogo(deps): Promise<{ content_type: string; bytes: Uint8Array; sha256: string } | null>
```

Every admin service calls `requireAdmin` first: `manage_people` for people
and invites, `manage_settings` for branding. Audit actions:
`people.invite`, `people.invite_resend`, `people.invite_revoke`,
`people.invite_accept`, `people.deactivate`, `people.reactivate`,
`people.delete`, `role.change`, `branding.update`.

### Routes

Admin (bearer or session, Cerbos `admin`, refused to service accounts):

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/v1/admin/people` | | as today, with `status` and `deactivated_at` |
| `PUT /api/v1/admin/people/{id}/role` | `{ role }` | 204 |
| `PUT /api/v1/admin/people/{id}/pii` | `{ allowed }` | 204 |
| `POST /api/v1/admin/people/{id}/deactivate` | | 204 |
| `POST /api/v1/admin/people/{id}/reactivate` | | 204 |
| `DELETE /api/v1/admin/people/{id}` | | 204 |
| `GET /api/v1/admin/people/invites` | | `{ invites }` |
| `POST /api/v1/admin/people/invites` | `{ emails, role, delivery, custom? }` | `{ invites }`, `link` only for `link` |
| `POST /api/v1/admin/people/invites/{id}/resend` | | `{ expires_at, link }` |
| `DELETE /api/v1/admin/people/invites/{id}` | | 204 |
| `PUT /api/v1/admin/branding/logo` | the image bytes | 204 |
| `DELETE /api/v1/admin/branding/logo` | | 204 |

Public (each on the public-paths list with its own line in its security
test):

| Method and path | What |
|---|---|
| `POST /api/auth/invites/lookup` | `{ token }` in the body, never the URL. Rate limited by client address. Answers `InviteLookup`. |
| `GET /api/auth/config` | today's answer plus `brand: { name: string; company: string \| null; logo_url: string \| null }` and `invite_only: boolean` |
| `GET /api/branding/logo` | the bytes with the stored content type, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: public, max-age=300`, `ETag` from the digest; 404 when none |
| `/invite` | the SPA page, added to `SPA_PATHS` |

`POST /api/auth/invites/accept` (today's password endpoint) keeps its shape
and also refuses an invite with delivery `link`.

### CLI

In `apps/cli/src/powerbi_metrics_book/commands/admin.py`, under `pbmb admin
people`:

```
pbmb admin people                                   # users, with status
pbmb admin people invite <email>... --role <role> [--link] [--custom]
pbmb admin people invites                           # pending and expired
pbmb admin people resend <email>
pbmb admin people revoke-invite <email>
pbmb admin people role <email> <viewer|curator|admin>
pbmb admin people deactivate <email>
pbmb admin people reactivate <email>
pbmb admin people delete <email>                    # asks for the email again
```

The CLI finds the id by email from the lists; the api takes ids.

## How it is tested

Tier 1 beside each change; tier 2 for the areas; tier 3 before the pull
request.

Security tests (`*_security_test.ts`), each a case that must be refused:

- A deactivated person is refused at Microsoft sign-in, by an existing
  session, by an MCP bearer token and by a CLI token, even when a group, a
  domain, the default role or the setup's sign-in would reach them.
- Deactivation deletes their sessions, grants and Power BI connection, in one
  transaction.
- Nobody deactivates themself or the last active admin; two admins
  deactivating each other at once leave one.
- An expired or revoked invite admits nobody, by sign-in or by
  `/invites/accept`.
- An invite with delivery `link` cannot set a password.
- `invites/lookup` answers `invalid` the same way for revoked, accepted and
  unknown tokens, takes the token only in the body, and is rate limited.
- A non-admin, and a service account with every role, is refused every new
  admin route (the authorization matrix).
- The logo: SVG, HTML, a PNG header on a script, and 256 KB plus one byte are
  refused; the logo answer carries nosniff and the CSP.
- The default-role migration leaves an existing deployment at `viewer` and a
  new one at `none`.

Browser specs: invite by email, the email in the mock outbox, accept by
Microsoft on the mock tenant; copy link; resend and revoke; deactivate and
reactivate; the sign-in and invite pages at phone width, light and dark,
with and without a brand.

## Later, without a rewrite

| Need | What it adds | Where it plugs in |
|---|---|---|
| Allowed email domains | `access.invite_domains` (list); invites outside it refused | `invitePeople` |
| Anyone at a domain | exists: an `email_domain` role assignment | Groups and domains tab |
| Entra group to role | exists: a `group` assignment with provider `microsoft`, overage read through Graph | Groups and domains tab |
| SCIM 2.0 | `/scim/v2/Users` and `/Groups` with a SCIM token stored as a digest; create is an invite with delivery `none` and the Entra object id bound before sign-in; `active: false` is a deactivation; delete is a deactivation | `invite` (one more delivery value and an `external_id`), `person_deactivation` |
| Single sign-on only | exists: `sign_in.email_password` off. With SCIM, a setting that refuses invites made by hand | `invitePeople` |
| Okta, Auth0, another tenant | exists: OpenID Connect providers in Authentication | |
| Disabled in Entra | the delegated token's refresh fails at once; a refresh refused as disabled (`AADSTS50057`) deactivates the person | the connection's refresh path |
| Email from the company's own mailbox | Microsoft Graph `sendMail` from a shared mailbox, behind `sendEmail` | `services/auth/email.ts` |
| Accent color, favicon | `branding.accent` checked for contrast; a favicon made from the logo | `branding` settings |

## Decisions to record

In `docs/decisions/access.md`, when built: an invite holds the role until
accepted; a `link` invite never sets a password; deactivation beats every
assignment and lives in `roleSubject`; the default role is `none` for new
deployments only. In `docs/decisions/look.md`: the logo is never SVG and never
fetched.

## Delivery order

Approved by Martin 2026-11-07. Shape: waves, 13 issues in 6 waves on the
integration branch `build/users-invites`, tagged `users-invites` in sudocode.
Each issue carries its `files:`, `depends:`, `verify:` and `budget:`; the
dependencies are `depends-on` links, so `sudocode ready` is the queue.

| Wave | Issue | What | Model |
|---|---|---|---|
| 1 | i-2kcc | Trust a Microsoft email only when Entra verified it (widened for invites) | Codex |
| 1 | i-4wow | Data: invite rework, `person_deactivation`, `brand_logo`, settings, migration | Opus, data migration |
| 2 | i-7ok9 | Gate: deactivation in `roleSubject`, open invites admit, `acceptOpenInvite`, `hasAdmin` | Opus, sign-in gate |
| 2 | i-8ahx | Branding service: logo storage and `brandOf` | Codex |
| 3 | i-8o4g | Invite service: send, list, resend, revoke, lookup, the invite email | Opus, invite tokens |
| 3 | i-46md | People: deactivate, reactivate, delete, role, PII | Codex |
| 4 | i-2e87 | Routes: admin and public routes, logo endpoint, matrix, OpenAPI | Codex |
| 5 | i-7wo6 | CLI: `pbmb admin people` commands | Codex |
| 5 | i-3o75 | Users and roles page, invite dialog, setup screen | Codex, Martin looks |
| 5 | i-53bc | Sign-in, invite, set-password and forgot-password pages | Codex, Martin looks |
| 5 | i-7258 | Settings General and the brand in the header | Codex, Martin looks |
| 5 | i-3v57 | Decisions, threat model, spec and admin guide | Codex |
| 6 | i-8a9n | Security review by `security-reviewer`, then `pnpm check:all` | Opus reviewer |

Every implementer branch gets a `reviewer` (Opus) before it merges into the
integration branch. Wave 5's three web issues touch the nav and shell that
session local_9553078e (left nav collapse) is changing, so they rebase onto
main after it merges.
