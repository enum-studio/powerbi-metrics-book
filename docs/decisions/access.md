# Access: OAuth for MCP clients and the CLI

## Dynamic registration needs no Origin

**`/api/auth/oauth2/register` is exempt from the origin check, like the
token and device authorization endpoints.** Decided 2026-10-25 by the
coordinator: native MCP clients (Cursor, Codex) register from a process
that sends no Origin, and a registration grants nothing until a person
presses Allow (`oauth_security_test`). Stops being right if a registered
client could ever skip consent; that test fails then.

## A bearer request needs no Origin

**A state-changing request with `Authorization: Bearer` and no cookie at
all passes the origin check and is judged by its token; a request with a
cookie is checked, token or not.** Decided 2026-10-25 by the coordinator,
a gap in the spec that refused every MCP and CLI write. What makes it safe
is that the check is skipped only when no cookie comes, and `authenticate`
judges a request with a bearer token by the token alone, so a browser's
ambient cookie never authenticates a request that skipped the check. Stops
being right if a bearer request with no cookie could ever be authenticated
by something other than its token; `origin-check_security_test` checks the
cookie and both-together cases.

## Device and user codes are stored in clear

**Exception to rule 10: `device_code.device_code` and `user_code` hold the
raw codes.** Awaiting Martin's sign-off. Better Auth 1.7.12's device
plugin finds a code by its raw value and has no hook to store a digest
(`better-auth/dist/plugins/device-authorization/routes.mjs`,
`redeemDeviceCode`). A device code is single use, lives 10 minutes, and is
exchanged on the CLI's next poll, about 5 seconds after the person allows
it, so a copy read from the database is worth a login only in that window.
Stops being right when Better Auth can store digests, or if codes ever
live longer.

## The JWT signing key is encrypted with the auth secret

**Exception to rule 10: the private half in `jwks.private_key` is
encrypted by Better Auth with `AUTH_SECRET`, not with age.** Awaiting
Martin's sign-off. Only the api reads `AUTH_SECRET`, so a database dump
alone cannot sign a token. The api's age vault
(`apps/api/src/services/connection/vault.ts`) landed on build/v1 with the
Power BI connection; the jwt plugin's `adapter` option could store the key
sealed with it. Stops being right if `AUTH_SECRET` is ever readable beside
the database, or once the key is moved into the vault.

## A replayed authorization code leaves its JWTs working

**Accepted (L5): a replayed authorization code is refused and its stored
tokens deleted, but the JWT access tokens it already signed live out their
hour.** Awaiting Martin's sign-off. JWTs are not stored, and PKCE makes a
replay useless to anyone without the verifier, which never leaves the
client. Stops being right if a client could be issued codes without PKCE.

## Visibility follows Power BI

**By default a person sees the metadata of what Power BI's access lists (workspaces, app audiences,
direct shares, groups) let them reach. `everyone` and `policy` are the other modes.** Taken
2026-10-25 (review item 13). The book then never shows a person a dataset that Power BI would hide
from them. The check fails closed: an entry counts only with a right that is neither missing nor
`None`, and a person's own object id counts only while fresh (a Microsoft sign-in, a Power BI
connect or a groups read within 7 days). Stops being right if Power BI's access lists stop being readable through the
Scanner API.

## Sign-in is the company's choice

**Microsoft is always on. Google, any OpenID Connect provider and passkeys are added in the admin
section with a client id and secret; `sign_in.passkeys` defaults to false.** Taken 2026-10-25 (review
item 16). A person who signs in another way connects a Microsoft account with the same verified
email. Hardening found in the sign-in security review (2 high, 6 medium): a group assignment
matches only within the provider that issued the group (`role_assignment.provider`, a change to the
spec); person and email-domain assignments match only a verified email, and a Microsoft email
counts as verified only from the configured tenant; a Google sign-in matches a domain only when
the token's `hd` says so. A session lasts 7 days with no sliding renewal (12 hours until 2026-11-11,
when Martin found signing in twice a day too often). Groups read at a sign-in are ignored after 7
days, and so is a sign-in's evidence of tenant or domain, so for access through a group, the tenant
or a domain a longer session would only meet a refusal. Person and invite assignments do not go
stale that way: someone removed at the identity provider keeps a session, and a passkey, that the
provider no longer stands behind. So a passkey sign-in needs a provider sign-in within 7 days, and
its session ends 7 days after that provider sign-in, not 7 days after the passkey's. Only an
allow-list of Better Auth endpoints is served; ID-token sign-in and implicit account linking are
off; passkeys require user verification. Moving a provider to another issuer or kind, or removing it,
deletes its secret, ends the sessions it made and stops its sign-ins counting, in the same
transaction, so an admin cannot send a client secret to a host of their own and no session the
provider made outlives the change. A passkey session of its people then ends 7 days after their
latest sign-in left, at once when that is past, and a person with no account left at a way of
signing in still on loses every session and grant. Turning email and password off does the same
for password sign-ins, and turning passkeys off ends passkey sessions. A moved provider's account
rows stay, so this does not stop a sign-in through the new issuer (threat model, residual risks). A
person removed at the identity provider still keeps their session for up to 7 days, so removal
there is paired with Deactivate here. Stops being right when Better Auth changes any of these
defaults; re-read its release notes on every bump.

