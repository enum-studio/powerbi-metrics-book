# Threat model

This file says what Power BI Metrics Book protects, from whom, where trust
changes hands, which control holds each boundary, which test proves it,
and which risks are left. The spec's Security section is its summary. A
change that moves a boundary updates this file in the same pull request
(the last section says when).

Each control lands in the same change as the thing it guards: no route
ships before its credential check and its authorization test, no container
before its hardening, no secret before its readers. A control that is
listed here but not yet built guards nothing, so nothing it would guard may
exist yet either.

## Assets

| Asset | Where it lives | The harm if it is lost |
|---|---|---|
| People's Power BI tokens | `powerbi_connection`: the access token and the refresh token, encrypted for the api's identity | an attacker queries Power BI as them, with their row-level security, for up to 90 days |
| The scanner's client secret | `secret_ciphertext`, encrypted for the worker's identity only | every workspace's metadata, measures' DAX and access lists in the tenant |
| The app's client secret, the sign-in providers' secrets, the CSV link key | `secret_ciphertext`, encrypted for the api's identity only | an attacker poses as this product to Microsoft or the provider, or signs CSV links; the app's secret also gets a token holding whatever the registration holds, including a permission it holds for another product that shares the app |
| The embedding key | `secret_ciphertext`, for the api and the worker | spend on the company's account; the company's metadata sent elsewhere |
| The containers' age identities | the `api_identity` and `worker_identity` volumes (mode 0400), or `API_AGE_IDENTITY` and `WORKER_AGE_IDENTITY` | every secret and token that container reads |
| Bootstrap values | the deployment's `.env` (mode 0600): `AUTH_SECRET`, the database URLs with their passwords | sessions forged; the database opened under a role |
| Stored results | `query_result`, `query_result_page`, until they expire | data read under one person's row-level security seen by another |
| Credentials | Better Auth's tables (sessions, OAuth grants); `service_account_key` (API key digests); the CLI's `~/.config/pbmb/credentials.json` (mode 0600) | an attacker gets a person's or a service account's access |
| The mirror | workspaces, datasets, tables, columns, measures with their DAX, `powerbi_access` | names, DAX and access lists of a dataset seen by someone Power BI does not let reach it |
| The book, the conventions and their history | metrics, variants, terms, categories, the conventions (including named exception targets), `book_change` | a metric redefined or verified without a person seeing it |
| The records | `audit_event`, `query_log`, `book_change`, `event` | who saw or changed what can no longer be shown |
| Requests and search text | `request`, `search_log`, kept 180 days by default (`usage.retention_days`, at most 365) | personal questions, search text and gaps exposed to someone who may not read them; records planted to steer curation |
| The setup link, its setup session and sign-in marker | the output of `server setup-link`, never the log; `setup_link` keeps only SHA-256 digests, until the first admin exists | whoever holds it becomes the first admin |
| Availability | the host, Postgres, the Power BI capacity | agents get no numbers, or the wrong ones |

## Who is trusted

- **The operator** who runs the host and holds the deployment's `.env` and
  the identity volumes. They can read everything, by design.
- **Microsoft**: Entra for who a person is, Power BI's access lists for
  what they may reach, and Power BI's own rights and row-level security on
  every query.
- **The company's admins, and the sign-in providers they add**, inside
  their deployment. Admins can replace a secret but never read one back,
  nor send one elsewhere: the settings that say where a secret goes
  (`powerbi.authority`, `powerbi.api_url`, `powerbi.graph_url`,
  `search.base_url`) are set only in the environment, by the operator, and
  a value saved for them in the database is never read. A sign-in
  provider's secret goes to the issuer an admin sets, so moving a provider
  to another issuer or kind, or removing it, deletes its secret and ends
  its sessions in the same transaction, in the admin section and in a
  book.yml import alike (`settings/secret_destination_security_test.ts`,
  `admin/settings_security_test.ts`).
- **The people who review and merge pull requests.** `CODEOWNERS` makes
  Martin the required reviewer on the sensitive paths (`agents.md`,
  rule 3).

Everyone and everything else is an attacker below, or sits behind a
boundary.

## Attackers

| Attacker | Wants | Main controls |
|---|---|---|
| Anyone on the internet | in without signing in; a token; the setup; the server to fetch something for them | only `api` exposed; every route checks its credential; PKCE and audience-bound tokens; the guarded fetcher; the setup link that only the server's log holds |
| A signed-in person or service account | metadata or data beyond their Power BI rights; another person's results; admin | Cerbos on every request; roles resolved per request; visibility that follows Power BI; results bound to their owner; Power BI's own rights on every query; rate limits and a daily row budget; audit |
| A hostile MCP client | a grant by deception; to steer the agent through data; to rewrite definitions | the consent screen names the client and the redirect host; dynamic registration grants nothing; the connector cannot change the book; approval only from a browser session |
| The api, if broken | the tenant-wide credential | it cannot read the scanner's secret; it holds no secret of the worker's; the scanner registration holds no API permission. An app registration that itself holds a tenant-wide permission gives the api one, by accepted decision (Residual risks) |
| The worker, if broken | people's Power BI tokens; a way in from outside | it holds no token key; it is on no network the internet reaches |
| Someone with a copy of the database | secrets and tokens | every secret and token in it is encrypted for a container identity that is not in the database; credentials are digests |
| The supply chain | code or instructions inside the stack | pinned versions and lockfiles, images by digest, skills and Actions by SHA, scanners, signed images with an SBOM |
| The maintaining agent | nothing, but by accident a leaked secret or a weakened control | the agent rules (`agents.md`), the security tests, the scanners, a security review on sensitive paths |

## Trust boundaries

Every container is in `stack/compose.yml`. `app` is an internal network
with no route out; `edge` and `egress` are not.

```
                            internet
                               |
 B1 ===========================|=========================================
                               | 443, TLS at the reverse proxy; edge
                +--------------+--------------+
                |             api             |  B4, egress: fixed hosts
                | B7: Power BI tokens         |----> Microsoft identity, Power BI,
                | B8: results, CSV links      |      Graph, embedding provider
                | B9: the setup link          |  B4, egress: client-chosen
                |                             |----> CIMD documents, OIDC issuers
                +------+---------------+------+
                   app |               | app
 B2 ===================|===============|=================================
                  +--------+     +----------+
                  | cerbos |     | postgres |  B6: secrets, tokens and
                  +--------+     +----------+      identities at rest
                                       | app
 B3 ===================================|=================================
                                 +----------+  B5, egress
                                 |  worker  |----> Microsoft identity,
                                 +----------+      Power BI Admin Scanner API,
                                                   embedding provider

 B10: images, dependencies, skills and Actions, into every container
 B11: tool output, Power BI metadata, results and third-party skills, into the agent
 B12: the host: Docker, the identity volumes, the operator
```

### B1: the internet and the api

Crossing: people's browsers, MCP clients, the CLI and service accounts.

- Only `api` publishes a port. TLS at the proxy with HSTS.
- Every route checks its own credential. The public-paths list names what
  is public, never what is protected, so a route added tomorrow is behind
  the gate because nobody listed it.
- One `/api/v1` path is public: `GET /api/v1/results/{id}/csv`. A signed
  link (`expires`, `signature`) is its credential, so a request with no
  credential reaches it. The route judges its own credential: the link, or
  the caller's own credential when no link is sent. A request with both is
  served only when the credential names the link's owner, and otherwise
  answers as a missing result. A bearer token the api did not take, sent
  with no link, answers 401 with its challenge, as on every other path.
  `isPublic` matches a `:param` as exactly one
  non-empty segment of the decoded path, for GET only.