## Roles, and who may hold them

**`viewer`, `curator`, `admin` and `pii_reader` are assigned as they are; any other well-formed role name needs
`--custom`, so typos are refused. `access.default_role` is `none`, `viewer` or `curator`, never
`admin`, and applies only when no other assignment reaches a person. `admin` and `pii_reader` go
only to a person or a group, never to `everyone_in_tenant` or an email domain (a database CHECK).** A company's own
roles still need no code. The last-admin rule (`hasAdmin`) counts person assignments only, ignoring deactivated people and people whose stored email is unverified. The setup
link reopens by the same rule (`deployment_has_admin()`) (`services/auth/deactivation_security_test.ts`). Stops being right if a company needs admin by domain; that would weaken
the last-admin rule.

## An admin gives themselves nothing an admin lacks

**An admin cannot assign `pii_reader` or a custom role to a group, an email domain or everyone in the tenant that reaches them; a shipped role other than `pii_reader` stays allowed.** Recorded 2026-11-08. Admins do not read PII, so an admin in a group could otherwise make themselves a PII reader. A custom role's powers live in Cerbos policies the api cannot read, so it is treated as more than admin. `viewer` or `curator` for a group the admin is in adds nothing to an admin. Whether a subject reaches the caller is read from everything on record for them, however old (`subjectOnRecord`): the groups of their latest connection read and of their latest sign-in through each provider, their email's domain, and the tenant if a Microsoft account of theirs is on record, so a Disconnect or a stale read does not hide a group they are in. Only a group, domain or tenant that names them after the assignment is not caught, including a group their latest read had dropped, and the `role.assign` audit row is the record. In practice no admin who has used Microsoft here can give a custom role to everyone in the tenant. The rule covers role assignments, not an admin who controls sign-in: an OpenID Connect provider an admin adds can claim any group, and a service account an admin creates can hold a custom role. Nor does it catch a second identity, which was possible before this rule too: an admin can invite an address that reaches their own mailbox, such as a plus address, and give that person `pii_reader`. The rule is not separation of duty, and the `role.assign` audit row is the record.

Stops being right if admin stops including every shipped role but `pii_reader`, or if the api can read what a custom role grants. `services/admin/people_lifecycle_security_test.ts` holds it.

## PII read can be narrowed, never widened

**Only a person holding `pii_reader` can read PII, and a deployment's own Cerbos policy cannot
change that.** `createAccess.check` refuses `pii` to everyone else before it asks Cerbos, and the
shipped rule also requires `kind == "person"`. A policy can still narrow who reads PII. The spec's
goal is that admins do not get PII by being admins and no service account ever gets it; an override
policy granting `pii:read` to `*` would break both. Stops being right if a company needs a role
other than `pii_reader` to read PII; that would need a named exception in code.

## Service accounts

**Service-account queries are off by default. A service account queries through the sign-in app's
own service principal, only in workspaces and apps an admin gave it, in every visibility mode; a
deployment policy can narrow that, never widen it. It never holds `admin` (a database CHECK) and is
refused every admin action and `book:edit_conventions` in code, whatever a deployment's policies
say.** Taken 2026-10-25 (review item 5), with the second sentence added in the build: a leaked admin
key could otherwise mint new keys forever. The one admin action it may hold is `admin:read_status`,
for the read-only deployment check. `source_cidrs` is refused while `TRUSTED_PROXY` is unset,
because behind a proxy the api sees only the proxy's address. Stops being right when key pairs
(`private_key_jwt`) arrive, which need their own rule for what a key may do.

## Cerbos layering by scope

**The default policies sit at the root scope; a deployment's own sit in scope `deployment`, and
every request names `deployment`.** Lenient scope search falls back to the defaults, and a
deployment policy overrides or narrows with `scopePermissions`. A company then adds a rule without
copying ours. Stops being right if Cerbos changes how scopes fall back; `access/tests/` and the
layering tests check it.

## The CLI and MCP clients

**The CLI is the first-party public OAuth client `pbmb-cli`, found through RFC 8414 metadata. The
scopes are `mcp`, `api` and `offline_access`. A token works only while the person's consent to its
client stands, and reuse of a refresh token revokes that consent.** Better Auth leaves a JWT working
after refresh-token reuse (#11317), so the token endpoint is wrapped. The device flow takes no
caller-chosen `user_id`, returns no `verification_uri_complete`, and is claimed only by a person
typing the code. The CLI speaks only https, or http to a loopback host, before it sends a token or
key. Stops being right when Better Auth revokes a token's family on reuse.

## Who sees an email

**A person's email is shown only in the admin section and on `/me`. Everywhere else a person is
their display name.** Decided in the review of the metric review page. A matrix test checks that no non-admin body
carries a seeded email. Term and category thread authors are named only for callers who can see at
least one dataset. Stops being right if curators need to contact an author; they would use the
thread.

## An invite holds its role until acceptance

**An invite holds the role until a verified sign-in accepts it.** Recorded 2026-11-08 from the users and invites build. Assigning it at send time let expired and revoked invites admit people. An open, unexpired invite matches a verified email; acceptance records the user and inserts the person assignment in one transaction, without duplicating an equal assignment. Existing assignments survive migration.

Stops being right if acceptance binds a pre-provisioned identity instead of email. `services/auth/invite_acceptance_security_test.ts` and `services/auth/invites_security_test.ts` hold acceptance, expiry and revoke.

## A link invite cannot prove a mailbox

**An invite delivered as a link never sets a password.** Recorded 2026-11-08. The admin sees the link, so possession cannot prove access to the recipient's mailbox. Password acceptance refuses it like an invalid token; a verified provider sign-in may still accept the invite.

Stops being right if password setup gets a separate mailbox proof. `services/auth/invites_security_test.ts` holds the refusal.

## Deactivation wins in roleSubject

**Deactivation beats every assignment and is read in `roleSubject`.** Recorded 2026-11-08. `resolveRoles` then answers no roles for sign-in, sessions and bearer requests, even when a group, domain, default role or setup would admit the person. Removing assignments alone would let inherited access bring them back.

Stops being right if a credential path bypasses these functions. `services/auth/deactivation_security_test.ts` covers each way in; `services/admin/people_lifecycle_security_test.ts` holds session, grant and Power BI cleanup and the last active admin rule.

## A role taken away refuses a waiting change

**`lockAsAdmin` refuses a change when a role its Cerbos check decided on has been taken away since, and does not ask Cerbos again.** Recorded 2026-11-08. Cerbos reads a setting through the pool, and under the assignment lock only the transaction's own connection is used. Losing any role refuses, even one that gave no admin power, such as `pii_reader`; the caller tries again with a fresh check. Gaining a role never refuses, because the shipped policies only allow.

Stops being right if a deployment's own policy denies an admin action to a role, so that adding it takes access away, or if Cerbos stops reading settings per check. `services/admin/people_lifecycle_security_test.ts` covers a caller demoted after its check.

## New deployments start with no default role

**A new deployment's setup stores `access.default_role` = `none`; the registry default stays `viewer`.** Recorded 2026-11-08. Invites should control first access, and an upgrade must not lock anyone out. A migration may hold only what `db:generate` writes (architecture.md), so no migration can store `viewer` for the deployments that already exist; storing `none` at setup gives new deployments invite only with no data step. A deployment made without the setup flow starts at `viewer`.

Stops being right if deployments are created other than through setup, or if upgrades explicitly require a new access choice. `db/schema/invites.test.ts` and the setup tests check an upgraded deployment's viewer access, a stored choice kept, and none stored at setup.

## Two ways to end sessions early

**A person signs out of their other browsers themselves, and an admin signs a person out everywhere without deactivating them.** Recorded 2026-11-11, when the browser session went from 12 hours to 7 days with no sliding renewal. A lost or shared laptop then stays signed in for a week, and Deactivate was the only way to end it, at the cost of the person's grants, Power BI connection and invites. The person's own button is Better Auth's `/revoke-other-sessions` on the session-path allow-list, so it needs a browser session and its Origin and keeps the one that asked; their MCP and CLI grants stay, since they revoke those one by one. The admin's Sign out is its own Cerbos admin action, `sign_out_person`, which the shipped admin role holds. It ends every session and grant in one transaction under the assignment lock and keeps roles, invites and the Power BI connection. Removing a provider now signs out the same way anyone whose every account was that provider's.

Stops being right if sessions slide again or get much shorter, or if a person needs to see and end one session at a time. `services/auth/other_sessions_security_test.ts` and `services/admin/sign_out_person_security_test.ts` hold both actions.