- The SPA's shell is public, GET only: `GET /` and `GET /assets/:file`
  (index.html and the build's hashed assets), and each screen's path in
  `SPA_PATHS` (`http/static.ts`). That list includes the admin pages,
  `/review/metrics/:name` and the catalog screens, `/catalog/search` among them.
  The table, folder and column pages are three more of them:
  `/catalog/datasets/:id/tables/:table`, `.../folders/:folder` and
  `.../columns/:column`, each one `:param` segment and each serving only the
  shell. `/catalog/categories/*` stays the one wildcard: it opens any depth
  below `/catalog/categories/` for GET, serving only the shell. The shell holds no data; every datum comes
  from `/api/v1`, except what the sign-in screen offers, which comes from
  `/api/auth/config` (below).
- A signed-out browser loading a page off the public list (a GET asking
  for `text/html`, outside `/api` and `/.well-known/`) is sent with a 302
  to `/sign-in?next=<the address>` (to `/sign-in` alone past 2 KB), uncached
  and varying on `Accept`; every other signed-out
  request off the list is answered 401. The redirect is the same for a path
  a route answers and one none does, so it says no more than the 401 did.
  `next` is only ever followed by the sign-in screen's `safeNext`, which
  keeps it on this origin. A signed-in page load that no route answers gets
  the shell under 404, so the SPA draws its own missing page
  (`http/page-load.ts`, `public-paths_security_test`, `static.test.ts`).
- `GET /api/auth/config` is public: the sign-in screen needs it before
  there is a session. It answers the providers that can sign a person in
  now (`id`, `kind`, `name`), whether passkeys are on, whether the dev
  sign-in route is open, and whether the stack runs on the mock tenant
  (`sample_data`, for the "Sample data" band), plus `brand` (name, company, logo_url)
  and `invite_only` (whether the default role is none). `sample_data` is true only when the
  host of `powerbi.authority` is localhost, `*.localhost`, `127.0.0.1` or
  `[::1]`, so a real deployment always answers false. Its schema has no client id, issuer, secret or
  redirect URI, and the answer is parsed by it, so none can leak by
  accident (`routes/auth-config_security_test.ts`). The whole answer is
  cached for 30 seconds, so anonymous requests read no settings or logo per
  request; saving a branding setting or `access.default_role`, a book import
  that sets one, and a logo upload or removal refresh it at once.
- `/invite` is one of the SPA paths, so its shell is public like `/set-password`. An invite link carries its token in the fragment (`/invite#token=...`), which a browser never sends, so the token reaches no server, proxy or access log. On `/invite` and `/set-password` the token is read and removed from the address before the router is created, so no answer from `/me`, an error included, can leave it in the address bar or the tab's history; the replacement adds no history entry. The page sends it only in the body of the lookup and accept calls (`access/fragment-token.ts`, `access/invite.test.tsx`).
- `POST /api/auth/invites/lookup` is public and takes a token only in the body, never the URL. It allows 20 requests per minute per client address. An open token answers email, role, inviter name, expiry and whether password setup is allowed. An expired token answers only inviter name and expiry. Revoked, accepted and unknown tokens all answer `invalid` (`services/auth/invites_security_test.ts`).
- `GET /api/branding/logo` is public: logos appear before sign-in and in emails. Only an admin with `manage_settings` can upload or remove it. The upload is capped at 256 KB before authentication and in the service; the stored type comes from the bytes, never the client's claimed type, and SVG and HTML are refused. A PNG must run from its signature through chunks that fit in the file to a zero-length IEND that ends it; a JPEG must start `FF D8 FF` and end `FF D9`; a WebP must start `RIFF`, carry `WEBP` at byte 8 and give a size field equal to the file length minus 8. No URL is fetched. The response uses the stored type, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, with a digest ETag and public caching for 300 seconds; the bytes are read only when they are sent, never for a 304; no logo answers 404. This is structure checking, not image decoding: CRCs and pixel data are not checked, so a JPEG can carry any bytes between its first and last markers, which the headers keep from running (`services/admin/branding_security_test.ts`, `routes/branding.test.ts`).
- A database belongs to one tenant, for life. When the setup's Microsoft
  sign-in is spent, `setup_link` records the tenant id and whether the
  authority was the mock's, both taken from the token's own check, not from
  settings read later. The setup's confirm (`firstAdmin`) refuses unless the
  stack still has both, compares the tenant id again inside the transaction
  under a lock on its `setting` row, then makes the admin, writes the
  `deployment_tenant` row from the recorded values and ends the links in
  that one transaction: no admin without a binding. The api and the worker
  refuse to start, and refuse every job, on a database with an admin and no
  binding. The worker asks `deployment_has_admin()`, a security definer that
  answers one bit; it gets no read of `role_assignment`. Both also refuse to
  start against another tenant id or the other side of the mock, and check
  again before every job of any kind, the setup's check job included. A sample
  database over real Microsoft would keep the sample's
  admin and data, and a real tenant's database under the mock would mix
  them, so both are refused. The dev sign-in runs only on the mock: while it
  is open and `powerbi.authority` is not the mock's, the api and the worker
  refuse to start, bound or not, and the confirm refuses before it binds, so
  it never admits anyone over a real tenant. A trigger on `setting` keeps
  `powerbi.tenant_id` at the bound tenant for every writer, a second refuses
  to rename any row, and both functions pin their `search_path`. No role of
  the stack updates or deletes the row. Moving to another tenant is a new
  database. `services/setup/deployment_tenant_security_test.ts` proves it.
- Cookies `Secure`, `HttpOnly`, `SameSite=Lax`; the origin check on every
  state-changing request except the token, registration and device
  endpoints and a bearer request with no cookie (below); a strict
  CSP (scripts from self only); `X-Frame-Options: DENY`; rate limits per
  principal and per IP on sign-in, setup, token, query and CSV routes; a
  1 MiB body limit, except `PUT /api/v1/conventions`,
  `POST /api/v1/conventions/diff` and `POST /api/v1/conventions/apply`,
  which apply an 8 MiB limit after checking `book:edit_conventions`, before
  reading even a streamed body, for a baseline over a large book.
- People sign in through Microsoft (single tenant), Google, an OpenID
  Connect provider or a passkey; who may sign in is decided at the
  callback, before an account exists (Better Auth's `validateUserInfo`),
  again whenever a session is made, and on every request: a person no
  role reaches any more is answered 403 by `requirePrincipal`, which every
  `/api/v1` route and every MCP tool must call. Only the code flow signs in: an
  ID token a browser posts is refused. A Microsoft token is taken only
  when its `iss`, `aud` and `tid` name the configured tenant and app.
- Only a verified email reaches a person assignment: a Microsoft email
  when the token is the tenant's and `xms_edov` is true, otherwise a usable
  `preferred_username` (the UPN). The UPN's domain is tenant verified.
  Another provider must say `email_verified`. A token with neither usable
  address is refused. An unchecked directory `mail` attribute cannot match
  a person assignment or invite. An email domain assignment also needs a sign-in in the
  last 7 days that vouched for the domain: Microsoft's tenant, an OpenID
  Connect provider's verified email, or a Google Workspace token whose `hd`
  is that domain (a personal Google account vouches for none). A group
  reaches an assignment only at the
  provider that named it, so another provider cannot claim an Entra
  group's id. A sign-in's groups count for 7 days. A second provider's
  sign-in never joins the account another made for the same email.
- A session lasts 7 days from sign-in, with no sliding refresh. A
  passkey signs in only within 7 days of the person's last sign-in through
  a provider, and only when the device verified the person: the passkey
  plugin's own hooks refuse a registration or an assertion whose verified
  authenticator data lacks the UV flag. A passkey's session ends 7 days
  after that provider sign-in, not 7 days after the passkey's
  (`sessionEnd`); its cookie still says 7 days, and the server refuses the
  session at the earlier end. Adding a passkey needs a session less than
  a day old (Better Auth's `freshAge`). Sign-in stores no provider token,
  and no JSON answer repeats the session token
  (`services/auth/sign_in_security_test.ts`).
- Removing a sign-in provider, or moving it to another issuer or kind,
  ends the sessions it made and moves its sign-ins to the epoch, so its
  groups and a passkey's freshness stop counting, in the transaction that
  deletes its secret. Turning passkeys off ends passkey sessions, and
  turning email and password off ends password sessions, the same way. A
  passkey session of the people whose sign-ins stopped counting then ends
  no later than `sessionEnd` says from the sign-ins they have left, and at
  once when that is past. A person who has an account of the kind that
  went and none of a kind still on (Microsoft, an OpenID Connect provider
  neither removed nor moved, Google while a Google provider is left, a
  password while email and password is on) is signed out everywhere in the
  same transaction: every session of theirs ends, a passkey's too, and
  their MCP and CLI grants and codes not yet exchanged are revoked
  (`services/admin/settings_security_test.ts`).
- Two actions end sessions before their 7 days are up. A person's own
  "Sign out of all other sessions" (Connections, Sessions) is Better Auth's
  `/revoke-other-sessions`, a session path like sign-out: it takes a
  browser session and its Origin, never a bearer token, ends every other
  browser session of that person and keeps the one that asked. Their MCP
  and CLI grants stay; they end under Agents and the CLI. An admin's "Sign
  out" for a person (`POST /api/v1/admin/people/:id/sign-out`, Cerbos
  action `admin:sign_out_person`) ends every browser session of theirs and
  revokes every MCP and CLI grant, so each access and refresh token stops
  at once, in one transaction under the assignment lock. It deletes their
  authorization codes not yet exchanged and the device codes they allowed,
  so none mints a token once they allow the same client again
  (`services/auth/grants_security_test.ts`). Unlike
  Deactivate it keeps their roles, their open invites and their Power BI
  connection, so they can sign in again at once; it is for a lost or
  shared device, and Deactivate is for someone who must not come back. An
  admin cannot sign themselves out this way, and the `people.sign_out`
  audit row is written after the commit, like deactivation's
  (`services/auth/other_sessions_security_test.ts`,
  `services/admin/sign_out_person_security_test.ts`).
- Email and password is off by default and invite only: Better Auth's
  sign-up is disabled, so an account exists only for an email an admin
  invited. Invite and reset tokens are stored as SHA-256 only, work once,
  and expire after 7 days and 1 hour respectively; resending ends the old invite token.
  Only an emailed invite can set a password: a link invite is visible to the
  admin and proves no mailbox ownership. Link delivery requires a provider's
  verified email instead. Password acceptance refuses link delivery like an
  invalid token (`services/auth/invites_security_test.ts`). Setting a password
  through an emailed link marks the email verified, so a password
  person reaches a person assignment the way a provider's verified email
  does. Passwords are scrypt digests of at least 12 characters; sign-in
  is rate limited per address and per email; a changed or reset password
  ends every session of that person. Forgot password answers the same,
  in content and timing, for an email with no account. The links point
  only at `PUBLIC_BASE_URL`, never at a host a request names.
  Like setup, both links carry their token in the fragment; the page removes
  it from the address bar and the tab's history on mount and sends no referrer.
  As with setup, a link opened but never used can remain in the browser's
  saved history and remains usable until it expires.
- An invite holds the role until accepted. Only an open, unexpired invite reaches a verified email; acceptance and the person assignment are one transaction. Revoke and expiry end that access. Resend is limited to once a minute and 10 times a day per invite. Each admin may email 200 invites a day, each invite in a call counted and each resend of an emailed invite counted too; a link invite is not. Previously granted assignments are preserved (`services/auth/invite_acceptance_security_test.ts`, `services/auth/invites_security_test.ts`, `services/auth/invites.test.ts`). Invites made before migration 0003 assigned their role when they were sent. `db/sql/upgrade_invites.sql` finds those once, by their null `last_sent_at`, and deletes each such assignment whose email has no user, open invites included, since an open invite now admits on its own. It never leaves the deployment without a person admin: it keeps the admin assignments it would delete and logs a notice instead. It locks `invite` while it runs, so an invite and assignment from a replica of the older release land wholly before it or after; one after keeps its assignment until the next start, or for good if this release resends it first. That release's password accept can also accept an invite of this one, a link invite too, giving a password account and no role. Deploying without overlap avoids both. That release treated an invite with `used_at` set as ended, as the one before it did, and its start turned each `used_at` end into `accepted_at` or `revoked_at`. The release after it reads only those two, and migration 0004 drops `used_at`, so a deployment made before 0003 starts once on a release with 0003 and without 0004 before it takes 0004. A start with 0004 refuses, before it applies anything, while any invite's end is recorded only in `used_at`, and names the release to deploy first (`db/migrate.ts`, `db/schema/invites.test.ts`). A start never reopens an ended invite (`services/auth/invites_security_test.ts`). Each delete is an `admin.role.revoke` audit event by principal `upgrade_invites.sql`, and each invite it ends a `people.invite_accept` or `admin.people.invite_revoke` event by the same principal, which admins see in the audit log. Then it sets `last_sent_at`, so no later start touches an invite the app made (`db/schema/invites.test.ts`).
- Deactivation is enforced in `roleSubject`: `resolveRoles` returns no roles before any group, domain, default role, invite or setup admission. Sign-in, sessions and MCP and CLI bearer requests all pass this point. Deactivation atomically ends sessions, revokes grants and ends the Power BI connection, clearing its stored delegated tokens and marking it disconnected, keeping assignments and history. In the same transaction it revokes every open invite the person sent, so none still grants their role, and writes a `people.invite_revoke` audit row for each. Reactivation restores assignments but requires sign-in and reconnecting Power BI. Self-deactivation and deactivation of the last active admin are refused. Deactivation does not touch the service accounts a person owns (`service_account.owner_email` is a contact, not a credential): a key the person kept still works until an admin revokes it, so the admin guide says to review the service accounts a deactivated person owns. A request of the person's still in flight when the deactivation commits is refused if it changes people or roles, sends, resends or revokes an invite, or imports assignments: each takes the assignment lock and then checks that its caller is not deactivated (`lockAsAdmin`). Their other admin requests in flight still commit: settings, secrets, PII rules, conventions, and service accounts and their keys; a key created that way survives the deactivation, like a key the person owns. A demotion is held to the same rule. A role change or a revoked assignment commits under the lock, so `lockAsAdmin` reads the caller's roles again there and refuses the change if a role Cerbos decided on has since been taken away; it does not ask Cerbos again, which would read settings on a second connection while the lock is held. Setup's first admin, not yet an admin, is exempt. The same transaction that takes admin from someone revokes their open invites and audits each. A person counts as demoted when the change takes admin from them either as they are now or by everything on record for them, however old (`subjectOnRecord`). So revoking a group whose evidence went stale, or that a Disconnect cleared, ends the invites of the admins it made, and demoting a person admin ends theirs though a stale admin group on record still names them. An open admin invite makes a user of its email an admin until it is accepted, so revoking it ends the invites that user sent, the same way. Nothing under the lock asks Cerbos or borrows a second connection from the api's pool: a book.yml import checks `edit_conventions` before it saves anything, and every change reads the default role before its transaction opens, or through it. Audit rows go through the audit role's own pool after the change commits, except setup's first `role.assign` row, written while the setup transaction still holds the lock; nothing waits on the lock while it holds an audit connection, so this cannot stall. A demoted admin's other admin requests in flight still commit too, as a deactivated one's do, and the residual risks say what a demotion outside the app leaves open. The `people.deactivate` audit row is written after the transaction commits, through the audit role's own connection, so a crash between the two can leave a deactivation without its row. Both `hasAdmin` and `deployment_has_admin()` ignore deactivated people and people whose stored email is unverified (`services/auth/deactivation_security_test.ts`, `services/admin/people_lifecycle_security_test.ts`).
- An admin cannot change their own access. Changing their own role or PII reading, assigning any role to their own email, and revoking an assignment to their own email are refused with "You cannot change your own role. Ask another admin." An admin also cannot assign, to a group, an email domain or everyone in the tenant that reaches them, a role that gives more than admin: `pii_reader`, or a custom role, whose powers live in Cerbos policies the api cannot read. Whether it reaches them is read from every group, domain and tenant on record for them however old (`subjectOnRecord`), so Disconnect or a stale read hides none; a group, domain or tenant that first names them after the assignment is not caught, and the `role.assign` audit row records it. The rule binds role assignments, not an admin who controls sign-in: an OpenID Connect provider an admin adds can claim any group. The check sits in `insertAssignment`, so a `book.yml` import is held to it too. Only setup's first admin, assigning admin to their own email, is exempt (`services/admin/people_lifecycle_security_test.ts`).
- Delete person removes only a deactivated person, for an admin with `manage_people`; the SPA asks for the email typed out first. One transaction, under the assignment lock, deletes the person's `person_identity` rows, their person assignments and their `user` row, whose foreign keys take their sessions, accounts, passkeys and OAuth grants with it. Group and domain assignments are not the person's and stay. Book history keeps the user id and shows "a removed person"; the `people.delete` audit row keeps the email and, like deactivation's, is written after the commit. A group, domain or default role that still reaches the email lets the person in again as a new user with no assignments (`services/admin/people_lifecycle_security_test.ts`).
- `api_rw` may delete from `person_identity` for that delete. A broken api could delete any person's row and so drop the Microsoft account their groups and tenant membership come from until their next Microsoft sign-in links it again, or, under `powerbi.connection_requires_matching_email`, let them connect an account with their verified email. It could already do as much with the `update` it held before, so the grant adds no new power.
- A new deployment's first-run setup stores `access.default_role` = `none` when it binds the tenant, so invites or explicit assignments admit people. The registry default stays `viewer`, so a deployment that never stored a choice keeps letting in its tenant as viewers after the upgrade. A deployment created any other way than the setup flow starts with `viewer` unless someone stores `none` (`db/schema/invites.test.ts`, `services/setup/`). Old used invites are ended by `db/sql/upgrade_invites.sql`, which checks for them on every start, so none can be accepted again. It also ends the open invites, made before migration 0003, of emails that are already users: accepted when the user holds the invite's role by a person assignment, revoked otherwise.
- Better Auth answers only the paths sign-in needs: before a session,
  starting a sign-in, the Microsoft, Google and shared OpenID Connect
  callbacks, passkey sign-in and the dev sign-in; with a session, sign-out,
  signing out of other sessions, the session, and registering, listing and
  deleting passkeys; for OAuth
  clients, authorize, token, registration and device authorization. Every
  other path under `/api/auth` answers 404: introspection, revocation, the
  JWKS, Better Auth's own consent and device pages and its client and
  consent CRUD are not served, and the metadata advertises none of them.
  Nobody registers an OpenID Connect
  provider through Better Auth: providers come from settings, set by an
  admin. The dev sign-in needs `NODE_ENV` `development` or `test` and
  `ALLOW_DEV_SIGN_IN=1`, each lock tested shut on its own. Given an Entra
  object id, it also makes the Microsoft account a Microsoft sign-in would
  (account id = the object id), so a later sign-in through the mock finds
  that account; linking by email stays refused. It answers 409 to an
  object id another user's account holds (in any letter case) and to a
  user who already holds a different Microsoft account. Every account row
  it makes carries scope `dev-sign-in`. With the dev sign-in shut, the api
  refuses to start while any such row or any `person_sign_in` row with
  provider `dev` exists, and names the rows and the statements that remove
  them; Microsoft's callback refuses such an account too
  (`dev_sign_in_account`), for a database changed after start. A unique
  index on account (provider, account id) keeps one provider account to
  one user, for the dev sign-in and the real OAuth path alike.
- Better Auth's session paths (sign-out, signing out of other sessions,
  the session, passkey register, list and delete) still answer a session
  that no role reaches any more. That is harmless: they read or end the
  person's own sessions and passkeys, reach no data, and a new session
  still needs a role.
- Better Auth counts sign-in attempts per client address in Postgres: 60
  starts a minute (a start only redirects to the provider), 3 invite
  accepts in 10 seconds, and its own limits elsewhere. The accept handler
  hashes the password only after the token names an open, unexpired,
  emailed invite, so only a valid token costs scrypt
  (`services/auth/invites_security_test.ts`). The address is the connection's own, unless the
  connection comes from `TRUSTED_PROXY` (a single address or a range, never
  `/0`), whose last `X-Forwarded-For` entry, with any port dropped, then
  names the client; no other request picks the address its attempts count
  against. A range must be written by its network address: the api refuses
  to start with `10.0.1.25/24`, which Node would read as all of
  `10.0.1.0/24`, so one container's address pasted as Docker prints it
  cannot trust its whole network, and an IPv6 range that holds all of
  `::ffff:0:0/96` is refused like `/0`, since it would trust every IPv4
  client (`config_security_test.ts`). When `X-Forwarded-For` arrives from a
  connection outside `TRUSTED_PROXY`, the api counts the connection and,
  at most once a minute, logs a line for each such connection with its
  address and request count, never the header's value
  (`http/forwarded-for-warning_security_test.ts`). A proxy whose address
  changed shows there, but any container that reaches the api can send the
  header and get a line, so a line is a reason to look the proxy's address
  up, never the address to set.
  `CLIENT_ADDRESS_HEADER=x-real-ip` is a second, opt-in mode for a
  platform edge that sets `X-Real-IP` and publishes no proxy range
  (Railway). The api then counts the one address in that header, ignores
  `X-Forwarded-For`, and refuses to start with `TRUSTED_PROXY` also set.
  It holds only if every request comes through an edge that replaces a
  client-sent `X-Real-IP`. Railway's documentation says its edge sets the
  header and does not say it replaces one the client sent, so an operator
  checks it before relying on it: `GET /api/v1/me` with a spoofed
  `X-Real-IP` must show their real address as `client_address`. Caddy and
  Traefik as configured here pass a client's `X-Real-IP` through, so the
  mode is never safe behind them, and `compose.yml` does not pass the
  variable on.
- The connector never changes the book, and writes only these things,
  each as the caller and each through a service that asks Cerbos:
  threads, replies, upvotes and views (`threads.ts`); the query log and the
  caller's own stored results (`execute_dax`); requests (`record_request`)
  and the search log; a CSV link, signed for the
  caller alone, for a result the caller owns; and, once a day for each
  client, one `connector.whoami` row in `audit_event`
  (`recordConnectorReached`), which the setup's `agents` check reads as
  proof that an admin's own client reached the connector. Reading a
  model's details through `get_dataset`, `list_relationships` or
  `list_measures` can also refresh the mirror and log that read, under its
  rate limit. Its tools reach
  the services on the list in `connector_surface_security_test`, and
  nothing that writes the book, the conventions or a result for another
  principal. What a tool answers from the book, Power BI or a thread is
  data, never instructions: the descriptions say so.
- Questions are off by default (`questions.enabled`). Only an admin with
  `manage_settings` changes the setting, unless the operator pins it in the
  environment. Every entry point of `services/threads/threads.ts` checks it
  after the route checks its credential and the request's shape (which reads
  nothing), and before Cerbos or a thread read or write, answering
  `questions_off` without revealing whether a thread exists. While off, the
  connector hides its six thread tools and answers a call to one as an
  unknown name, catalog reads leave out the question fields, and the feed
  leaves out `thread.*` events. Turning questions off deletes nothing;
  turning them on again restores access under the same policies.
- MCP clients and the CLI get OAuth from Better Auth's OAuth provider
  (`services/auth/oauth.ts`, `device.ts`), issuer `<PUBLIC_BASE_URL>/api/auth`:
  - Tokens: one-hour EdDSA JWT access tokens, verified in the api against
    the `jwks` table (signature, `typ` `at+jwt`, `iss`, expiry by the
    api's clock). `aud` is the one resource the token was issued for,
    `/api/mcp` or `/api/v1`; at the other it is 401 `invalid_token`.
    Scope `mcp` covers `/api/mcp`, `api` covers `/api/v1`; a token without
    it is 403 `insufficient_scope`. A request with a bearer token is
    decided by the token alone, never by a cookie beside it. Roles are
    read per request. A 401 there names the resource's RFC 9728 metadata.
  - A grant is a person's consent to one client (`oauth_consent`). A token
    works only while a consent to its client, made no later than the
    token, stands, so ending a grant stops every token of it on the next
    request: the person from `/api/v1/me/grants`, an admin through
    `revokeConnection` (`revoke_connection`).
  - A token the connector or the API accepts notes its grant's last use
    in `oauth_consent_use`, at most once a minute: when, never what was
    asked. Any accepted token counts, an MCP client's handshake too. The
    person sees it on their own grants and an admin on the people list.
    The row goes with its consent. Only the write, about once a minute
    per grant, reads the consent FOR KEY SHARE: a write racing a revoke
    waits for it, writes nothing, and that one token is refused rather
    than served after its grant ended (`services/auth/grants_security_test.ts`).
    Requests between writes check the grant with a plain read, as before,
    so a revoke that lands after that read still lets that one request
    through. Verifying a token so writes
    to the primary about once a minute per grant, so the api's
    authentication cannot run on a read replica.
  - Refresh tokens rotate and work once. A used one, or one of a grant
    that ended, revokes the grant before Better Auth sees the request,
    whichever field carries it. Better Auth alone would leave the JWTs it
    signed working (it does not store them), and a rotation racing the
    reuse could leave a successor (its issue #11317). A refresh it refuses
    `invalid_grant` because a concurrent request rotated the token first
    is reuse too: the api reads the token again afterwards and revokes.
  - The token and device authorization endpoints take only a form body
    with each field once (RFC 6749 section 3.2), `grant_type` compared
    trimmed, so the api and Better Auth (which keeps a repeated field's
    last) never read different values from one request.
  - Authorization needs PKCE S256 and a non-empty `resource` (an empty one
    reads to Better Auth as none, signing a token with no audience) that
    the client is linked to: registered and metadata-document clients to
    `/api/mcp`, `pbmb-cli` to `/api/v1`. RFC 9207 `iss`; no
    `client_credentials`. A replayed authorization code is refused and its
    stored tokens deleted, but the JWTs it signed live out their hour; an
    exception awaiting Martin's sign-off (`docs/decisions/access.md`).
  - Client ID Metadata Documents are fetched through `fetchUntrusted`
    (public addresses, 5 s, 64 KiB, no redirects), must name themselves,
    list redirect URIs and set no server-only field, and are fetched again
    after a day. One that cannot be read answers one fixed sentence; the
    cause goes to the log with the request id, so no answer says what a
    host resolves to inside the network.
  - Dynamic registration needs no Origin (`docs/decisions/access.md`) and
    grants nothing until Allow. It refuses `backchannel_logout_uri`,
    `backchannel_logout_session_required`, `jwks_uri` and
    `post_logout_redirect_uris`, which would make the api fetch outside
    the guarded fetcher. Better Auth's register endpoint reads a session
    cookie when one comes and records that person as the creator. That is
    harmless: the guard takes only a JSON body, which no form can send and
    no page can send without a CORS preflight, and a client grants nothing
    until Allow. Creating a client deletes clients unchanged for a day that
    no person consented to and none asked to authorize in the last 20
    minutes, so `oauth_client` cannot grow without bound and an Allow in
    progress still lands.
  - The token endpoint refuses, before any database work, a form of more
    than 12 fields or more than 2 `refresh_token` values, then reads the
    presented refresh tokens in one query.
  - Consent is answered only from a browser session, over
    `GET /api/v1/oauth/consent?<query>` and `POST /api/v1/oauth/consent`;
    the request Better Auth signed travels in the query or the body, never
    the logged path. It shows the person, the client's id, `vouched_host`
    (the host serving a metadata document: the only checked fact), the
    name the client claims, who registered it and when, the redirect's
    scheme and host (a private-use scheme as one), and what the client
    will and will not be able to do. The SPA must show `claimed_name`
    against `vouched_host`, never the name alone, and inside `<bdi>`.
    Registration refuses a `client_name` over 100 characters or holding a
    control or formatting character (U+202E would turn the words beside it
    around), and a consent request for any scope but `mcp` and
    `offline_access` is refused, since the lists describe only those.
    The sign-in page shows its own sentence for each `error` the api sends
    it, never `error_description`, which anyone can put in a link.
  - The device flow is for `pbmb-cli` alone (`api offline_access`,
    `/api/v1`). Against phishing: no `user_id` may pre-bind a code; no
    `verification_uri_complete`, so the person types the code; looking it
    up claims nothing, answering claims it for whoever answers, and only
    they may allow or deny; the screen shows when and from which address
    (`device_request`) it started. Every failure to answer gives one
    sentence. Allowing records consent before the CLI's next poll. Codes
    last 10 minutes; polling within 5 seconds is told `slow_down`. The
    SPA's `/device` must never prefill the code from `?user_code=`, and
    must show `started_at` and `started_from`.
  - Device and user codes are stored in clear, and the JWT signing key's
    private half in `jwks.private_key` is encrypted with `AUTH_SECRET`,
    not age: two exceptions to rule 10 awaiting Martin's sign-off
    (`docs/decisions/access.md`).
  - Rate limits per client address, in Postgres: token 60 a minute,
    registration and device authorization 10 a minute, Better Auth's 5
    per 10 minutes on `/device`, and the same on `/device/approve` and
    `/device/deny`. The api passes the person's own address on when it
    asks Better Auth for them.
  - The origin check exempts the token and device authorization
    endpoints, which read no cookie, registration (above), and a request
    with a bearer token and no cookie at all: such a request is judged by
    its token, and a bearer never rides with a cookie through the check.
- Service accounts: an API key (`pbmb_sk_` and 32 random bytes) is shown
  once and stored as its SHA-256 digest, found by that digest alone. The
  database refuses a key that outlives 90 days: a CHECK constraint counts
  from `created_at`, which `api_rw` may not write, so the database's clock
  dates every key. The api refuses, on each request and by the database's
  clock, a key past its expiry or older than its account's
  `max_key_age_days` as that stands now, so lowering it stops older keys
  at once. A key works on `/api/v1` only, never `/api/mcp`, told from a
  token by its prefix, and stops on the next request once revoked, or its
  account disabled or deleted. `source_cidrs` is matched against the client
  address as sign-in reads it: `X-Forwarded-For` counts only from
  `TRUSTED_PROXY`, and an account gets no `source_cidrs` while that is
  unset or `CLIENT_ADDRESS_HEADER=x-real-ip` is set, since a key limited by
  address must not rest on a header nobody verified. Each account makes at most `service_accounts.rate_per_minute`
  requests a minute (60 by default, read on each request), counted in
  Postgres (`request_rate`). The worker may only read and delete those
  counts, and deletes the ones a day old; no window is longer (a longer rule
  throws). A digest in a log or an error names no key,
  and the secret scan finds a key in a file (`pbmb-api-key` in
  `.gitleaks.toml`).
  - A service account never administers: a CHECK keeps `admin` out of its
    roles, and `createAccess` refuses it `book:edit_conventions` and every
    `admin` action except `admin:read_status` in code, whatever a policy
    grants. A leaked key can therefore never make itself keys or
    widen its own grants; at most a key whose role a deployment gave
    `read_status` reads the status page (`pbmb admin status`), which holds
    no secret value.
  - A service account never passes for a person: the grants and Power BI
    connection routes refuse it, and the `result_owner` and
    `thread_author` derived roles compare the owner's kind as well as its
    id.
  - Only `admin:manage_service_accounts` makes, changes, disables,
    enables or ends an account or a key, picking the fields it sets by
    name, and each change is audited without the key.
  - The admin services (`services/admin/`) each ask Cerbos for their own
    `admin` action and audit every change. `admin:read_status` (the status
    page and `pbmb admin status`) is the one a deployment may also give a
    read-only role; every other admin action stays `admin`'s. A caller who
    also passes `admin:manage_settings` sees the whole status; any other
    sees the last sync's state and time, the names of failing checks, the
    names and dates of expiring secrets and a count of connections to
    remake, never a message, an error, an id or an email. A sync's stored
    error holds workspace, dataset and app ids, and Power BI's and Postgres's
    own sentences, scrubbed and cut, either of which can quote a value from
    the scan. A job's error, on its row and in the worker's log, keeps
    Postgres's sentence too, not drizzle's message, which holds the query and
    every parameter (`runner_security_test`). Postgres's sentence can still
    quote the one value it could not read as its column's type, as in
    `invalid input syntax for type uuid: "..."`, and that value can be a
    parameter. Ciphertext and API key digests go as bytes, and PKCE verifiers
    and other digests into text columns, which have no such failure. Under
    the shipped policy this text reaches admins alone, and whoever reads the
    logs: `GET /api/v1/admin/sync` takes `admin:run_sync`, and the status
    answer and a sync event in the change feed keep a sync's error for a
    caller who also passes `admin:manage_settings`
    (`status_security_test`, `events_visibility_security_test`). The first
    sync check and the status line `full_sync` say fixed sentences, and no
    route returns a job's stored error but the scanner's credentials check,
    which shows only its own refusal. The connector reads none of it.
  - `admin` is assigned to a person or a group only, never to everyone in
    the tenant or an email domain (a CHECK on `role_assignment`), and the
    last `admin` assignment to a person cannot be revoked (`hasAdmin`).
  - A check answers a fixed sentence for each known failure, at most 300
    characters (a CHECK on `setting_check` and on `secret`). The scanner's
    credentials check keeps its sentence on `job_request`, whose `error` has
    no such CHECK, so the api shows at most 300 characters of it. Where the caller
    holds the value, a message repeating it or any 8 characters of it is
    replaced by a fixed sentence before it is kept or shown.
- The connector, `POST /api/mcp`, takes only an OAuth access token issued
  for it: a session cookie or an API key is refused 401. One POST carries
  one JSON-RPC message or a batch of at most 20, in at most 1 MiB, and
  keeps no session; any other method answers 405. A tool's arguments are
  parsed before it runs and its answer is bounded at 16 KiB: a list ends on
  a whole row, asked for again through the same service at the size that
  fits, and any other answer is cut. The conventions
  guide's opening, which an admin writes and every client reads at
  initialize, is cut at 1,000 characters. A `ServiceError` reaches the
  client as its sentence; any other error as a fixed sentence with the
  request id.
- `GET /api/v1/conventions` and MCP `get_conventions` give exception counts
  per rule, never the list. An element's own check results carry its
  `exception` and reason. Exception reasons and the guide are text agents
  read as data, never instructions. Targets, names and words are at most 500
  characters; reasons at most 200, on one line, without control or format
  characters or U+2028 and U+2029 line separators.
- An unexpected error, from a route, a tool or Better Auth
  (`onAPIError.throw`), is logged by one function, `http/error-log.ts`:
  its name, message and stack, except a failed query, which is logged as
  Postgres's own error and not with drizzle's message, whose query and
  parameters can carry ciphertext, a PKCE verifier or a key digest.
  Postgres's sentence can quote one value, as described above.
- An upstream answer whose shape the api cannot read is logged as its
  issue paths and the request id, never its values.
- The connector has no tool that changes the book: its tools are on the
  spec's list, and `connector_surface_security_test` follows every import
  and re-export of its modules with the type checker to the declaration
  it names, which must be on its list; from the book and conventions
  services only their reads. `human_verified` is set only from a browser
  session under the default conventions.
- The rules that decide who may verify, `trust.*` in the conventions, change
  only from a person's browser session: a CLI or MCP token, a service
  account, or a `book.yml` import by one is refused. `setConventions`
  checks it against the version read under the lock the save writes under,
  so a save that lands in between cannot make a stale check pass
  (`approval_browser_only_security_test`, `store.test.ts`, which holds the
  lock from a second connection, and the import test in `export.test.ts`).
  The stored company part pins `trust`, including when the start upgrades
  a document without `format`. A preset change cannot change who may verify
  or approve. Documents with `format: 1` are never upgraded again.

- Demo mode (`DEMO_MODE=1`) serves the public demo on the invented sample
  tenant, with no sign-in. It opens only when five locks hold. The api and
  the worker check them at start (`refuseDemoOffTheSample`, beside
  `refuseAnotherTenant`) and before each job, and exit non-zero with one
  sentence naming the lock that failed:
  - `ALLOW_DEV_SIGN_IN` is not `1`, so nobody signs in as the admin;
  - `powerbi.authority` is on the mock, a setting read from the environment
    only, so the admin section cannot change it;
  - the database is bound to the sample tenant, or not bound yet;
  - `usage.capture` is off, so a visitor's search is never written;
  - in the api, `TRUSTED_PROXY` is set or `CLIENT_ADDRESS_HEADER` is
    `x-real-ip`, so each visitor is counted by their own address and not
    all of them as the proxy's; the worker serves no visitor and skips it.

  A real deployment cannot pass them: its database is bound to its real
  tenant at its first admin, and the `setting` trigger refuses a later
  tenant id, so the third lock never holds. `NODE_ENV` stays `production`,
  so secure cookies, HSTS and the refusal of public secret values apply.
- In demo mode every request is one person, the sample tenant's Viewer,
  `viewer@sample.example`. `authenticate` reads no cookie and no bearer
  token, so a credential a request carries, the seed's admin session
  included, is ignored and does nothing. No session is made.
- Demo mode answers GET and HEAD only. Any other method answers 403
  `The demo is read-only.`. `DEMO_PATHS` is an allowlist in the same
  direction as the public-paths list: it names what a visitor may reach,
  never what is blocked, so a route added later answers 404 in demo mode
  until someone lists it. It lists `/health`, the auth config and logo,
  the SPA's shell and its home and catalog screens, `/docs/*`, and the
  `/api/v1` reads those screens make, and leaves out every GET that
  writes, above all `GET /api/v1/powerbi/connect` and the CSV link. The
  reads include the documentation of a dataset, table and column, no other
  kind, and the conventions, which the Documentation tab shows; the
  conventions give exceptions as a count per rule, never their targets.
  `demo_security_test` also checks that each entry's paths could be
  answered by one GET route only, so a later route whose pattern overlaps
  an entry cannot take its paths unseen. It reads the route table, where
  two registrations of the very same pattern count as one.
  `/api/mcp`, the OAuth, device and setup routes, the Power BI connect
  route and the CSV link answer 404. A SPA screen not listed, such as
  `/sign-in`, redirects to `/` with 302.
- The web's end-to-end test `apps/web/e2e/demo-reads.spec.ts` opens each
  screen the list opens, with one sample value per parameter, and each of
  its tabs, at a desktop's and a phone's width. It runs as the Viewer on
  the dev stack, with the SPA's demo flag on and every `/api/` request the
  list leaves out answered 404 or 403, as the demo answers it. It fails on
  any such request, and on a screen that shows an error once it has
  stopped loading. It does not click through a screen's other controls
  (the diagram, the tree, a variant), so a read made only there is not
  caught.
- Each client address gets 240 requests a minute in demo mode, through the
  Postgres limiter, keyed `demo:<address>`, an IPv6 address counted as
  its /64 so a client cannot rotate through one; over it the api answers 429
  with `Retry-After`. Until the seed has made the demo person, the `/api/`
  paths in `DEMO_PATHS` answer 503. Search's own limit is counted per
  client address too, keyed `search:demo:<address>`, since every visitor
  is the one demo person; a demo search with no address is refused.

Tests: `public-paths_security_test` over the route table,
`authorization_matrix_security_test` (a session, an API key, the CLI's
token and an MCP client's token each answered only on the paths that
take it, and 401 everywhere else, the CSV path included; every route of
the app's table, middleware aside, has a row), `oauth_security_test`
(token audience, forgery and expiry, scope, refresh-token reuse, behind a
decoy, concurrent and its racing successor,
strict token forms, PKCE, `resource`, CIMD at a private address answered
without the address, registration granting nothing before Allow and
refusing fields that fetch, the 401's `resource_metadata`),
`grants_security_test` (own grants only, `revoke_connection`, idle
clients pruned, clients being authorized spared),
`device_security_test` (phishing defences), `consent_security_test`, the
origin check and its bearer rule, the CSP header, the dev
sign-in locks (`dev_sign_in_security_test`), `demo_security_test` (every route of
`app.routes` refuses a write and, if not in `DEMO_PATHS`, answers 404 or
302; each entry's paths could be answered by one GET route only, and the
documentation of a dataset, table and column only; a cookie or token is the demo person; the
241st request answers 429), `demo-reads.spec.ts` (the demo's screens send
no request the demo refuses),
`locks_security_test` (each lock refuses start alone),
`api_key_expiry_security_test`,
`api_key_security_test`, `service_account_bound_security_test`,
`connector_surface_security_test`, `approval_browser_only_security_test`,
`sign_in_security_test`, `roles_security_test`,
`rate_limit_security_test`,
`apps/api/src/services/auth/sign-in-providers.test.ts`.

### B2: the api, Cerbos and Postgres (`app`)

Crossing: authorization questions, the api's reads and writes.

- Cerbos decides every request that reads or changes data, before it
  reaches Power BI or the book, through one service layer for the SPA, the
  CLI, MCP and service accounts. Roles are resolved on every request from
  `role_assignment`, never kept in a token or a session.
- Visibility follows Power BI (`access.metadata_visibility: powerbi`):
  workspaces, app audiences and direct shares, groups included. Lists and
  search apply it inside their SQL, from Cerbos's query plan; an operator
  the translator does not know fails the request rather than show too much.
- A person's Power BI lists are read on every request from their connected
  Power BI account's object id and its groups, as read through the
  connection: both count only while `connected`, the object id within 7
  days of the connect or of the connection's groups being read, and the
  groups within 7 days of being read. A reconnect of the account that is
  connected keeps its groups until the new read replaces them, so a
  Microsoft sign-in, which connects again, never leaves a moment in which
  the person reaches nothing. With no connection, the
  Microsoft account they signed in with counts, within 7 days of that
  sign-in. An ended connection clears the read, so after that window
  nothing listed for the account reaches them.
- Roles never come from a connected account that is not the person's own.
  Groups and tenant membership come from `person_identity`: the account
  the person signed in with, or, under
  `powerbi.connection_requires_matching_email`, the account they connected
  with their verified email. A connection of a shared account fills only
  the connection's own groups, which decide visibility and nothing else.
- An access-list entry reaches its principal only with a right the sync
  read that is not `None`; an entry with no right is counted in the sync
  run instead. An email, or a group another sign-in provider names, never
  reaches anything. Apps follow the mode as datasets do: under `powerbi`
  an app is listed only to its audience and the members of its workspace.
- Cerbos takes a request of at most 4 MB, so a person whose lists name
  more than about 100,000 objects fails closed: each request that asks
  Cerbos about them fails.
- A dataset the principal may not describe answers exactly like a missing
  one. A result is readable only by the principal who ran its query, in
  code, whatever a policy says.
- Search filters inside the WHERE of each of its orders, before either is
  cut to its pool, from the plan over `powerbi_dataset` as it is now,
  never from the dataset ids a document copied. A metric's document is
  also checked by the rule every read of a metric uses, so a variant filed
  or deleted since the documents were built counts at once. Documents in
  no dataset (categories, metrics without variants) and every term are
  visible to everyone signed in, as the book shows them: a term's document
  holds only the term's own words, never its columns', tables' or
  datasets' names. The `dataset`, `workspace` and `app` filters answer for
  a hidden one exactly as for a missing one; an app counts only when it is
  live and the caller sees it. Search takes at most 60 queries a minute
  per principal, its SQL stops after 5 s (`statement_timeout`, answered
  as `upstream` with a fixed sentence), and bad
  input (a query over 500 characters, a limit outside 1 to 50, more than
  16 custom fields) answers `invalid`.
  A hit's `path` names a workspace, dataset or table only through a
  dataset the caller may describe, and is empty otherwise; its `metric` is
  filled under the rule every read of a metric uses; a category's path is
  shown to everyone signed in, as the categories are, and stops at a cycle.
- `GET /api/v1/datasets/:id/columns/:column_id` is a metadata read under the
  same describe check as the column list: a dataset the caller may not
  describe, a removed column and a PII column read
  without `pii_reader` all answer `not_found` with one sentence. A `column_id` that is no GUID is refused earlier, by the route's validator, as `invalid`. Its
  relationships and the measures whose DAX names the column leave out PII
  ends and PII measures for the same caller.
- `PUT` and `DELETE /api/v1/elements/:kind/:id/icon` need a curator and reach
  the element as `docs` does (a metric as the lists show it); an element out
  of reach answers as a missing one. They change one column, record a
  `book_change`, and touch no trust state. `GET /api/v1/icons` lists public
  constants. All three are in the authorization matrix. No boundary moved:
  both routes sit behind the existing credential gate and Cerbos check, and
  `icons_security_test` and the matrix hold them.
- Search has a fourth ranked order: trigram similarity on names and
  labels, under the same `where` as the exact order, so it ranks only what
  the caller may see. Words match on prefixes. `prefixQuery` keeps only
  letters, marks and digits and quotes each word, so no operator from user
  text reaches the tsquery syntax. Hits carry per-kind `counts`, built only
  from the filtered hits, so they count only what the caller may see.
- An icon is `emoji:<one emoji>` or `glyph:<name>:<color>`. The service takes
  one grapheme that matches `/^(?!.*\p{ASCII})\p{RGI_Emoji}$/v`, 32 bytes at
  most, so a flag passes and a keycap or a tag-character trick does not; or a
  name from `ICON_GLYPHS` with one of eight colors. Before that match it drops
  every U+FE0F from an emoji whose plain form is RGI and the full form is not,
  and stores and records the plain form; it never adds a character. The
  database CHECK on every icon column (`0006_violet_hydra.sql`) is the second
  wall: it refuses ASCII and the bidi
  and zero-width controls except U+200D, takes 1 to 8 characters and
  `octet_length` 38 at most, and holds a glyph's name to the same list. The SPA
  draws an icon as text or as a Lucide component (`item-icon.tsx`), never as
  HTML, in an attribute or in a URL; a color reaches only a `var(--icon-...)`
  style after the fixed list has matched it.
- `api_rw` holds `update(icon)` on `powerbi_workspace`, and on
  `powerbi_dataset` `update(icon, relationships_source, relationships_read_at,
  enabled)`, and `update(display_folder)` on `powerbi_column` and on
  `powerbi_measure`, each on top of the
  descriptive columns it already updated (`description`, `described_by`,
  `described_at`, `custom`), plus `when_to_use`, `owner`, `freshness` and
  `caveats` on datasets, `grain_and_filters` and `caveats` on tables, and
  `unit` and `blank_means` on columns. The relationship and `enabled` columns are the ones
  the api writes after a person's model read and an admin's switch. A curator's
  icon write now reaches mirror workspaces and datasets, only their icon, and
  `book_change` records the kinds `workspace` and `dataset`. The sync never
  writes `icon` (rule 9): its upsert names only scanned columns.
- One database role per container: `api_rw`, `worker_rw`, and
  `audit_writer`, which may only insert into `audit_event`, `query_log`,
  `request` and `search_log`. `migrator` owns every table and runs only the
  api's migrations at start. Each table's grants are declared beside it.
- SQL takes parameters; semgrep refuses SQL built from strings.
- The change feed (`GET /api/v1/events`) shows an event by what the reader
  may see of its element, decided in its SQL before the page is cut:
  - a metric event by the `dataset_ids` and `measure_ids` the event recorded when it was
    written: an event that recorded none is hidden, an empty list means
    everyone (as a metric with no variants is visible to everyone), and
    otherwise the reader must be able to describe one of the datasets. While
    the metric still exists it must also be visible as `visibleMetric` shows
    it now, so a name written while the metric was hidden does not surface
    when it later becomes visible. For a caller without `pii_reader`, the
    event is also hidden unless both recorded lists are empty or at least
    one recorded measure is in a dataset the caller can reach and is not
    PII now. An event without recorded `measure_ids` is hidden from that
    caller. A caller with `pii_reader` needs one recorded measure in a
    dataset it can reach when the event recorded a non-empty `measure_ids`.
    An event from before the list was written (before 2026-10-27) has none,
    and an empty list counts as none: that caller sees it by its
    `dataset_ids` alone.
    An event that names a `variant_id` is hidden, on both metrics of a move,
    unless the variant's measure is one the caller is shown. If the variant
    is gone, its measure is unknown, so every measure the event recorded
    must be one the caller is shown. An event that recorded no list passes
    this check, and only a caller with `pii_reader` reaches it. An event
    that stays shows its `variant_id`, `action`, `to_metric_id` and
    `from_metric_id` whole.
    The service strips from each event's `measure_ids` every measure the
    caller may not describe, by the same test. It strips that event's
    `dataset_ids` to the datasets the caller can describe and, for a caller
    without `pii_reader`, to those of the measures left on that same event,
    so a list never names a dataset held only by measures the caller may
    not see, and an event reads the same whatever else is on its page.
    A merge's kept metric names the metric merged into it by id, even if that
    metric held only measures the reader may not see. The id carries no name
    and no count.
    `name` and `previous_name` are never stripped: a missing name would mark
    a recorded measure as PII, and for a live metric the metric's own read
    returns the current name to the same reader. Residual risks has what stays.
    Variant events carry one `measure_id` and are hidden whole.
    Removed measures keep their names in the mirror and remain checked.
    Moving a variant out records the datasets and measures the metric held
    before and after;
  - a variant event by the `dataset_id` and `measure_id` it recorded. A
    caller without `pii_reader` sees it only when the measure is not PII;
  - a thread event as `findThread` shows the thread, by its element, and
    none while questions are off;
  - term and conventions events to everyone; conventions events carry
    changed paths only, never values or exception targets;
  - `sync.*` events only with `admin:read_sync_events`, which a service
    account is refused in code, and their `error` only with
    `admin:manage_settings`;
  - an event with no element is shown only if its kind starts with `sync.`
    and the reader may read sync events; any other element-less kind is
    hidden;
  - any other element is hidden.
  An event's payload carries ids, never the name of another element: a
  reader may see one metric of a merge or a move and not the other.

Tests: `authorization_matrix_security_test`, over the table in
`apps/api/src/routes/authorization-matrix.ts`: every route and every tool,
for anonymous, an outsider, a viewer, a curator, an admin, a curator who
cannot see the Sales dataset, a service account with and without a grant,
and the curator's tokens, each allowed or refused by a real request on
the sample tenant. A Sales element hidden from the caller, curation
included, and a result the caller did not run answer exactly as a missing
one; an answer the outsider, the service account with no grant or the
curator elsewhere is allowed holds no id or key of a Sales element (the
query log aside, a residual risk below); a route or tool the table does
not name fails it. It checks one dataset and one shape of reach per
caller, not every filter's every branch; `events_visibility_security_test`
for the feed; `metadata_visibility_security_test`,
`search_visibility_security_test`, `summary_security_test`,
`result_ownership_security_test`, `audit_append_only_security_test`,
`grants_security_test`.

#### Requests and the search log

- Cerbos decides `request:create` before recording a question. The default
  policies let an owner, a curator or an admin read requests and searches;
  only the owner or an admin may delete a request. `record_owner` compares
  both `principal_kind` and `principal_id`, so a service account named like
  a person's id owns none of that person's rows. The policies are
  `request.yaml`, `search_log.yaml` and `usage_report.yaml` in `access/policies/`.
- `Access.readableRequests` and `readableSearchLog` translate Cerbos read
  plans into SQL conditions before paging or grouping. An unsupported
  condition fails the request. `list_requests` and `get_request` return
  only elements the reader may describe, including PII checks. Linked
  queries and searches are shown only through their own read plans;
  results are never included. A refused request answers "No such request."
  as a missing one does. Recording an inaccessible element or another
  principal's query or search id uses the missing-element or missing-id
  sentence.
- `usage_report:read` allows curators and admins by default. The report
  applies each source's read plan and dataset describe conditions in SQL.
  `hidden` counts query rows and request elements cut by dataset describe,
  without naming them. PII rules also filter measures and flagged elements
  for callers without `pii_reader`; these exclusions do not add to `hidden`.
- Only `audit_writer` inserts into `request` and `search_log`; no role may
  update them. `api_rw` and `worker_rw` have select and delete only.
  Searches from the browser are not logged. `usage.capture` off stops
  search and request capture. `whoami` and the connector's instructions
  tell callers whether capture is on and how long records are kept.
- The worker's `expire_usage` job runs daily at 04:15, scheduled in
  `apps/api/src/worker.ts`, and deletes rows older than
  `usage.retention_days`. Deleting a person or service account deletes
  their requests and searches too. A request delete writes
  `request.delete` to `audit_event`. The connector has no delete tool.
- The server does not redact free text. `record_request` tells the agent
  never to copy values from results. Report text is data, never
  instructions; the curation skill requires showing proposals to the
  person before filing them.

Tests: `usage_access_security_test`, `report_access_security_test`,
`access/tests/usage_test.yaml`, `connector_surface_security_test`;
`requests.test.ts`, `report.test.ts` and `expire.test.ts` beside the services.

### PII visibility

PII behaves as if it does not exist for a caller without `pii_reader`. The
rule is enforced in metadata reads, book reads and writes, threads, search,
and the event feed. Event visibility checks the recorded `dataset_ids` and
`measure_ids`; current measure rules also protect events after a metric is
gone. Queries containing a PII column or measure are refused before Power
BI. A result header check before storage is the backstop. Only persons can have
`pii_reader`; service accounts never do. `list_relationships` counts the relationships it
leaves out over the whole dataset, whatever its table filter, so the count
cannot tell which tables a hidden relationship joins; `get_dataset` works
out a table's kind from the columns and measures it shows. `hidden_suggested_merges` and
`live_base_variants` in checks count PII as they count datasets the caller
cannot reach. The queue's `hidden_variants` leaves PII out, for a caller who may
not read it. `hidden_suggested_merges`
counts entries, so it says whether a hidden copy shares a spelling and a metric
with a visible measure or another hidden copy, and not how many copies there
are. A suggested merge's
`dataset_count`, and the labels a failing `metric_not_the_same_as` counts and
names on a metric's page, its checks or a refused verify, cover only what the
caller may see, and a hidden measure's id orders nothing. A draft's own
`dataset_count` counts every dataset holding it, those out of the caller's reach
too, so it says how many datasets hold a measure of this name. For a caller who
may not read PII it leaves out a dataset holding only a PII copy. A measure's DAX can name a PII
column, but never shows its values.

Documentation reads and checks use the same dataset and PII gates as the
catalog. The new documentation columns follow the element's visibility.
Checks work out a column's key status and a table's kind from what the
caller is shown, as the table page does. A non-reader's documentation
failures can therefore differ from an admin's; using hidden columns would
otherwise reveal PII through which fields fail. A baseline works out its
element failures, before and after the change, the same way, as the admin
applying it is shown the model, so which columns it excepts never tells of
a PII column they may not read; `now_failing` still counts the whole book
(`services/conventions/exception_visibility_security_test.ts`).

Exception targets on element checks, apply results and unused lists are
shown only to a caller who can see the target, including `pii_reader` for a
PII column. The unused list goes to a curator alone, on every route that
gives it: `GET /api/v1/conventions/exceptions/unused`, and
`GET /api/v1/docs/checks` on its first page; anyone else, and a later page,
gets no `unused_exceptions` field, and the route does not work it out.
The list matches exceptions to datasets through an index built once, so
20,000 exceptions over 20,000 elements take milliseconds, not seconds.
Counts stay whole. The stored company part is returned whole to
a principal with `book:edit_conventions`: export and apply must round-trip
the file, and the deployment repository already holds those targets.
`GET /api/v1/conventions` and `get_conventions` return counts instead of
that list. This is a separate door from the company-part export requiring
`book:edit_conventions`
(`services/conventions/exception_visibility_security_test.ts`).

The admin dataset list exposes dataset names and counts beyond the admin's
Power BI rights. This is the names-only exception in spec decision 8; it
does not grant access to data. Any admin allowed to manage PII sees every
rule's table, column and measure names, whatever their Power BI reach. PII
suggestions and rule counts stay within
the caller's Power BI reach, including off datasets, so counts depend on
who asks. A PII rule restore is conditional on its version, checked atomically with the write.
`manage_pii` and `manage_datasets` are separate Cerbos actions.
An off dataset stays hidden from ordinary reads and queries, even for an
admin or under a deployment policy that allows every Certified dataset.

A draft's generated key and label come only from what its readers may see,
because anyone who can see one variant reads the metric's row. Measures of one
calculation in one dataset share a draft named from one that is not PII, while
any is not. A measure in another dataset joins that draft only under the same
name in snake_case, and two names of one calculation stay two drafts, offered
as a merge only among measures the caller may describe. A variant that is not
PII is not filed under a PII base. A metric a person worked on gathers a copy
only under the name of a measure it already holds, live, in a dataset that is on
and not PII, so confirming a key moves nothing of another name. A measure gone
from Power BI leaves a draft nobody touched when no measure of its dataset filed
in that draft has the draft's name and is not PII, and a dataset removed earlier
is drafted once more to do so. A curator who moves an untouched draft's last live
measure out deletes the draft in that change, because everyone reads a metric with
no variant. A word a key holds cannot be made an alias, so a curator elsewhere
cannot push a hidden draft off its key. A new key cannot be a word another metric
holds as an alias, so it cannot take that word from it. A draft the sync named
earlier follows at the next sync. Turning a dataset on drafts it in a job of its
own, with no scan, because a dataset that is off is not drafted unless it changes.
A draft a person touched and a draft a rule dismissed keep what they hold (Residual
risks).

The keys and order of `pii_rule_name_idx` depend on glibc (`lower()`, the order
of text) and on the Postgres version (`normalize()`), so after either moves the
index can miss a rule. A rule lookup therefore never reads it by the fold: it
folds every rule once per statement and probes a hash, so a stale index hides no
rule from a metadata read, a search document or the query check. `saveRule` and
`suggest` can still read it by the fold, and neither decides what is hidden. Its
unique check can still miss, so a second rule can get in, and PII wins between
the two.
Each start of the api compares the record on the index with `version()` and the
collation's actual version, and `datcollversion` with that version. When they
differ it rebuilds every index that depends on the collation, committing after
each, then refreshes the version and writes the record
(`apps/api/src/db/sql/collation.sql`). Where nothing moved, that check locks no
table. A rebuild that finds two rows a stale unique index let in fails, and the
api does not start until a person removes one, so it serves no stale index after
a start, except on a locale with no collation version whose glibc moved with no
change to `version()`; the shipped images use `en_US.utf8`. The failure names the
index and never the key, which can be an email address, and the builds use no
parallel worker, which would log the key itself. The runs are in
`docs/decisions/architecture.md`.

Tests: `apps/api/src/services/book/pii_visibility_security_test.ts`,
`apps/api/src/services/book/draft_name_security_test.ts`,
`apps/api/src/services/book/curator_counts_security_test.ts`,
`apps/api/src/routes/v1/events_visibility_security_test.ts`,
`apps/api/src/routes/v1/pii_security_test.ts`,
`apps/api/src/routes/v1/dataset_switch_security_test.ts`,
`apps/api/src/db/collation_security_test.ts` and
`apps/api/src/services/pii/stale_index_security_test.ts`.

### B3: the api and the worker

Crossing: jobs, through Postgres only.

- The two never call each other. A job is a row in `job_request`, taken
  with `for update skip locked` by the container its `runner` names.
- The worker holds the scanner's secret and no token key; the api holds
  the token key and cannot read the scanner's secret, so the jobs that need
  the token key (`rekey_tokens`, `refresh_idle_connections`) run in the api.
- The job registry is keyed by name and runner, so one name may have a
  handler in each container (`check` does: the api's runs every check, the
  worker's only those that need the scanner's secret). A runner runs only
  jobs queued for its own container, and the lock that keeps a job to one
  run at a time is per container, so the api's check job can wait on the
  worker's.
- The worker stores the results of the checks it runs in `setting_check`,
  including a details object of at most 256 KiB. Row level security holds
  its writes to the `scanner` and `what_to_sync` rows. Workspace details
  are re-parsed with `WorkspaceDetails` before a route returns them: GUID
  ids, names cut to 256 characters and at most 1000 entries. Personal
  workspace names are kept in new check results only while the personal
  setting is on; while it is off, the check keeps only their count. Reads
  apply the current setting, hiding personal names from older results too.
  Disabling the setting removes the cached check. An already running check
  can finish with its earlier setting; reads still hide its personal names.
- The check of the scanner's credentials keeps no `setting_check` row. A
  refusal ends its job as failed, with the check's own sentence, marked and
  screened against the secret, on the job's row. The api shows a job's error
  only with that mark, and at most 300 characters of it. Every job's error,
  marked or not, stays on its row and goes to the worker's log in the line
  that says the job finished; an unmarked one is never shown.
- Every book change queues the `embed` job inside the curation
  transaction (`recordBookChange`), with a fixed job name, runner and
  arguments (`embed`, `worker`, `changes_only`) that no caller chooses, and
  at most one request queued. A change that finds one queued selects it
  `for share` and holds the lock until it commits, so the worker, which
  takes with `for update skip locked`, cannot take and finish it before the
  change is visible. The job reads `book_change` from a cursor in
  `search_state`, which only `worker_rw` writes.
- The search tables: `search_document` is written by `worker_rw` and read
  by `api_rw`; `search_state` is `worker_rw`'s alone (select, insert,
  update); `embedding_usage` is appended to by both (select and insert
  only, so neither can change or remove what was spent) and its token and
  cost columns cannot be negative.
- No volume is mounted by both. The mirror tables are written only by
  `worker_rw`, except our own description, custom fields and built-in
  documentation columns, which `api_rw` may update. The worker has grants
  on the mirror, so grants alone do not protect a curator's words. The
  sync's upserts never name `when_to_use`, `owner`, `freshness`, dataset or
  table `caveats`, `grain_and_filters`, `unit` or `blank_means`, just as they
  never name our `description` or `custom`. A sync leaves each as written
  (`apps/api/src/services/sync/isolation_security_test.ts`).
- Both containers run non-root, with read-only roots and tmpfs where a
  process writes, `no-new-privileges`, every capability dropped, memory
  and CPU limits and health checks.

Tests: `apps/api/src/services/secrets/scanner_secret_isolation_security_test.ts`,
`compose_security_test`, `grants_security_test`, `runner.test.ts`
(`handlerHere`), the worker's check results in
`setup_link_security_test.ts`, and the queuing and the usage grants in
`apps/api/src/services/search/embed.test.ts` and
`embedder_security_test.ts`.

### B4: the api's outbound requests

Crossing: sign-in, people's Power BI queries and groups, query embeddings,
and URLs someone else chose.

- Every outbound request goes through the guarded fetcher; semgrep refuses
  `fetch` anywhere else.
- Fixed hosts (`fetchFixed`): `https` to the configured Microsoft identity,
  Power BI, Graph, embedding and Resend hosts only, redirects never followed (and refused unless the caller asks for the 3xx back), with size
  and time limits. A Resend request carries the invite or reset link and
  the recipient's email, and nothing else from the book. The mock's `http` URL is allowed only when `NODE_ENV` is
  `development` or `test`. Fixed hosts skip the private-address check on
  purpose: with Power BI Private Link or a private endpoint those hosts
  resolve to private addresses. The allowlist is the control, and only an
  admin sets those origins.
- A `fetchFixed` caller may pass `redirect: "return"` to get a fixed host's
  3xx back, Location included. The fetcher still never follows it: any
  request to the Location goes through the fetcher again, with every check.
  Today only the sample seed asks for this, to read the mock's authorize
  redirects as a browser would. `fetchUntrusted` has no such option.
- In demo mode `fetchFixed` also allows `http` to a configured origin whose
  host is `localhost`, `*.localhost`, `127.0.0.1` or `[::1]`, even with
  `NODE_ENV=production`: the mock on the stack's `egress` network. Only
  the configured origins are reachable, and every outbound call, Microsoft
  identity, Power BI, Graph, embeddings and email, goes to the mock, so
  nothing leaves the stack. `fetchUntrusted` is unchanged: `https` only,
  internal addresses refused.
- The setup's tenant lookup asks Microsoft identity's configured host for
  a domain typed by the setup's holder (a setup session, or an admin),
  checked as a hostname, and reads only the issuer, with a 5 second timeout
  and a 64 KiB response limit.
- Client-chosen URLs (`fetchUntrusted`: CIMD documents, an OpenID Connect
  issuer an admin types in): `https`, public addresses only after DNS
  resolution, 5 s, 64 KiB, no redirects. This closes the server-side
  request forgery a client-chosen URL invites.
- Better Auth makes its own sign-in requests, outside the guarded fetcher
  and without its address checks: the Microsoft code exchange to
  `powerbi.authority`, which must be `https` outside development and test
  (`authority_security_test`), except in demo mode, where it may be `http`
  to a host the fetcher's mock-host test passes and nowhere else, and an
  OpenID Connect provider's token,
  keys and userinfo requests. The provider's discovery goes through
  `fetchUntrusted`; its authorization, token and keys endpoints must be
  on the issuer's own origin, over `https` outside development and test,
  and a userinfo endpoint elsewhere is not used. The SSO plugin refuses a
  literal private address and, once before each request, a host that
  resolves to one, without pinning the address it then connects to. In
  development and test the configured issuers' origins are trusted, so
  the mock on loopback answers; production trusts none
  (`oidc_issuer_trust_security_test`).
- The product asks the app registration for read-only delegated permissions
  and nothing that writes: `openid`, `profile`, `email`, `offline_access`,
  Power BI `Dataset.Read.All`, Graph `User.Read`. The setup's check requires
  the minimum and accepts more. It fails a token without Power BI's
  `Dataset.Read.All`, and no other permission can stand in for it.
- What this accepts: a registration may hold more, because it may also serve
  another product. Entra lists every delegated permission consented for the
  resource, so the token Microsoft issues can carry extra consented scopes,
  up to `Tenant.ReadWrite.All`, and a person's token can then do whatever
  those scopes and that person's own rights allow. Our code never uses them:
  every delegated request names `Dataset.Read.All` or `User.Read`. A
  registration's application permissions (the `roles` claim of its
  client-credentials token) are accepted the same way. Nothing relies on
  them, but the token carries them, and service-account queries, when they
  are on, run with that token (`apps/api/src/services/queries/execute.ts`).
  So a broken api holding either token holds what those permissions allow,
  and the setup says so, for what it reads, rather than refusing: the check
  passes with a note, and the security checklist's
  `app_registration_read_only` item turns `explained`. A person decides
  whether to remove them. The check reads only tokens for the Power BI
  resource, so an application permission on Microsoft Graph or any other
  resource shows nowhere. The note names the delegated and application
  permissions that fit in 300 characters and counts the rest. It says what a
  name shows and no more: names that show a tenant-wide reach or `ReadWrite`
  come first, with a label, while a write such as `Mail.Send`,
  `Content.Create` or `Item.Execute.All` gets none, so what goes unnamed may
  do more than what is named. The note says an application permission acts
  without any person, and, when `powerbi.service_account_queries` was on as
  the check ran, that service-account queries send the token holding it. The
  note is a fixed sentence: a name outside a permission's own form, or over
  64 characters, is never repeated
  (`app_registration_check_security_test`).
- The scanner's check still fails a scanner token with a `roles` claim: the
  admin APIs reach the scanner through the tenant setting, not a permission,
  and the spec records that Microsoft refuses them otherwise.
- Client-credentials tokens are cached by authority, tenant, client and
  the SHA-256 of the secret, so a changed secret or tenant is checked at
  once and never answered the old token.
- What leaves: DAX to Power BI, under the person's own token. The
  embedding provider is a third party that sees the book's names,
  descriptions, display folders and term values (a variant in a personal
  workspace leaves out the workspace's name, which is its owner's), and
  never DAX, a query result or a thread's text. Its key goes only in a
  request header, to the configured host, which the fetcher checks against
  its list; an error, the log, `job_request.error` and `embedding_usage`
  never hold the key or the provider's words: the store refuses a secret
  with a control character, or an API key with a character a header
  cannot carry, and a request the fetcher cannot build or send fails with
  a fixed sentence that quotes none of it; a wait on its `Retry-After`
  is at most 60 seconds; and its answer is checked (one vector of the
  stored width for each text, every value in [-1, 1], the indexes exactly
  0 to n-1, the token count within an int4) before any of it is kept.
  When it refuses a batch, a fixed probe sentence is embedded first: if the
  probe is refused too, the request is at fault (a path, a model, a key),
  the run stops, and no document keeps a hash; only after the probe passes
  is a text it still refuses, found by halving the batch, held to be at
  fault and left without a vector. A run stops after ten minutes with what
  it has stored and queues its successor. The change feed is a pull, not a
  webhook.
- Every search query's text goes to the embedding provider, and an agent
  can put anything into it, a value it read from a result included;
  `search.provider: none` turns that off. A query's embed waits 5 s at
  most and never on `Retry-After`. When it fails in any way (a refusal, a
  timeout, a redirect, an answer too big, a key it cannot send), search
  answers by words alone
  with a fixed sentence, and no provider or fetcher text reaches the
  caller.

Tests: the guarded fetcher's (CIMD and issuer fetches to private
addresses, other hosts refused by the fixed-host profile, the mock-URL
lock), `query_identity_security_test`, `app_registration_check_security_test`, `apps/api/src/services/setup/app-registration-check.test.ts`.

### B5: the worker's outbound requests (`egress`)

Crossing: the scanner's token, the Admin Scanner API, document embeddings.

- The worker is never on `edge`: nothing reaches it from outside.
- The scanner registration holds no API permission; its reach is the
  tenant setting for its security group, and its admin APIs are read-only.
- The parser drops Power Query (M) expressions, table sources and dataset
  parameters before anything is stored: they name servers and can carry
  connection details. Absence from a failed scan is never a deletion.
- What a scan brings is whatever someone who can publish a model wrote. A
  workspace that cannot be scanned or stored, or a dataset or app that cannot
  be stored, costs itself: the others are mirrored, and the run ends failed and
  names it by id. A scan that fails for a reason that says nothing of what it
  held fails whole: the run says how many workspaces it held, and the worker's
  log names them. A scan's answer stays capped at 32 MiB, the fetcher's
  ceiling, and answers are read and stored one at a time, so the sync holds one
  answer's schemas at once. The drafter then reloads each dataset whole, so a
  large enough model can still run the worker out of memory. A run's and a
  job's stored error is free of what Postgres cannot keep and cut to length, so
  recording a failure cannot itself fail on what the failure said.

- In demo mode the worker's outbound requests go to the mock too, through
  the same exception as in B4.

Tests: `compose_security_test` (`api` the only service on `edge`), the
scanner client's tests against the mock, `isolation_security_test`.

### B6: secrets, tokens and identities at rest

Crossing: what Postgres, a backup and the identity volumes hold.

- The api and the worker each make an age (X25519) identity on first start,
  in a volume only that container mounts, and publish the public half to
  `container_identity`.
- A secret is encrypted for each container that reads it: the scanner's
  secret for the worker only; the app's secret, the sign-in providers'
  secrets and the CSV link key for the api only; the embedding key for
  both. The api writes the scanner's secret and can never read it back.
- Secrets are write-only: no route returns a value. The admin services show
  a secret's readers, last four characters, setter, expiry and check, and
  audit its name and expiry only. `pbmb admin secrets set`
  prompts without echo and refuses a value on the command line.
- API keys are stored as SHA-256 digests. No secret is in `compose.yml`.
- `server rotate-identity` makes a new identity, re-encrypts what the
  container reads and retires the old one. The api keeps its old key file,
  since the running api seals Power BI tokens with the old identity until
  it restarts, and queues `rekey_tokens`. Only an api whose identity in
  memory is the published current one runs it (an api not yet restarted
  refuses, and the restarted api queues it at start): it seals every token
  again with the key in memory, never for a recipient a database row names,
  and removes a retired key file once no row is sealed for it. Entra client
  secrets warn 30 and 7 days before they expire.
- A nightly `pg_dump` goes off the host, and the identity volumes are
  backed up apart from it, so neither alone opens a secret.

Tests: `apps/api/src/services/secrets/secret_write_only_security_test.ts`,
`apps/api/src/services/secrets/secret_at_rest_security_test.ts`,
`apps/api/src/services/secrets/scanner_secret_isolation_security_test.ts`, `apps/api/src/services/admin/secret-expiry.test.ts`.

### B6a: `book.yml` export and import

Crossing: files an admin brings in, and ones they take out.

- `conventions.yml` sits beside `book.yml`; book export leaves conventions
  out of its answer and the CLI writes the separate file and guide.
  Import still accepts older inline conventions. The guide is served to
  everyone signed in and every MCP client, and `.env` sits in the same
  folder, so a guide is a Markdown file inside the deployment folder: its
  path ends in `.md`, no part of it starts with `.`, and neither it nor any
  folder on the way is a symlink. The CLI opens each part without following
  a link, refuses anything but a regular file, and reads at most 256 KiB;
  the api's schema takes a guide of at most 262,144 characters. The CLI
  reads `conventions.yml` and `book.yml` only from a regular file, never
  through a symlink, so a YAML error never quotes another file. The apply
  preview gives the guide's size before and after, never its text. The CLI
  refuses to write the conventions or guide through a symlink. `apply
  --baseline` shows the exceptions it would add and asks before it writes
  them; it writes the file by a temporary file in the same folder and a
  rename, and puts the file back as it was if the apply is refused. Conventions
  YAML refuses anchors and aliases
  (`apps/cli/tests/commands/conventions_file_security_test.py`,
  `apps/cli/tests/commands/test_conventions_file.py`).
- Saving, diffing, applying and exporting conventions need
  `book:edit_conventions`. The CLI's `set`, `edit` and `export --resolved`
  keep the whole company exception list; `presets` reads only the
  conventions anyone signed in may read.
  A saved part is stored as the schema reads it, dropping keys such as
  `__proto__` under `naming.qualifiers`.
  `PUT /api/v1/conventions`, `POST /api/v1/conventions/diff` and
  `POST /api/v1/conventions/apply` check `book:edit_conventions` before
  applying the 8 MiB body limit, including to streamed bodies, so a baseline
  on a large book fits. Drafting uses case-insensitive prefixes and exact names;
  no conventions key accepts a regular expression that could stall a sync
  (`services/conventions/patterns.test.ts`).

- Export holds settings saved in the database (never `setup.*`), the
  role assignments and service accounts picked field by field
  by the schema, so no secret, key or digest leaves.
- Import reads plain YAML only: at most 256 KiB, no aliases, merge keys or
  unknown tags, any error answered with its line and column alone. The
  file then passes `bookSchema` (`book.schema.json`), each setting its own
  schema and each role the rules of `assignRole`.
- Each kind a file changes needs its own action beside `admin:import_book`:
  `manage_settings`, `manage_people`, `manage_service_accounts`,
  `book:edit_conventions`. A changed setting's check runs in the preview,
  and a failing value is applied only with `save_failing`.
- Applying is one transaction; it never removes what the file leaves out,
  and the answer lists that as `kept`. Audit lines are written after the
  commit from the rows written, sharing one `import_id`; a rolled-back
  import writes one line saying so.

Tests: `apps/api/src/services/admin/export.test.ts`.

### B7: a person's Power BI tokens

Crossing: a person's delegated grant, from Microsoft into the api and out
to Power BI.

- The connection uses PKCE S256 and a `state` bound to the session, single
  use, 10 minutes, kept in Postgres as its SHA-256 only. The callback
  refuses a `tid` that is not the tenant. By default any account of the
  tenant may be connected, and several people may connect one account:
  the person proved they can sign in as it, and Power BI decides every
  query by that account's own rights. Each person's tokens come from their
  own consent and are sealed in their own row; no person's token is ever
  used for another. Such an account is never written to `person_identity`,
  so it gives no role (B2). The query log records the account each query
  ran as, because Power BI's own logs name only the shared account.
  Under `powerbi.connection_requires_matching_email` the strict rules hold:
  a person with a Microsoft account on record in `person_identity` (from
  signing in with it, or an earlier connection) must connect that `oid`,
  however the session signed in, a passkey included; only a person with
  none may connect an account with their verified email. That `oid` goes
  into `person_identity` in the transaction that stores the connection,
  and one Microsoft account connects to one person, also when two people
  connect it at once (`person_identity`'s unique constraint answers as the
  check does). Either way, a Graph failure after the connection is stored
  answers that the connection is made and the groups wait. A new connect replaces
  the session's pending state. The browser goes back only to a page of the
  SPA (`next` is an allowlisted relative path), never to another origin.
  Connects, refused connects and disconnects are in `audit_event`.
- The ID token in the token endpoint's answer is held to sign-in's checks:
  issuer, audience, tenant and expiry.
- Tenant membership comes from a Microsoft sign-in in the last 7 days, or
  from a connection of the person's own account (the one in
  `person_identity`) whose groups were read in the last 7 days; an ended or
  disconnected connection clears the latter, and a Graph read that answers
  after a disconnect writes nothing.
  `refresh_idle_connections` renews it by reading the groups through Graph,
  which works only while Microsoft accepts the account, and then refreshes
  the Power BI token only for a person a role reaches. The Graph read still
  renews the refresh token of a person no role reaches.
- Tokens are sealed by the api's vault (`AppDeps.vault`), built once at
  start from its identity; no service holds the key. One row per person;
  tokens exist only while the connection is `connected` (a CHECK
  constraint). The worker has no grant on `powerbi_connection` and never
  holds the api's identity, so `rekey_tokens` and
  `refresh_idle_connections` run in the api. A refresh
  runs under a row lock and stores the new refresh token in the same
  transaction; a refresh token Microsoft refuses deletes both tokens and
  sets `needs_reconnect`.
- A person's read of a dataset's model covers three INFO views
  (relationships, measures, columns), each a query under the person's own
  token and each in the query log. It writes the measures' and columns'
  display folders into the shared mirror (`powerbi_measure.display_folder`,
  `powerbi_column.display_folder`). The columns view lists every column
  name, PII columns included; those names pass through the person's own
  temporary result, which is deleted in a `finally`.
- Power BI names (tables, columns, display folders) become router path
  params in the SPA's links. A folder path is one encoded segment, with Power
  BI's own `\` between levels, so a `/` or a dot segment in a name cannot move
  the link. No link is built for a folder level, table or column named exactly
  `.` or `..`; the name shows as text.
- A person's queries run with that person's token, never the scanner's and
  never another person's. A request that overlaps the same person's read of
  a dataset's relationships, on any api replica, waits for that read
  through its row in `model_view_read`. The row is keyed by the person and
  the dataset, so nobody waits on another person's row, and only a person's
  own read runs with their token. The relationships themselves are dataset
  metadata in the mirror, shown under each caller's own describe check, as
  before. A waiter holds its request at most 30 seconds, stops when its
  caller goes away, and never waits on a row older than that by Postgres's
  clock, which a reader that died leaves. Service-account queries run as the app's service
  principal only when `powerbi.service_account_queries` is on.
- No token is returned to a client, logged, or sent anywhere but
  Microsoft. Disconnecting deletes both tokens; an admin's revoke will too,
  once the admin section builds it (pending).

Tests: `query_identity_security_test`,
`apps/api/src/services/connection/connection_security_test.ts` (no token in
clear, sealed for the api alone, state, `tid` and `oid`, the email match,
one account per person, the ID token's claims, the return path),
`apps/api/src/services/connection/rekey_security_test.ts` (no token sealed
for a forged recipient), and
`apps/api/src/services/connection/tokens.test.ts` (one refresh token spent
by two queries at once, a revoked token turning to `needs_reconnect`).

### B8: results

Crossing: rows Power BI returned under one person's rights.

- A result is readable only by its owner, whatever the policy says. It
  expires after `results.ttl_hours` (24 hours by default, 72 at most,
  because results hold company data) and the worker deletes it within 15
  minutes of expiry. The VM backup dumps the result tables without rows;
  a platform backup (Railway, Azure) keeps them, at most 72 hours old.
- A CSV link is an HMAC-SHA256 signature over the result id, the owner and
  an expiry 15 minutes ahead, under a key only the api reads, a bearer
  credential for one result. A link-only request acts as a synthetic
  `csv_link` principal that reaches only the one result's read and stream.
  The owner is re-checked on the link path: a person no role reaches, and a
  service account that is disabled or off its `source_cidrs`, get the same
  refusal as a link to a result that is gone, so the answer does not say
  whether the owner stands. Link downloads are limited per address (60 a
  minute, an IPv6 client counted by its /64, an IPv4-mapped address as its
  IPv4; `X-Forwarded-For` only from `TRUSTED_PROXY`), and every download, by
  link or by credential, counts against its owner's 30 a minute. Deleting a
  service account deletes the results it owns, and a result is saved for a
  service account only while it exists, so an account created later with the
  same name inherits none.
- Downloads are audited with `detail.by` set to `csv_link` (and the
  address) or `credential`. A refusal is a `deny` row with the error kind as
  `reason` and, where the cause is not the kind, `detail.why` (`no_role`,
  `no_such_person`, `account_unavailable`). A credential that presents
  someone else's link gets a `deny` row as the presenter, with
  `detail.link_owner` naming the link's owner. Two refusals write no row, by
  design: a bad or expired signature without a credential has no principal
  to record (`audit_event.principal_*` is not null), and a rate-limited
  request, so that a burst cannot fill the audit log; the limits bound both.
- Pages and previews are bounded (500 rows, 16 KiB, a row over it left
  out), and a daily row budget per principal stops an agent in a loop
  from copying a model out. Queries in flight hold 100,000 rows each
  against it, at most 4 at once, so parallel queries cannot pass it. The
  query log holds the DAX, never a row, and Power BI's error sentence
  reaches only the entry's own principal.
- The catalog's own reads of a model (`readModelView`, logged with
  `origin` `catalog`) count against neither the row budget nor the usage
  report, so a person does not spend their budget on reads they never
  asked for. They stay bounded without it: each is a fixed `INFO.VIEW`
  query over the model's metadata with no preview, run as the person, only
  when the model was never read or its schema changed, and at most once
  per person and dataset in 5 minutes (`services/mirror/info-views.ts`).
  They stay in the query log, so an admin still sees every query that
  reached Power BI under a person's name, but the entry names no result:
  a catalog read's rows name the model's columns, personal data included,
  and are deleted once read. A catalog read also skips the per-minute
  query count, the cap of 4 queries at once and the personal-data query
  check, which is why only `readModelView` writes `catalog`, from a fixed
  argument no input reaches; a query an agent sends is always `request`.
- A CSV cell that starts like a formula gets a leading `'`, so a
  spreadsheet does not run it (`docs/decisions/queries.md`).

Tests: `apps/api/src/services/queries/result_ownership_security_test.ts`
(another person, a curator, an admin and a service account named as the
owner), `apps/api/src/services/queries/links_security_test.ts` (the CSV
link's signature and expiry),
`apps/api/src/routes/v1/csv_link_security_test.ts` (the link's reach, a
refused token with no link answered 401, the owner re-check, the limits
and the audit rows), `apps/api/src/services/queries/log_paging_security_test.ts`
(a search of the log under a policy that hides entries).

### B9: the setup link

Crossing: the first admin, before anyone can sign in.

- With no admin yet, the api logs at `warn` only that a link can be
  printed and the command that prints it. It never logs a link or a token:
  on a hosted platform whoever can read the log (an Azure Reader on the
  resource group, for 30 days) would otherwise open it first and become the
  first admin. `server setup-link` prints a new link, ending every earlier
  link and setup session. A link works once and for 24 hours; a setup
  session already open stays, within its 12 hours. `setup_link` keeps the
  SHA-256 of each value, never the value. Whoever can run a command in the
  container can print a link, and already holds its database credentials.
- The link is the SPA's `/setup` with the token in the fragment
  (`/setup#token=...`), which no request, log line or `Referer` carries.
  The screen posts it to `/api/setup/session` to spend it, then clears it
  from the address bar. `/setup` and `/api/setup` answer with
  `Referrer-Policy: no-referrer`. Every `/api/setup` response also carries
  `Cache-Control: no-store`.
- Spending the link opens a setup session for 12 hours at most: an
  `HttpOnly`, `Secure`, `SameSite=Strict` cookie,
  `__Secure-pbmb_setup`, on `/api/setup`. It acts with the admin's rights over
  the state and the address and app registration steps, as whoever can read
  the server's log could change the server anyway.
  It runs the scanner step because screen 2 comes before the sign-in.
  The setup state can carry workspace names. Its link's holder already
  acts as the server's operator, including when the scanner secret comes
  from the environment.
  This adds no new kind of trust: the link's holder can already set the sign-in app's secret.
  Every later step, which could make an admin (who gets in) or add a
  sign-in provider that mints one (sign-in), answers 404 to it and needs an
  admin's browser session.
- The setup API (`/api/setup`, `/api/setup/session`,
  `POST /api/setup/tenant`, `/api/setup/steps/<step>`) is on the public-paths list, because nobody
  can sign in yet. Each route checks its own credential: the setup session
  where it may, or an admin's browser session that passes the admin
  action. To anyone else each answers 404. Whenever a request finds an
  admin exists, every `setup_link` row is deleted, so no link or session
  outlives the first admin. The paths are outside `/api/mcp` and
  `/api/v1`, so a bearer token is never read there, and the origin check
  guards them. `POST /api/setup/tenant` makes one outbound fetch to the
  configured authority.
- Sign-in admits a person no role reaches only for the setup's own
  Microsoft sign-in. The setup session sets a single-use marker for 10
  minutes (`__Secure-pbmb_setup_sign_in`, `SameSite=Lax` to ride
  Microsoft's redirect, on `/api/auth`). When the holder's browser starts
  the Microsoft sign-in with it, the api keeps the SHA-256 of the OAuth
  `state` that start sent, and admits only the callback carrying that
  state, so a planted state cookie from a sibling subdomain (a login CSRF)
  admits nobody. The callback spends the marker on the person it made and
  expires its cookie.
- The app registration step then shows that person's email and name, and
  makes them the first admin only on a second request naming that email,
  from the same browser signed in as them: through `assignRole`, audited.
  Every link and session ends with it.
- The checks that need the scanner's secret run in the worker (B3).

Tests: `setup_link_security_test.ts`: single use, two spends at once, the
24 hours, the 12-hour session, `server setup-link` revoking earlier links,
only the latest start's link working with an open session kept, the setup session's allowed steps, every setup path
closed once an admin exists to a stale session and to a viewer; the limit
of 60 requests per address and clock minute across the setup paths, ahead
of the credential and the validator; the marker
refused without it, a second time, for a state the setup did not start,
after its 10 minutes and once an admin exists; the confirm step refusing
another email; the worker's check rows. Also `public-paths_security_test.ts`
and `security-headers_security_test.ts`.

### B10: the supply chain

Crossing: code and instructions written by others.

- Versions pinned exactly and at least a day old, lockfiles committed,
  images pinned by digest, skills and Actions by SHA. Released images are
  signed with cosign and shipped with an SBOM.
- `pnpm check:all` runs gitleaks, osv-scanner, trivy (the image and
  `compose.yml`), semgrep (public rule sets plus this repository's own)
  and zizmor (workflows).
- The mock's shapes come from Microsoft's documentation and its OpenAPI
  file; no answer recorded from a real tenant is committed.

Tests: `pnpm check:all` (gitleaks, osv-scanner, trivy, semgrep, zizmor), and
the pinned digests in `compose_security_test.ts`.

### B11: the maintaining agent

Crossing: tool output, Power BI metadata, results, thread bodies and
third-party skills, into an agent that can edit the repository or the
book.

- The agent rules in `agents.md`, and the deny rules in `.claude/`,
  `.codex/` and `.cursor/` behind them.
- No agent holds a production credential that can write; agents check a
  deployment read-only with `pbmb admin status`.
- The connector cannot change the book and an agent cannot set
  `human_verified`, so text injected through data cannot rewrite or sign
  off a definition.

Tests: no automated test proves an agent's behaviour, and that is a residual
risk. What proves the boundaries around it: the agents' settings deny reading
secrets and identity files, every security test fails when its boundary is
loosened, and review on sensitive paths goes through `CODEOWNERS`.

### B12: the host

Crossing: the host's root, Docker, and the operator.

- No container mounts the Docker socket. Each identity volume is mounted
  into its own container alone, mode 0400. Containers are hardened as in
  B3.

- The public demo runs in its own Dokploy project, with its own database,
  identities, secrets and edge network (`deploy/demo/`). The project's
  own demo shares its Dokploy server with a production deployment of the
  stack, since that is the one server it has, on one Docker host. There
  `dokploy-network` holds Traefik, both api containers and the server's
  other applications, several of their databases among them; Dokploy's
  dashboard and its database run off the server, in Dokploy's cloud. The
  demo's api is also on its own `app`, `egress` and `edge` networks and a
  `default` network Dokploy adds; its other containers are on its own
  `app` and `egress` only. Its layer puts `powerbi-mock` on `egress` only, with
  no published port and its control route on, so only the stack's own
  containers reach it. A one-shot `seed` service, off `edge`, runs with
  the api's environment, `DEMO_MODE=1` included, and writes the sample
  setup and book through an app built without the demo rule
  (`createApp(deps, { serveDemo: false })`), which only its own process
  holds and no request from outside reaches. It mounts the api's identity
  volume read-only. Only `api` has a domain.

Tests: `compose_security_test` (published ports, internal networks, the
hardening, no Docker socket, digests; the demo layer too: only `api` has a
domain or port, and the mock publishes nothing and is not on `app`).

## Residual risks

What the controls above do not close, and why it is accepted for now:

| Risk | Why it remains | What limits it |
|---|---|---|
| An admin can read PII through a second identity of their own | the rule that no admin gives themselves `pii_reader` binds role assignments to the admin's own email, groups, domain and tenant; an admin can still invite an address that reaches their own mailbox, such as a plus address, and give that person `pii_reader`, as they could before the rule. It is not separation of duty | the `people.invite` and `role.assign` audit rows name the admin who did both; the invite needs a mailbox the admin reads |
| An admin who loses admin outside the app keeps their open invites, including invites that give admin | a role change or a revoked assignment in the app revokes the demoted admin's open invites, but admin through a group is also lost when the identity provider drops them from the group, when the group evidence passes `SIGN_IN_FRESH_MS`, when a Disconnect clears it, or when the open admin invite that made them admin expires, and none of these runs under the assignment lock; acceptance does not ask whether the inviter still holds admin, so an invite they sent stays open until it expires, up to 7 days | an invite admits only a verified sign-in of its own email; offboarding someone in the app (Deactivate) revokes every invite they sent, so a removal at the identity provider should be paired with Deactivate; another admin can revoke the invites under People; the `people.invite` audit rows name the inviter |
| A person removed at the identity provider keeps their browser session for up to 7 days | a session lasts 7 days with no sliding renewal and nothing asks the provider again before it ends; access through a group, the tenant or a domain stops when that sign-in's evidence passes `SIGN_IN_FRESH_MS`, but a person or invite assignment does not go stale | a passkey's session ends 7 days after the provider sign-in behind it, and no passkey signs in after that; removing or moving the provider in the admin section ends its sessions, and every session and grant of a person who has no other way in; an admin's Sign out ends every session and MCP and CLI grant of one person and keeps their roles, and Deactivate does the same and keeps them out, so a removal at the identity provider should be paired with one of them; a person who lost a device ends their other sessions themselves with Sign out of all other sessions |
| Moving an OpenID Connect provider to another issuer does not stop its people's accounts being signed in to again | the move keeps the provider's account rows, and Better Auth finds a returning person by provider id and the subject the issuer sends, so a sign-in at the new issuer that sends a subject one of those rows holds signs in as that person | only an admin moves a provider, and the `setting.set` audit row records it; the move deletes the provider's secret, ends its sessions and stops its sign-ins counting, so groups and tenant or domain evidence from the old issuer no longer grant access; a fix is planned separately |
| A broken api can query Power BI as any connected person | it holds the key to their tokens, which it must to run their queries | the product asks only for read-only delegated grants, but a token carries whatever is consented on the registration, so it is read-only only if the registration is (see the sign-in app holding more, below); a database copy alone opens none; disconnecting deletes them (an admin's revoke is pending, with the admin section); refresh tokens lapse after 90 days unused; every query is in `query_log` |
| A broken worker reads every workspace's metadata and DAX | it holds the scanner's secret, which it must to sync | the worker takes no inbound traffic; the scanner reads metadata, never rows; its registration holds no API permission |
| Access lists lag Power BI | visibility is synced, up to one incremental sync for workspaces and one full sync for app audiences; a workspace or dataset whose list Power BI does not send (the scanner answers some with `users: null`) keeps its stored rows until it sends one, so a removal there is not picked up meanwhile. So does a workspace, dataset or app that fails, and an app whose audience cannot be read. When Power BI cannot list the apps, or limits or fails an audience read, every app's audience waits for the next full sync that reads them all. A failed full sync's lists wait for the next full sync where no incremental sync reads them: a workspace nothing changed in, and every audience | it decides metadata only; Power BI decides every query when it runs; each sync run counts the lists not sent (`access_lists_unsent`) and the admin section shows it; a failed full sync stays on the status page as `full_sync` until a full sync succeeds; a list sent empty revokes at once |
| Removing someone from an app's audience leaves their Build permission | Microsoft's rule | the docs say so; the dataset's own permissions take it back |
| Whoever can publish a Power BI model writes the DAX the worker reads on every sync, and can make it work hard | the book is built from that DAX, and every dataset that is on is read on each sync | a measure whose DAX or expansion passes 500,000 characters or 200 levels is recorded with that error and the sync files nothing for it, though a filing a curator made stays; a rewrite past 20,000 tokens or 100 variables leaves the measure as written, with a fingerprint; a dataset the drafter fails on rolls back alone, leaves its drafts as they were and the others going, and the run ends failed naming it; the drafter sends each list of measures or metrics as one array parameter, so a dataset of 33,000 measures or more no longer passes the 65,535 binds of a statement; each measure is read once for its dataset within a limit on what is kept, a composed shift reads only measures of at most 4,000 characters, as written and as written out, and holds a digest of each, and the event loop turns between measures in both readings, so what is kept for a measure stays limited and the heartbeat runs, though one measure that reaches thousands of long ones reads them all in one turn (47 s for 30 MB of DAX on a machine at a load of 35, under the 90 s the heartbeat allows); `crafted_dax_security_test`, `crafted_measure_security_test`. Many measures near the limits can still keep each sync running long until an admin turns the dataset off: a first draft of 33,000 small measures takes about three minutes, in proportion to the count, holding that dataset's metric rows meanwhile, and a sync that changes nothing about five seconds. It is read again whenever it changes. The stored text of a measure is not limited. The api is exposed too: the drafts queue's `suggestMerges` keeps every pair of names whose words match, about 900 MB of heap at 2,000 crafted spellings on each side of a pair, against the api's 512 MB limit, so a curator opening the queue could stop it until that is bounded |
| A model can keep its own workspace or dataset out of the mirror, and slow the sync | a scan's answer is capped at 32 MiB, and Microsoft documents no limit on a measure's length, so a long enough measure fails its workspace on every sync, and the dataset switch cannot stop a scan. While that workspace has changed since the last run that succeeded, every run ends failed: incremental scans go back to that run, every sync is full once that is 30 days old, or at once if no run ever succeeded. A failure in what only a full sync reads, a workspace nothing changed in or an app's audience, fails the full syncs alone: the incremental syncs between succeed, and the status page and `pbmb admin status` list `full_sync` until a full sync succeeds. Either way the stored access list of what failed stays, so a removal there is not picked up. **Workspaces to skip** ends it, at a price: the next full sync removes that whole workspace from the mirror, with its datasets, apps and access rows, and until then an app in it that Postgres refuses keeps failing each run. A curator's filings stay, and drafts the sync made that no one touched go with their measures. Answers near the cap hold about 600,000 small measures, which the store and the drafter work through for hours and could still run the worker out of memory; a worker that dies mid-job takes that job again first, with no limit on tries | the rest of the sync goes on: a failed scan is halved until the workspace at fault stands alone, a dataset or an app Postgres refuses rolls back alone, and the run names each by id. An app Power BI answers 404 for, or whose audience passes the limit or holds an entry this version cannot read, keeps its stored audience, and the run names it. A 429, a 5xx or a gateway's page of any status on an audience, or a list of apps or reports that cannot be read whole, leaves every app waiting for the next sync: the run says so and names no app, and one list entry this version cannot read does this on every run. A scan that fails whole, for a refused request, a 5xx, a scan out of time, a read that times out or a gateway's page, says how many workspaces it held, and the worker's log names them; a scan of one workspace names it, and that failure alone brings no advice to skip a workspace. Past 20 sentences a run's error says how many more, and the log has them. Narrowing adds at most 300 scans to a run, so someone holding about 20 workspaces past the cap can make the scans left fail whole, on every run, until an admin acts. No value is cleaned on its way into the mirror: Microsoft's rules keep a NUL and a name over 512 characters out of a model's names (`docs/decisions/powerbi.md`); an app has no such rule on record, and one holding such a value costs itself. Power BI decides every query. `isolation_security_test` |
| A metric a person worked on shows its key and label to every reader of any of its variants, wherever those words came from | anyone who can see one variant reads the metric's row. Any edit or verify counts as work, from a curator or an agent's token, and the draft then keeps its name (repo rule 9), which can still be the generated key and label. A curator may file any variant under any metric. A copy under the name of a measure the metric holds joins it, an existing untouched copy too, and whoever worked on the metric need not see that copy's readers. A filing then stays, whatever happens later to the measure that let it in. A metric a person worked on whose last variant leaves is read by everyone until someone deletes it. A removed measure stays in a draft of its own name, so once a person works on that draft, that measure's dataset's readers read those words. A draft a rule dismissed in an older book keeps the name it had: a plain list of metrics hides it, while the metric itself, its variant and the measures list still show it | words and a key only, never the hidden measure's DAX, data or variants; a person wrote or kept them, except on that dismissed draft; a generated key fails `metric_name_generated` until someone confirms it; a copy joins only under its own measure name, and at that moment only through a live measure in a dataset that is on and is not PII (`draft_name_security_test`) |
| An event keeps a metric's name from before a measure was marked PII | an event's `name` and `previous_name` are frozen when it is written, so a draft named from a measure later marked PII still shows that name in the feed, for up to 90 days. A deleted draft's event can show again after it was hidden while the draft lived, and no other read returns that name. The reader sees it on any event that recorded another measure it is shown, also after the draft is renamed or deleted. Stripping the name for such a reader would say which metrics hold a PII measure, as a missing name would then mean PII | words only, never the measure's DAX, data or id; the event is deleted after 90 days; while the metric keeps that name, its own read returns the same words to the same reader; an event with no recorded measure the reader is shown stays hidden (`pii_visibility_security_test`) |
| A generated key says a little beyond what its reader sees | one key serves every reader and must be unique: `net_sales_2` says that another metric or a curated alias holds `net_sales`, whoever can see it. A curator learns the same from the refusal when a new key or an alias is already a key, up to 100 guesses a request through aliases, or when a new key is already another metric's alias. A dataset that is off can hold an older book's foreign name, or a name a PII rule has covered since it went off, and shows it to its readers from the moment it is turned on until the job that drafts it has run. Two curators at the same moment can leave a key on another metric's alias, and that stays until someone renames it. A label is written as one dataset wrote it, so it can differ from the reader's own measure in case, punctuation or marks. A PII rule set, or an alias older than the refusal or one that raced it, takes effect on a draft's name at the next sync | the words are still the reader's own measure's name, or part of it when a number in that name reads as a `_2`; a refusal answers only about a word the caller supplied, and a probe can leave no `book_change` row, so the bound is the curator's role; the job after a dataset is turned on runs when the worker is free, and if it fails the next sync does the same; `metric_name_generated` reports the key until someone renames it |
| The query log shows every query to everyone signed in: its DAX, and the dataset's name and id, the measure names, the metric ids and the purpose | agents reuse DAX that worked; DAX can hold a literal value from a filter; a dataset or measure name shows that someone queried it | never a result row; Power BI's error sentence only to the one who ran the query; `query_log:read` is one policy rule a deployment narrows, and a search applies it in its SQL, so an entry it hides never reaches a page, `next_cursor` or whether more follow, and a word only a hidden entry holds answers like a word nobody holds (`log_paging_security_test`) |
| A metric event written while the metric held no variants stays visible to everyone after the metric is merged away or deleted | it was visible to everyone when written | name and ids only, never definitions |
| Gaps in the change feed's event ids show how much hidden activity there was | ids are one sequence for every reader, and a reader asks for what comes after the last id it saw | a gap says that something happened, never what, where or by whom; the feed filters before it cuts the page, so a hidden event never costs a reader a slot |
| Text indexes can miss, and unique checks let a duplicate in, from when glibc or Postgres moves until the api next starts | `collation.sql` runs only at a start, and a server can move under a running api: a managed Postgres's upgrade, or a Postgres image changed on its own under compose. Nothing here sees a move between starts | PII rule lookups read no fold index, so they hold throughout. What can miss is a row found by a text key. A `setting` does not: the store reads the whole table, one row per setting, and matches the key in code, so the store's reads never go through `setting_pkey` (the setup link's row lock still does, and on a stale index it can lock nothing, never another row, because a text key matches byte for byte; the settings it then reads are the whole table) and a saved `access.default_role`, `powerbi.connection_requires_matching_email` or sync filter is never answered as its default (`store.test.ts` fails if a read filters by key again). If a stale index let a second row in for one key, the store answers the newest by `set_at`, so an admin's tightening is not ignored. A rate limit's count reads as absent and starts again. A delete by text key can miss and leave its row. A dataset found by name, a session or a token reads as absent, which refuses. A second PII rule can get in, and PII wins between the two. A move that changes the fold reaches only names holding a changed character (27 code points from glibc 2.36 to 2.41, 36 from Postgres 17 to 18); a move that reorders text reaches ordinary names (34 of 41 from glibc 2.24 to 2.31). The next start of the api closes it. A worker's start does not rebuild, so restarting the worker alone leaves it open. If a duplicate got in, the start fails naming the index, and no new api starts until a person removes the row. That start has rebuilt every other index it reached, and a worker still running goes on reading through the ones left. If a minute passes with no index rebuilt, the start fails naming what is left, and the restart rebuilds again. Stored `tsvector`s are not rebuilt, which costs search recall and hides nothing |
| A customer's agent follows official skills installed from `main` | no release is tagged to pin to, so a commit on `main` reaches whoever next updates, and a skill instructs an agent that may hold an admin's login. GitHub enforces no review on this repository | an update is a step a person takes: a marketplace added by hand does not update itself by default, a copy in `~/.agents/skills` changes only when copied again, and the guide says to read what changed first. Pinning to the first tag is planned, not done (`docs/decisions/docs_and_skills.md`) |
| Metadata reaches the embedding provider | search embeds names, descriptions, display folders, term values and built-in documentation, including the dataset `owner` | the company's own account; never DAX, a result or a thread's text; a text is cut at 8,000 bytes; `search.provider: none` turns it off |
| A search query's text reaches the embedding provider | an agent can paste anything into `query`, a result's values included, and a link a person opens can carry a term in `/?q=`, which Home runs on load under the person's own limit (`/catalog/search` only redirects there) | the company's own account; at most 500 characters; 60 searches a minute per principal; `search.provider: none` turns it off |
| Whoever can publish a model can leave a person's meaning search empty | the vector walk stops after 20,000 index tuples (`hnsw.max_scan_tuples`), so someone who can publish a model can fill that cap with hidden rows near a query they chose, and the victim's meaning side then comes back empty with no note | it fails closed: the page shows less, never more, because the filter is in the scan itself. Words and exact matches do not use the vector index and still work. Accepted while one deployment's books stay small. It stops being right if a book grows to hundreds of thousands of documents, or if a hostile publisher shows up in practice: then rank per dataset, or raise the cap and say so in the answer's note. `search_visibility_security_test` fails if the cap is removed or lowered |
| The ID token from Microsoft's token endpoint is read without a signature check | OpenID Connect Core 3.1.3.7 allows it over TLS from the token endpoint | `https` to a fixed host only, outside development and test; at sign-in `iss`, `aud` and `tid` checked against the settings, at the connection `tid` and `oid` |
| Service-account queries run as the app's service principal, not a person | Microsoft gives a service principal no person's row-level security, and refuses it models that have it | off by default; only the workspaces an admin adds it to, if the app holds no application permission; Cerbos per service account; the api refuses a service account a model with row-level security before it fetches any token, so the rule does not rest on Power BI alone (`query_identity_security_test`). The flag it reads is the scan's `isEffectiveIdentityRolesRequired`, stored on every sync (`row_level_security_security_test`); until 23 November 2026 the sync never stored it, so the refusal never fired and Power BI alone refused. Unverified: whether a service principal holding an application permission such as `Tenant.Read.All` reaches a workspace nobody added it to. Verifying it takes a test tenant: grant the app that permission with admin consent, leave it out of one workspace, and run a service-account query on a model there |
| A sign-in app holding more than this product asks for gives a broken api what it holds | the product owner chose on 2026-11-03 to pass it with a note: the app may also serve another product, and the check was refusing what it could not improve. The app's secret and each person's token then reach what the registration holds: a delegated permission up to `Tenant.ReadWrite.All`, an application permission with no person behind it, and anything held only for another product | this product's code asks for nothing beyond `Dataset.Read.All` and `User.Read`, and sends the app's own token only on service-account queries, off by default; the note and the `explained` checklist item put the choice to a person, for what the check reads; the scanner's secret stays out of the api's reach. Not closed: the check reads no resource but Power BI, and a name does not show every write. `docs/decisions/powerbi.md`, "The setup checks the minimum" |
| An account made before sign-in checked `xms_edov` keeps the `email` Entra sent then, unchecked and marked verified | Better Auth does not overwrite a stored email on sign-in, and Entra fills `email` from `mail`, which hybrid tenants let on-premises staff write | each Microsoft sign-in compares the stored email with the one the token vouches for (`email` when `xms_edov` is true, otherwise the UPN); when they differ the stored email is marked unverified, so no person or domain assignment and no invite matches it, and the sign-in vouches for no domain. Not closed: until the person's next Microsoft sign-in, their sessions, passkeys and MCP and CLI tokens keep the old email verified, and the tokens can last longer than a session; afterwards a person whose stored email is not the vouched one gets roles only by group, tenant or `access.default_role`. A sole admin whose stored email is not their UPN, on a deployment without `xms_edov`, loses admin this way; the app registration guide says to check before upgrading, and the last-admin rule ignores such an assignment so the setup link reopens (issue i-7ok9). Also accepted: a Microsoft sign-in marks unverified an email that a Google sign-in or a password reset had verified, so the flag follows the last provider used |
| A sign-in provider vouches for an email it should not | an admin trusts the provider they add | Microsoft sign-in is single tenant; a provider is added with a test sign-in; a company that wants the Power BI connection tied to the verified email turns on `powerbi.connection_requires_matching_email` |
| A person connects a Power BI account that is not their own, such as a shared BI account | companies run DAX under shared accounts, and the person proved they can sign in as it | Power BI decides every query by that account's rights; the account gives no role and no tenant membership; each person's tokens are their own; the query log names the account; `powerbi.connection_requires_matching_email` forbids it |
| A leaked CSV link opens one result to anyone who holds it | the link is a bearer credential, so that an agent can download straight to a file | it names one result, expires after 15 minutes, is `GET` only, is limited per address, and its download is audited with the address; the owner must still hold a role; revoking the minting key or session leaves links working for up to 15 minutes, while disabling the account or removing the person's roles ends them at once |
| Without `TRUSTED_PROXY`, 60 link downloads a minute are shared by everyone behind the proxy | the proxy's address differs per deployment target | set `TRUSTED_PROXY` so the client's address is read; until then a busy minute can refuse other people's link downloads for up to a minute |
| Without `TRUSTED_PROXY`, every sign-in behind the proxy counts against one address | the proxy's address differs per deployment target, so the shipped `.env` leaves it empty | `stack/env.example` says what to set and `compose.yml` pins the `edge` range for it; until it is set, 60 starts a minute is shared by the whole company, so a busy morning or one person retrying in a loop can refuse everyone's sign-in for up to a minute; and no service account gets `source_cidrs`, since every request would seem to come from the proxy |
| Under `CLIENT_ADDRESS_HEADER=x-real-ip`, anyone with a route to the api past the platform edge names any client address | the mode trusts one header and Railway does not say its edge replaces a client-sent one; the private network from other services and a TCP Proxy reach the api without the edge | the mode is opt-in and off by default; `GET /api/v1/me` shows `client_address` so an operator checks it first; it cannot be combined with `TRUSTED_PROXY`, and `source_cidrs` is refused under it; an attacker with such a route can vary the address to escape per-address limits, spend a victim's limits so they are refused, forge the address in audit rows and session records, and set a device code's `started_from` to the victim's address |
| Passkey user verification is checked after Better Auth verifies the response, not by the WebAuthn library | Better Auth's passkey plugin verifies with `requireUserVerification: false` and has no option to change it | its `afterVerification` hooks refuse a registration or a sign-in without the UV flag before a passkey is stored or a session made, from the flags the signature covers |
| Better Auth is a young OAuth server | advisories in 2026, some critical, all fixed | pinned exact, advisories read on every bump, our own flow tests with the refresh-reuse test written first |
| A person presses Allow for a deceptive client | consent cannot read intent | the consent screen names the client and the redirect host; grants are revocable; audit records `via` and `client_id` |
| A token with `book:edit_conventions` weakens checks through `off`, exceptions, baselines or `required: false`, so `agent_verify_requires` means less in effect | the token's role is the company's decision; a baseline excepts only a target the change newly breaks and the caller can see, not existing failures or changes to exceptions alone | accepted: `agent_verified` is the agent's own tier; `trust.*` changes only from a browser; `show --json` and the MCP `whoami` tool report off rules and exception counts; every change and verification is in `book_change` |
| Conventions give hints about hidden elements | whole exception and failure counts, and `no_such_target`, give hints to someone holding the deployment's `conventions.yml`; a dataset addressed by id in an exception or check target says another dataset shares its name, even when that other dataset is hidden; an exception by a dataset name that more than one live dataset holds applies to nothing, for every caller, and the unused list reports it `ambiguous`, even to a curator who sees only one of the datasets, so it tells them a dataset they cannot see shares the name | accepted: apply and unused lists name only visible targets; element checks show only their own exception; company-part export requires `book:edit_conventions` and must round-trip the file |
| Text in data steers an agent's answer | the connector returns what Power BI, the book and threads say | the connector cannot change the book; approval needs a browser; agent rule 5 |
| A question or search holds personal data the server cannot redact | free text may name a customer or colleague; the server has no model to identify it | owner, curator and admin readers only by default; 180-day retention, at most 365; request deletion and deletion with the principal; capture can be turned off; tool instructions forbid copying result values |
| A planted question steers a curator's agent into changing the book | one person's agent records text that another person's agent later reads in the report | the report tool and curation skill mark text as data, never instructions; the skill requires showing proposals to the person before filing them; the connector cannot change the book |
| `age-encryption` is pre-1.0 | the TypeScript age library has not reached 1.0 | wrapped in one module; the format is age's, which is stable |
| A secret is readable inside its own container | a container must read what it uses | one process per container, non-root, each holding only its own secrets |
| Root on the host opens everything | the identity volumes are on it | hardened containers, identities per container, backups of dumps and identities kept apart |
| Anyone can read the whole sample book in the demo | the demo is public by design, as the Viewer with `access.metadata_visibility` set to `everyone`, so a crawler or a visitor sees every sample dataset | the data is invented and labelled as sample data; the demo person has no Power BI connection and cannot run a query, sign in or change anything |
| A visitor writes rows: the request limiter's counter, and on a search the search limiter's counter and one `embedding_usage` row | the demo limits each address to 240 requests a minute through the Postgres limiter (`demo:<address>`); search counts its own limit per address (`search:demo:<address>`) and records each embedding it asks for | one counter row per address per window for each limiter, an IPv6 address counted as its /64; the `embedding_usage` row is priced at the mock's rate, which costs nothing; no other visitor action is written |
| The mock's control route is open to every container on `egress` in the demo | the mock runs with `MOCK_CONTROL=1` so the seed can set the acting user | the mock publishes no port and is not on `app`; only the stack's own containers reach it |
| Traefik gets a new address on `dokploy-network`, and every visitor of a Dokploy deployment counts as Traefik; later Docker can give the old address to another container on the network, which may then name any client | the Dokploy guide and the demo README set `TRUSTED_PROXY` to Traefik's one address, and a Dokploy upgrade, a change to Traefik's settings, or a restart of Traefik, Docker or the server can give it a new one | both say to check `GET /api/v1/me` after each of those and set the new address at once; the api also logs, at most once a minute, a line for each address that sent `X-Forwarded-For` from outside `TRUSTED_PROXY`, so Traefik's new address shows in the log; a neighbour can send the header and get a line too, so the guide says to set only what the lookup prints, never an address from the log, and nothing raises an alert; until then sign-ins share one limit and a key limited by `source_cidrs` is refused, unless one of its ranges holds `dokploy-network`'s own; the old address goes to another container only once Docker hands it out again |
| The project's own demo shares its server with a production deployment. With code execution in the demo api, an attacker reaches production's api directly over `dokploy-network`, counted by the demo container's own address, and reaches Traefik and the server's other applications, some of their databases among them; a flood of the public demo spends the CPU, memory and disk production runs on. A neighbour container that keeps Docker's default `NET_RAW` capability can also pretend to be Traefik's address, and read the plain HTTP hop from Traefik to either api, tokens and results included | the project has one Dokploy server; every application on it joins `dokploy-network`, and Traefik reaches each api over it without TLS | since 2026-11-13 production's and the demo's `TRUSTED_PROXY` name Traefik's own address, so a neighbour without `NET_RAW` cannot name a client address to either; the api refuses to start with that address pasted as Docker prints it, with the network's prefix (`10.0.1.25/24`), which would trust the whole range again; the demo's containers drop every capability, so a compromised demo cannot use the layer-2 path, though the server's other applications may; every other application on the server already holds this position, and the demo adds one; the demo api serves GET only, with no sign-in, no Power BI connection, no real data and no secret that opens anything outside the demo; its containers are hardened as in B3, with memory and CPU limits and no Docker socket; Dokploy's dashboard and its database are not on the server; the server prunes unused images; every production route still checks its own credential; a second server ends the rest |
| The mock is not Power BI | no public mock exists and no client tenant is used | shapes from Microsoft's documentation and OpenAPI file; `pnpm test:live` on a test tenant before release |

## When this model must be updated

In the same pull request as a change that:

- adds, removes or moves a container, a network, a volume or a published
  port;
- adds a kind of route or credential, a sign-in method, or a public path;
- adds an outbound destination, a Microsoft permission, or a new kind of
  data leaving the stack;
- changes a database role or its grants, or which container reads a
  secret or a token;
- changes who may read a result, the query log or the mirror, or what the
  connector may change;
- adds a third-party component that runs inside the stack or instructs the
  agent: an image, a skill, an Action.
- changes demo mode's five locks, `DEMO_PATHS`, or the guarded fetcher's
  exception for the mock.

And when a residual risk changes: Microsoft changes what a scanner or a
service principal may do, Better Auth's advisories change, `age-encryption`
reaches 1.0, or a security incident shows a gap. The security review
(`agents.md`, rule 3) asks every time whether the change moved a boundary.
