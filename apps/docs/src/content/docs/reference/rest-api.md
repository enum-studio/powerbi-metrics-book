---
title: "REST API"
description: "Every route, grouped, with who may call it and its shapes."
sidebar:
  order: 40
---

<!-- Generated from apps/api/openapi.json by scripts/gen-reference.mjs. Do not edit; change the code and run: pnpm --filter @powerbi-metrics-book/docs gen:reference -->

The REST API of Power BI Metrics Book. Every route checks its own credential.

The same document is at `apps/api/openapi.json` in the repository. Errors answer `{ "error": kind, "message": ... }` with the status the kind maps to. A dataset the caller may not see is answered 404, as a missing one is.

## Credentials

| Credential | What |
| --- | --- |
| `session_cookie` | A browser session. A request that changes anything must come from the site's own origin. |
| `oauth_bearer` | An OAuth access token for scope api, from `pbmb login` or an MCP client's grant. |
| `api_key_bearer` | A service account's API key. |

## Who may call a route

Each route lists the callers that get past authorization. Any other caller is answered 401 (no credential, or one this route does not take), 403 (a credential without the role) or 404 (the thing is not there, or not one the caller may see). The list comes from the authorization matrix, which a test holds the code to, with a real request for each caller on the sample tenant. The callers it tries:

| Caller | Means |
| --- | --- |
| `anonymous` | no credential |
| `outsider` | a signed-in person with no role on the data |
| `viewer` | a viewer |
| `curator` | a curator |
| `admin` | an admin |
| `curator_elsewhere` | a curator outside the data's audience |
| `service_account` | a service account with no grant |
| `service_account_granted` | a service account with a grant |
| `curator_cli_token` | a curator signed in with `pbmb login` |
| `curator_mcp_token` | a curator's MCP client token |
| `curator_session` | a curator's browser session |

## admin

### GET `/api/v1/admin/pii/rules`

List PII rules with their current live coverage

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `pii` | query | one of "true", "false" | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | List PII rules with their current live coverage | an object with rules |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `rules` | a list of an object | yes |   |

Other answers: 400 Validation Error; 401 Sign in first; 403 The caller's role or credential does not allow it.

### PUT `/api/v1/admin/pii/rules`

Set a PII rule

Who may call it: An admin.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `expected_version` | text or null | no |   |
| `kind` | one of "column", "measure", "table" | yes |   |
| `table` | text | yes |   |
| `name` | text | no |   |
| `pii` | true or false | yes |   |
| `note` | text or null | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Set a PII rule | an object with rule, before, columns, measures, datasets |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `rule` | an object with id, kind, table_name, name, pii, note, set_by_kind, set_by_id, set_via, set_at, version | yes |   |
| `before` | an object with id, kind, table_name, name, pii, note, set_by_kind, set_by_id, set_via, set_at, version or null | yes |   |
| `columns` | a number | yes |   |
| `measures` | a number | yes |   |
| `datasets` | a number | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 409 It conflicts with the book as it is.

### DELETE `/api/v1/admin/pii/rules/{id}`

Remove a PII rule

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |
| `expected_version` | query | text | no | The expected rule version. |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Remove a PII rule |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### GET `/api/v1/admin/pii/suggestions`

Suggest columns that may contain PII

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `dataset` | query | text | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Suggest columns that may contain PII | an object with suggestions |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `suggestions` | a list of an object | yes |   |

Other answers: 400 Validation Error; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/admin/datasets`

List datasets and their live contents

Who may call it: An admin.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | List datasets and their live contents | an object with datasets |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `datasets` | a list of an object | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### PUT `/api/v1/admin/datasets/{dataset}`

Enable or disable a dataset

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `dataset` | path | text | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `enabled` | true or false | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Enable or disable a dataset | an object with id, name, enabled |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `enabled` | true or false | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/admin/settings/{key}`

A setting with its last check

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `key` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | A setting with its last check | AdminSetting |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `key` | text | yes |   |
| `value` | any value | yes |   |
| `source` | one of "environment", "database", "default" | yes |   |
| `environment_variable` | text | yes |   |
| `description` | text | yes |   |
| `environment_only` | true or false | yes |   |
| `problem` | text or null | yes |   |
| `check` | an object with status, message, pending, details, checked_at or null | yes |   |
| `redirect_uris` | an object with microsoft, google, oidc or null | yes |   |

Other answers: 400 Validation Error; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### PUT `/api/v1/admin/settings/{key}`

Save a setting after its check; save_failing keeps a failing value

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `key` | path | text | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `value` | any value | yes |   |
| `save_failing` | true or false | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Save a setting after its check; save_failing keeps a failing value | AdminSetting |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `key` | text | yes |   |
| `value` | any value | yes |   |
| `source` | one of "environment", "database", "default" | yes |   |
| `environment_variable` | text | yes |   |
| `description` | text | yes |   |
| `environment_only` | true or false | yes |   |
| `problem` | text or null | yes |   |
| `check` | an object with status, message, pending, details, checked_at or null | yes |   |
| `redirect_uris` | an object with microsoft, google, oidc or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### GET `/api/v1/admin/secrets`

Every secret: whether it is set, its last four characters, who set it, its expiry and last check

Who may call it: An admin.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Every secret: whether it is set, its last four characters, who set it, its expiry and last check | an object with secrets |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `secrets` | a list of AdminSecret | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### PUT `/api/v1/admin/secrets/{name}`

Set a secret. Write-only: the answer never holds the value

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `value` | text | yes |   |
| `expires_at` | text (date-time) or null | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Set a secret. Write-only: the answer never holds the value | AdminSecret |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `name` | text | yes |   |
| `readers` | a list of one of "api", "worker" | yes |   |
| `set` | true or false | yes |   |
| `needs_reentry_for` | a list of one of "api", "worker" | yes |   |
| `hint` | text or null | yes |   |
| `set_by` | text or null | yes |   |
| `set_at` | text (date-time) or null | yes |   |
| `expires_at` | text (date-time) or null | yes |   |
| `checked_at` | text (date-time) or null | yes |   |
| `check_status` | one of "passing", "failing", "unchecked" or null | yes |   |
| `check_message` | text or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### PUT `/api/v1/admin/secrets/{name}/expiry`

Set a saved secret's expiry date, leaving its value as it is

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `expires_at` | text (date-time) or null | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Set a saved secret's expiry date, leaving its value as it is | AdminSecret |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `name` | text | yes |   |
| `readers` | a list of one of "api", "worker" | yes |   |
| `set` | true or false | yes |   |
| `needs_reentry_for` | a list of one of "api", "worker" | yes |   |
| `hint` | text or null | yes |   |
| `set_by` | text or null | yes |   |
| `set_at` | text (date-time) or null | yes |   |
| `expires_at` | text (date-time) or null | yes |   |
| `checked_at` | text (date-time) or null | yes |   |
| `check_status` | one of "passing", "failing", "unchecked" or null | yes |   |
| `check_message` | text or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### GET `/api/v1/admin/checks/{name}`

Where a check the worker runs stands; it starts nothing

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Where a check the worker runs stands; it starts nothing | AdminCheck |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `status` | one of "passing", "failing" | yes |   |
| `message` | text or null | yes |   |
| `pending` | true | no |   |
| `details` | an object | no |   |

Other answers: 400 Validation Error; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### POST `/api/v1/admin/checks/{name}`

Run a check by name and keep its result

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Run a check by name and keep its result | AdminCheck |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `status` | one of "passing", "failing" | yes |   |
| `message` | text or null | yes |   |
| `pending` | true | no |   |
| `details` | an object | no |   |

Other answers: 400 Validation Error; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/admin/status`

The last sync, failing checks and secrets near expiry (admin:read_status)

Who may call it: An admin.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The last sync, failing checks and secrets near expiry (admin:read_status) | an object with connections_needing_reconnect, version, git_sha, last_sync, failing_checks, secrets_expiring, people_to_reconnect |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `connections_needing_reconnect` | a number | yes |   |
| `version` | text | yes |   |
| `git_sha` | text | yes |   |
| `last_sync` | an object with status, started_at, finished_at, kind, error or null | yes |   |
| `failing_checks` | a list of an object | yes |   |
| `secrets_expiring` | a list of an object | yes |   |
| `people_to_reconnect` | a list of an object | no |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### GET `/api/v1/admin/roles`

Every role assignment

Who may call it: An admin.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Every role assignment | an object with roles |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `roles` | a list of AdminRoleAssignment | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### POST `/api/v1/admin/roles`

Assign a role

Who may call it: An admin.

Body (JSON): an object with role, custom, subject_kind, subject or an object with role, custom, subject_kind, provider, subject or an object with role, custom, subject_kind.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 201 | Assign a role | AdminRoleAssignment |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `id` | text | yes |   |
| `role` | text | yes |   |
| `subject_kind` | one of "person", "email_domain", "group", "everyone_in_tenant" | yes |   |
| `subject` | text or null | yes |   |
| `provider` | text or null | yes |   |
| `granted_by` | text | yes |   |
| `granted_at` | text (date-time) | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 409 It conflicts with the book as it is.

### DELETE `/api/v1/admin/roles/{id}`

Revoke a role assignment, never the last admin's

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Revoke a role assignment, never the last admin's |   |

Other answers: 400 Validation Error; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### GET `/api/v1/admin/people/invites`

List open invites

Who may call it: An admin.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | List open invites | an object with invites, email_ready |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `invites` | a list of an object | yes |   |
| `email_ready` | true or false | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### POST `/api/v1/admin/people/invites`

Invite people by email or link

Who may call it: An admin.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `emails` | a list of text (email) | yes |   |
| `role` | text | yes |   |
| `delivery` | one of "email", "link" | yes |   |
| `custom` | true or false | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Invite people by email or link | an object with invites |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `invites` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 409 It conflicts with the book as it is; 429 Too many requests.

### POST `/api/v1/admin/people/invites/{id}/resend`

Resend an invite

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Resend an invite | an object with expires_at, link |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `expires_at` | text (date-time) | yes |   |
| `link` | text or null | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 429 Too many requests.

### DELETE `/api/v1/admin/people/invites/{id}`

Revoke an invite

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Revoke an invite |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### PUT `/api/v1/admin/people/{id}/role`

Set a person's direct role

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | text | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `role` | one of "viewer", "curator", "admin" | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Set a person's direct role |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### PUT `/api/v1/admin/people/{id}/pii`

Set a person's PII reader access

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | text | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `allowed` | true or false | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Set a person's PII reader access |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### POST `/api/v1/admin/people/{id}/deactivate`

Deactivate a person

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Deactivate a person |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### POST `/api/v1/admin/people/{id}/reactivate`

Reactivate a person

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Reactivate a person |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### POST `/api/v1/admin/people/{id}/sign-out`

End a person's sessions and MCP and CLI grants

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | End a person's sessions and MCP and CLI grants |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### DELETE `/api/v1/admin/people/{id}`

Delete a person

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Delete a person |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### PUT `/api/v1/admin/branding/logo`

Store the brand logo

Who may call it: An admin.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | The logo is stored. |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### DELETE `/api/v1/admin/branding/logo`

Remove the brand logo

Who may call it: An admin.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Remove the brand logo |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### GET `/api/v1/admin/people`

Each person with their roles, where each comes from, and their Power BI connection

Who may call it: An admin.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Each person with their roles, where each comes from, and their Power BI connection | an object with people |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `people` | a list of an object | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### GET `/api/v1/admin/sync`

The newest sync runs

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `limit` | query | a whole number, at least 1 and at most 100 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The newest sync runs | an object with runs |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `runs` | a list of AdminSyncRun | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### POST `/api/v1/admin/sync`

Queue a sync now, unless one waits or runs

Who may call it: An admin.

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `kind` | one of "incremental", "full" | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | One already waits or runs, and this is its job. | an object with job_id, queued |
| 202 | A sync was queued. | an object with job_id, queued |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `job_id` | text | yes |   |
| `queued` | true or false | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### GET `/api/v1/admin/service-accounts`

Every service account

Who may call it: An admin.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Every service account | an object with service_accounts |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `service_accounts` | a list of AdminServiceAccount | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### POST `/api/v1/admin/service-accounts`

Create a service account

Who may call it: An admin.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `owner_email` | text | yes |   |
| `roles` | a list of text | yes |   |
| `workspace_ids` | a list of a GUID | no |   |
| `app_ids` | a list of a GUID | no |   |
| `source_cidrs` | a list of text | no |   |
| `max_key_age_days` | a whole number, at least 1 and at most 90 | no |   |
| `name` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 201 | Create a service account | AdminServiceAccount |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `name` | text | yes |   |
| `owner_email` | text | yes |   |
| `roles` | a list of text | yes |   |
| `workspace_ids` | a list of text | yes |   |
| `app_ids` | a list of text | yes |   |
| `source_cidrs` | a list of text | yes |   |
| `max_key_age_days` | a number | yes |   |
| `disabled_at` | text (date-time) or null | yes |   |
| `created_by` | text | yes |   |
| `created_at` | text (date-time) | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 409 It conflicts with the book as it is.

### PATCH `/api/v1/admin/service-accounts/{name}`

Change a service account's fields, or disable or enable it

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

Body (JSON): an object with disabled or an object with owner_email, roles, workspace_ids, app_ids, source_cidrs, max_key_age_days.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Change a service account's fields, or disable or enable it | AdminServiceAccount |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `name` | text | yes |   |
| `owner_email` | text | yes |   |
| `roles` | a list of text | yes |   |
| `workspace_ids` | a list of text | yes |   |
| `app_ids` | a list of text | yes |   |
| `source_cidrs` | a list of text | yes |   |
| `max_key_age_days` | a number | yes |   |
| `disabled_at` | text (date-time) or null | yes |   |
| `created_by` | text | yes |   |
| `created_at` | text (date-time) | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### DELETE `/api/v1/admin/service-accounts/{name}`

Delete a service account with its keys and results

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Delete a service account with its keys and results |   |

Other answers: 400 Validation Error; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/admin/service-accounts/{name}/keys`

A service account's keys, never the keys themselves

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | A service account's keys, never the keys themselves | an object with keys |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `keys` | a list of AdminApiKey | yes |   |

Other answers: 400 Validation Error; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### POST `/api/v1/admin/service-accounts/{name}/keys`

Make a key. The answer holds the key once, and no other answer does

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `expires_in_days` | a whole number, at least 1 and at most 90 | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 201 | Make a key. The answer holds the key once, and no other answer does | AdminNewApiKey |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `id` | text | yes |   |
| `service_account` | text | yes |   |
| `prefix` | text | yes |   |
| `created_by` | text | yes |   |
| `created_at` | text (date-time) | yes |   |
| `expires_at` | text (date-time) | yes |   |
| `last_used_at` | text (date-time) or null | yes |   |
| `revoked_at` | text (date-time) or null | yes |   |
| `key` | text | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### DELETE `/api/v1/admin/service-accounts/{name}/keys/{id}`

Revoke a key at once

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Revoke a key at once |   |

Other answers: 400 Validation Error; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### DELETE `/api/v1/admin/grants/{id}`

Revoke any person's MCP or CLI grant

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Revoke any person's MCP or CLI grant |   |

Other answers: 400 Validation Error; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/admin/audit`

The audit log, newest first

Who may call it: An admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `since` | query | text (date-time) | no |   |
| `principal` | query | text | no |   |
| `action` | query | text | no |   |
| `before_id` | query | a whole number, at least 1 and at most 9007199254740991 | no |   |
| `limit` | query | a whole number, at least 1 and at most 500 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The audit log, newest first | an object with events |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `events` | a list of AdminAuditEvent | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### GET `/api/v1/admin/export`

The deployment as book.yml: settings, conventions, roles and service accounts, never a secret or a key

Who may call it: An admin.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The deployment as book.yml: settings, conventions, roles and service accounts, never a secret or a key | an object with yaml |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `yaml` | text | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### POST `/api/v1/admin/import`

Compare a book.yml with the deployment; with apply, make the changes

Who may call it: An admin.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `yaml` | text | yes |   |
| `apply` | true or false | no |   |
| `save_failing` | true or false | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Compare a book.yml with the deployment; with apply, make the changes | an object with changes, kept, applied |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `changes` | a list of an object | yes |   |
| `kept` | an object with settings, role_assignments, service_accounts | yes |   |
| `applied` | true or false | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 409 It conflicts with the book as it is.

## apps

### GET `/api/v1/apps`

The Power BI apps the caller can see, with the datasets behind them

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The Power BI apps the caller can see, with the datasets behind them | a list of an object |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

## auth

### POST `/api/auth/sign-in/email`

email

Who may call it: Public: anyone, with no credential.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `email` | text (email) | yes |   |
| `password` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The password request succeeded; sign-in and invite acceptance set a session cookie. |   |

Other answers: 400 The input or link is invalid; 401 The credential is invalid; 403 Password sign-in is off or the person has no role; 429 Too many attempts.

### POST `/api/auth/invites/accept`

accept

Who may call it: Public: anyone, with no credential.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `token` | text | yes |   |
| `password` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The password request succeeded; sign-in and invite acceptance set a session cookie. |   |

Other answers: 400 The input or link is invalid; 401 The credential is invalid; 403 Password sign-in is off or the person has no role; 429 Too many attempts.

### POST `/api/auth/email/forgot-password`

forgot-password

Who may call it: Public: anyone, with no credential.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `email` | text (email) | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The password request succeeded; sign-in and invite acceptance set a session cookie. |   |

Other answers: 400 The input or link is invalid; 401 The credential is invalid; 403 Password sign-in is off or the person has no role; 429 Too many attempts.

### POST `/api/auth/reset-password`

reset-password

Who may call it: Public: anyone, with no credential.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `token` | text | yes |   |
| `newPassword` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The password request succeeded; sign-in and invite acceptance set a session cookie. |   |

Other answers: 400 The input or link is invalid; 401 The credential is invalid; 403 Password sign-in is off or the person has no role; 429 Too many attempts.

### POST `/api/auth/change-password`

change-password

Who may call it: Any signed-in person, in a browser only.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `currentPassword` | text | yes |   |
| `newPassword` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The password request succeeded; sign-in and invite acceptance set a session cookie. |   |

Other answers: 400 The input or link is invalid; 401 The credential is invalid; 403 Password sign-in is off or the person has no role; 429 Too many attempts.

### GET `/api/auth/config`

How a person may sign in here: providers, passkeys and the dev sign-in, and whether this is the sample tenant

Who may call it: Public: anyone, with no credential.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | How a person may sign in here: providers, passkeys and the dev sign-in, and whether this is the sample tenant | SignInConfig |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `providers` | a list of an object | yes |   |
| `passkeys` | true or false | yes |   |
| `email_password` | true or false | yes |   |
| `dev_sign_in` | true or false | yes |   |
| `sample_data` | true or false | yes |   |
| `demo` | true or false | yes |   |
| `setup_pending` | true or false | yes |   |
| `brand` | an object with name, company, logo_url, custom | yes |   |
| `invite_only` | true or false | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

## book

### GET `/api/v1/book/summary`

How much of the book the caller can see, for the home page

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | How much of the book the caller can see, for the home page | an object with datasets, metrics, not_filed |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `datasets` | a number | yes |   |
| `metrics` | an object with draft, agent_verified, human_verified | yes |   |
| `not_filed` | a number | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

## branding

### GET `/api/branding/logo`

Read the brand logo

Who may call it: Public: anyone, with no credential.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The stored image |   |

Other answers: 304 The image has not changed; 404 No logo is set.

## categories

### POST `/api/v1/categories/{path}`

Create a category

Who may call it: A curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `path` | path | text | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `name` | text | yes |   |
| `description` | text or null | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 201 | Create a category | Category |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `kind` | "category" | yes |   |
| `id` | text | yes |   |
| `key` | text | yes |   |
| `path` | text | yes |   |
| `name` | text | yes |   |
| `description` | text or null | yes |   |
| `icon` | text or null | yes |   |
| `position` | a number | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### PATCH `/api/v1/categories/{path}`

Rename a category (name, key), or move it (parent)

Who may call it: A curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `path` | path | text | yes |   |

Body (JSON): an object with parent, position or an object with name, key, description.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Rename a category (name, key), or move it (parent) | Category |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `kind` | "category" | yes |   |
| `id` | text | yes |   |
| `key` | text | yes |   |
| `path` | text | yes |   |
| `name` | text | yes |   |
| `description` | text or null | yes |   |
| `icon` | text or null | yes |   |
| `position` | a number | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### DELETE `/api/v1/categories/{path}`

Delete an empty category

Who may call it: A curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `path` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Delete an empty category |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### GET `/api/v1/categories`

The categories as a tree, with the metrics in each that the caller may see

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `parent` | query | text | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The categories as a tree, with the metrics in each that the caller may see | a list of CategoryNode |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

## conventions

### GET `/api/v1/conventions`

The company's conventions: the guide in words and the rules as data

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The company's conventions: the guide in words and the rules as data | an object with preset, guide, summary, rules |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `preset` | one of "metrics_book", "minimal" | yes |   |
| `guide` | text | yes |   |
| `summary` | a list of text | yes |   |
| `rules` | an object with preset, naming, metric_fields, term_fields, element_fields, variants, drafting, trust, checks | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### PUT `/api/v1/conventions`

Save the conventions as the next version

Who may call it: An admin.

Body (JSON): an object.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Save the conventions as the next version | an object with version, conventions, changes |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `version` | a number | yes |   |
| `conventions` | an object with preset, guide, naming, metric_fields, term_fields, element_fields, variants, drafting, trust, checks | yes |   |
| `changes` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### GET `/api/v1/conventions/versions`

Every saved version, newest first

Who may call it: An admin.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Every saved version, newest first | an object with versions |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `versions` | a list of an object | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### POST `/api/v1/conventions/diff`

What a document would change, unsaved

Who may call it: An admin.

Body (JSON): an object.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | What a document would change, unsaved | an object with changes |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `changes` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

## datasets

### GET `/api/v1/datasets`

The datasets the caller may describe, A to Z

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `workspace` | query | text | no |   |
| `app` | query | text | no |   |
| `name_prefix` | query | text | no |   |
| `cursor` | query | text | no |   |
| `limit` | query | a whole number, at least 1 and at most 500 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The datasets the caller may describe, A to Z | an object with items, next_cursor |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `items` | a list of an object | yes |   |
| `next_cursor` | text or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### GET `/api/v1/datasets/{id}`

One dataset described: its tables, relationships and descriptions

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | One dataset described: its tables, relationships and descriptions | an object with open_questions, accepted_answers, kind, id, name, icon, description, description_pbi, workspace, apps, reached_through, configured_by, target_storage_mode, has_row_level_security, endorsement, sensitivity_label, schema_error, schema_changed_at, created_date, synced_at, described_by, described_at, custom, relationships_source, relationships_read_at, relationships_note, relationships, tables, pii_hidden |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "dataset" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `icon` | text or null | yes |   |
| `description` | text or null | yes |   |
| `description_pbi` | text or null | yes |   |
| `workspace` | an object with kind, id, name | yes |   |
| `apps` | a list of an object | yes |   |
| `reached_through` | a list of an object | yes |   |
| `configured_by` | text or null | yes |   |
| `target_storage_mode` | text or null | yes |   |
| `has_row_level_security` | true or false | yes |   |
| `endorsement` | text or null | yes |   |
| `sensitivity_label` | text or null | yes |   |
| `schema_error` | text or null | yes |   |
| `schema_changed_at` | text (date-time) or null | yes |   |
| `created_date` | text (date-time) or null | yes |   |
| `synced_at` | text (date-time) | yes |   |
| `described_by` | text or null | yes |   |
| `described_at` | text (date-time) or null | yes |   |
| `custom` | an object | yes |   |
| `relationships_source` | one of "scanner", "info_view", "unavailable" or null | yes |   |
| `relationships_read_at` | text (date-time) or null | yes |   |
| `relationships_note` | text or null | yes |   |
| `relationships` | a list of an object | yes |   |
| `tables` | a list of an object | yes |   |
| `pii_hidden` | a number | no |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/datasets/{id}/columns`

A dataset's columns, A to Z

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |
| `table` | query | text | no |   |
| `name_prefix` | query | text | no |   |
| `cursor` | query | text | no |   |
| `limit` | query | a whole number, at least 1 and at most 500 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | A dataset's columns, A to Z | an object with items, next_cursor, pii_hidden |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `items` | a list of an object | yes |   |
| `next_cursor` | text or null | yes |   |
| `pii_hidden` | a number | no |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/datasets/{id}/columns/{column_id}`

One column: its table, terms, relationships and the measures that name it

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |
| `column_id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | One column: its table, terms, relationships and the measures that name it | an object with column, table, terms, relationships, used_by |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `column` | an object with kind, id, name, table, data_type, column_type, is_hidden, description, description_pbi, display_folder, terms, removed, pii, expression, format_string | yes |   |
| `table` | an object with id, name, description | yes |   |
| `terms` | a list of an object | yes |   |
| `relationships` | a list of an object | yes |   |
| `used_by` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/datasets/{id}/measures`

A dataset's measures, A to Z, with the metric that covers each

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |
| `table` | query | text | no |   |
| `unfiled` | query | one of "true", "false" | no |   |
| `cursor` | query | text | no |   |
| `limit` | query | a whole number, at least 1 and at most 500 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | A dataset's measures, A to Z, with the metric that covers each | an object with items, next_cursor, pii_hidden |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `items` | a list of an object | yes |   |
| `next_cursor` | text or null | yes |   |
| `pii_hidden` | a number | no |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

## drafts

### GET `/api/v1/drafts/next`

The next drafts to structure

Who may call it: A curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `dataset` | query | text | no |   |
| `limit` | query | a whole number, at least 1 and at most 50 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The next drafts to structure | a list of an object |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

## elements

### GET `/api/v1/elements/{kind}/{id}/docs`

An element's description and custom fields

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `kind` | path | text | yes |   |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | An element's description and custom fields | an object with element, description, description_pbi, described_by, described_at, custom |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `element` | an object with kind, id, name | yes |   |
| `description` | text or null | yes |   |
| `description_pbi` | text or null | yes |   |
| `described_by` | text or null | yes |   |
| `described_at` | text (date-time) or null | yes |   |
| `custom` | an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### PUT `/api/v1/elements/{kind}/{id}/docs`

Set an element's description and custom fields

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `kind` | path | text | yes |   |
| `id` | path | a GUID | yes |   |

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `description` | text or null | no |   |
| `custom` | an object | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Set an element's description and custom fields | an object with element, description, description_pbi, described_by, described_at, custom |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `element` | an object with kind, id, name | yes |   |
| `description` | text or null | yes |   |
| `description_pbi` | text or null | yes |   |
| `described_by` | text or null | yes |   |
| `described_at` | text (date-time) or null | yes |   |
| `custom` | an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### PUT `/api/v1/elements/{kind}/{id}/icon`

Set a metric's, category's, term's, workspace's or dataset's icon

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `kind` | path | one of "metric", "category", "term", "workspace", "dataset" | yes |   |
| `id` | path | a GUID | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `icon` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Set a metric's, category's, term's, workspace's or dataset's icon | IconSet |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `kind` | one of "metric", "category", "term", "workspace", "dataset" | yes |   |
| `id` | text | yes |   |
| `icon` | text or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### DELETE `/api/v1/elements/{kind}/{id}/icon`

Clear an element's icon

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `kind` | path | one of "metric", "category", "term", "workspace", "dataset" | yes |   |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Clear an element's icon | IconSet |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `kind` | one of "metric", "category", "term", "workspace", "dataset" | yes |   |
| `id` | text | yes |   |
| `icon` | text or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

## events

### GET `/api/v1/events`

The events after an id, oldest first, that the caller may see

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `after` | query | a whole number, at least 0 and at most 9007199254740991 | no |   |
| `kinds` | query | text | no |   |
| `limit` | query | a whole number, at least 1 and at most 500 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The events after an id, oldest first, that the caller may see | a list of an object |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

## icons

### GET `/api/v1/icons`

The glyph names and colors an icon may use

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The glyph names and colors an icon may use | IconChoices |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `glyphs` | a list of one of "chart-line", "chart-bar", "chart-column", "chart-pie", "chart-area", "chart-scatter", "chart-no-axes-column", "trending-up", "trending-down", "activity", "gauge", "target", "percent", "sigma", "circle-dollar-sign", "dollar-sign", "euro", "banknote", "coins", "wallet", "credit-card", "receipt", "piggy-bank", "landmark", "calculator", "badge-percent", "scale", "hand-coins", "user", "users", "user-round", "user-plus", "user-check", "contact", "handshake", "heart", "smile", "star", "award", "building", "building-2", "briefcase", "shopping-cart", "shopping-bag", "store", "package", "package-check", "box", "boxes", "truck", "tag", "tags", "ticket", "gift", "shirt", "warehouse", "barcode", "undo-2", "calendar", "calendar-days", "calendar-check", "clock", "timer", "hourglass", "history", "alarm-clock", "repeat", "map-pin", "map", "globe", "earth", "compass", "flag", "plane", "ship", "house", "factory", "database", "table", "table-2", "columns-3", "rows-3", "layers", "layout-dashboard", "filter", "search", "funnel", "network", "workflow", "git-branch", "code", "server", "cloud", "key", "lock", "shield-check", "file", "file-text", "file-spreadsheet", "file-chart-column", "folder", "folder-open", "book", "book-open", "bookmark", "clipboard-list", "notebook", "mail", "message-square", "bell", "info", "circle-help", "lightbulb", "square", "circle", "triangle", "diamond", "hexagon", "pentagon", "octagon", "zap", "sparkles", "flame", "leaf", "sun", "moon", "layout-grid", "hash" | yes | The glyph names, Lucide's. |
| `colors` | a list of one of "gray", "green", "teal", "blue", "violet", "red", "amber", "ink" | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

## me

### GET `/api/v1/me`

Who is calling, their roles and their Power BI connection

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Who is calling, their roles and their Power BI connection | Me |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `id` | text | yes |   |
| `kind` | one of "person", "service_account" | yes |   |
| `email` | text or null | yes |   |
| `name` | text or null | yes |   |
| `roles` | a list of text | yes |   |
| `sign_in_method` | text or null | yes |   |
| `via` | one of "browser", "mcp", "api", "cli" | yes |   |
| `powerbi_connection` | one of "connected", "needs_reconnect", "disconnected", "not_connected" or null | yes |   |
| `powerbi_connect_url` | text | yes |   |
| `sample_data` | true or false | yes |   |
| `usage` | an object with capture, retention_days | yes |   |
| `may_admin` | true or false | yes | Whether the admin section opens for the caller: the admin status page's own guard (admin:read_status). |
| `warnings` | a list of text | yes |   |
| `client_address` | text or null | yes | The address this request counted against for rate limits and audit, the caller's own. Null for a request made in process. |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### GET `/api/v1/me/connection`

The caller's Power BI connection: the account, when it was last used, and why it needs a reconnect

Who may call it: A signed-in person with no role on the data; a viewer; a curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The caller's Power BI connection: the account, when it was last used, and why it needs a reconnect | PowerBiConnection |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `status` | one of "connected", "needs_reconnect", "disconnected", "not_connected" | yes |   |
| `account` | text or null | yes |   |
| `connected_at` | text or null | yes |   |
| `last_used_at` | text or null | yes |   |
| `reason` | text or null | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### GET `/api/v1/me/grants`

The caller's MCP and CLI connections

Who may call it: A signed-in person with no role on the data; a viewer; a curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The caller's MCP and CLI connections | an object with grants |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `grants` | a list of Grant | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

### DELETE `/api/v1/me/grants/{id}`

End one of the caller's own connections

Who may call it: A signed-in person with no role on the data; a viewer; a curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | End one of the caller's own connections |   |

Other answers: 400 Validation Error; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

## metrics

### GET `/api/v1/metrics`

The metrics, A to Z, as small anchors

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `workspace` | query | text | no |   |
| `app` | query | text | no |   |
| `dataset` | query | text | no |   |
| `trust_states` | query | text | no |   |
| `category` | query | text | no |   |
| `not_filed` | query | text | no |   |
| `unit` | query | text | no |   |
| `cursor` | query | text | no |   |
| `limit` | query | text | no |   |
| `custom.KEY` | query | text | no | Filter on custom fields with query parameters of the form custom.KEY=VALUE, such as custom.owner_team=finance. At most 20. |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The metrics, A to Z, as small anchors | an object with items, next_cursor, total |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `items` | a list of an object | yes |   |
| `next_cursor` | text or null | yes |   |
| `total` | a number | no |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### POST `/api/v1/metrics`

Create a metric

Who may call it: A curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `label` | text | yes |   |
| `definition` | text | no |   |
| `aliases` | a list of text or null | no |   |
| `when_to_use` | text | no |   |
| `not_the_same_as` | text or null | no |   |
| `grain_and_filters` | text | no |   |
| `unit` | text or null | no |   |
| `category` | text or null | no |   |
| `owner` | text or null | no |   |
| `custom` | an object | no |   |
| `name` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 201 | Create a metric | Metric |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "metric" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `label` | text | yes |   |
| `icon` | text or null | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `when_to_use` | text | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `grain_and_filters` | text | yes |   |
| `unit` | text or null | yes |   |
| `category_id` | text or null | yes |   |
| `category` | Category or null | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `verified_by` | text or null | yes |   |
| `verified_by_name` | text or null | yes | The display name of whoever verified or approved it. Never an email. |
| `verified_at` | text (date-time) or null | yes |   |
| `origin` | one of "sync", "curator" | yes |   |
| `name_is_generated` | true or false | yes |   |
| `touched_at` | text (date-time) or null | yes |   |
| `dismissed_at` | text (date-time) or null | yes |   |
| `dismissed_reason` | text or null | yes |   |
| `created_at` | text (date-time) | yes |   |
| `updated_at` | text (date-time) | yes |   |
| `custom` | an object | yes |   |
| `failing_checks` | a list of an object | yes |   |
| `base_variants` | a list of an object | yes |   |
| `other_variants` | a list of an object | yes |   |
| `terms` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 409 It conflicts with the book as it is.

### GET `/api/v1/metrics/{name}`

One metric: its definition and the measure in each dataset

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | One metric: its definition and the measure in each dataset | Metric |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "metric" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `label` | text | yes |   |
| `icon` | text or null | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `when_to_use` | text | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `grain_and_filters` | text | yes |   |
| `unit` | text or null | yes |   |
| `category_id` | text or null | yes |   |
| `category` | Category or null | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `verified_by` | text or null | yes |   |
| `verified_by_name` | text or null | yes | The display name of whoever verified or approved it. Never an email. |
| `verified_at` | text (date-time) or null | yes |   |
| `origin` | one of "sync", "curator" | yes |   |
| `name_is_generated` | true or false | yes |   |
| `touched_at` | text (date-time) or null | yes |   |
| `dismissed_at` | text (date-time) or null | yes |   |
| `dismissed_reason` | text or null | yes |   |
| `created_at` | text (date-time) | yes |   |
| `updated_at` | text (date-time) | yes |   |
| `custom` | an object | yes |   |
| `failing_checks` | a list of an object | yes |   |
| `base_variants` | a list of an object | yes |   |
| `other_variants` | a list of an object | yes |   |
| `terms` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### PATCH `/api/v1/metrics/{name}`

Rename a metric (name), or change its fields

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

Body (JSON): an object with name or an object with label, definition, aliases, when_to_use, not_the_same_as, grain_and_filters, unit, category, owner, custom.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Rename a metric (name), or change its fields | Metric |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "metric" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `label` | text | yes |   |
| `icon` | text or null | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `when_to_use` | text | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `grain_and_filters` | text | yes |   |
| `unit` | text or null | yes |   |
| `category_id` | text or null | yes |   |
| `category` | Category or null | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `verified_by` | text or null | yes |   |
| `verified_by_name` | text or null | yes | The display name of whoever verified or approved it. Never an email. |
| `verified_at` | text (date-time) or null | yes |   |
| `origin` | one of "sync", "curator" | yes |   |
| `name_is_generated` | true or false | yes |   |
| `touched_at` | text (date-time) or null | yes |   |
| `dismissed_at` | text (date-time) or null | yes |   |
| `dismissed_reason` | text or null | yes |   |
| `created_at` | text (date-time) | yes |   |
| `updated_at` | text (date-time) | yes |   |
| `custom` | an object | yes |   |
| `failing_checks` | a list of an object | yes |   |
| `base_variants` | a list of an object | yes |   |
| `other_variants` | a list of an object | yes |   |
| `terms` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### DELETE `/api/v1/metrics/{name}`

Delete a metric with no variants

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Delete a metric with no variants |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### POST `/api/v1/metrics/{name}/merge`

Move the variants of `from` under this metric

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `from` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Move the variants of `from` under this metric | Metric |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "metric" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `label` | text | yes |   |
| `icon` | text or null | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `when_to_use` | text | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `grain_and_filters` | text | yes |   |
| `unit` | text or null | yes |   |
| `category_id` | text or null | yes |   |
| `category` | Category or null | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `verified_by` | text or null | yes |   |
| `verified_by_name` | text or null | yes | The display name of whoever verified or approved it. Never an email. |
| `verified_at` | text (date-time) or null | yes |   |
| `origin` | one of "sync", "curator" | yes |   |
| `name_is_generated` | true or false | yes |   |
| `touched_at` | text (date-time) or null | yes |   |
| `dismissed_at` | text (date-time) or null | yes |   |
| `dismissed_reason` | text or null | yes |   |
| `created_at` | text (date-time) | yes |   |
| `updated_at` | text (date-time) | yes |   |
| `custom` | an object | yes |   |
| `failing_checks` | a list of an object | yes |   |
| `base_variants` | a list of an object | yes |   |
| `other_variants` | a list of an object | yes |   |
| `terms` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### POST `/api/v1/metrics/{name}/verify`

Mark a metric agent_verified

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Mark a metric agent_verified | Metric |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "metric" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `label` | text | yes |   |
| `icon` | text or null | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `when_to_use` | text | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `grain_and_filters` | text | yes |   |
| `unit` | text or null | yes |   |
| `category_id` | text or null | yes |   |
| `category` | Category or null | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `verified_by` | text or null | yes |   |
| `verified_by_name` | text or null | yes | The display name of whoever verified or approved it. Never an email. |
| `verified_at` | text (date-time) or null | yes |   |
| `origin` | one of "sync", "curator" | yes |   |
| `name_is_generated` | true or false | yes |   |
| `touched_at` | text (date-time) or null | yes |   |
| `dismissed_at` | text (date-time) or null | yes |   |
| `dismissed_reason` | text or null | yes |   |
| `created_at` | text (date-time) | yes |   |
| `updated_at` | text (date-time) | yes |   |
| `custom` | an object | yes |   |
| `failing_checks` | a list of an object | yes |   |
| `base_variants` | a list of an object | yes |   |
| `other_variants` | a list of an object | yes |   |
| `terms` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### POST `/api/v1/metrics/{name}/dismiss`

Dismiss a draft

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `reason` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Dismiss a draft | Metric |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "metric" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `label` | text | yes |   |
| `icon` | text or null | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `when_to_use` | text | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `grain_and_filters` | text | yes |   |
| `unit` | text or null | yes |   |
| `category_id` | text or null | yes |   |
| `category` | Category or null | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `verified_by` | text or null | yes |   |
| `verified_by_name` | text or null | yes | The display name of whoever verified or approved it. Never an email. |
| `verified_at` | text (date-time) or null | yes |   |
| `origin` | one of "sync", "curator" | yes |   |
| `name_is_generated` | true or false | yes |   |
| `touched_at` | text (date-time) or null | yes |   |
| `dismissed_at` | text (date-time) or null | yes |   |
| `dismissed_reason` | text or null | yes |   |
| `created_at` | text (date-time) | yes |   |
| `updated_at` | text (date-time) | yes |   |
| `custom` | an object | yes |   |
| `failing_checks` | a list of an object | yes |   |
| `base_variants` | a list of an object | yes |   |
| `other_variants` | a list of an object | yes |   |
| `terms` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/metrics/{name}/checks`

Every check on a metric, passing and failing

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Every check on a metric, passing and failing | an object with checks |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `checks` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/metrics/{name}/history`

The changes made to a metric

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The changes made to a metric | a list of an object |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### POST `/api/v1/metrics/{name}/approve`

Approve a metric (human_verified)

Who may call it: A curator; an admin.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Approve a metric (human_verified) | Metric |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "metric" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `label` | text | yes |   |
| `icon` | text or null | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `when_to_use` | text | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `grain_and_filters` | text | yes |   |
| `unit` | text or null | yes |   |
| `category_id` | text or null | yes |   |
| `category` | Category or null | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `verified_by` | text or null | yes |   |
| `verified_by_name` | text or null | yes | The display name of whoever verified or approved it. Never an email. |
| `verified_at` | text (date-time) or null | yes |   |
| `origin` | one of "sync", "curator" | yes |   |
| `name_is_generated` | true or false | yes |   |
| `touched_at` | text (date-time) or null | yes |   |
| `dismissed_at` | text (date-time) or null | yes |   |
| `dismissed_reason` | text or null | yes |   |
| `created_at` | text (date-time) | yes |   |
| `updated_at` | text (date-time) | yes |   |
| `custom` | an object | yes |   |
| `failing_checks` | a list of an object | yes |   |
| `base_variants` | a list of an object | yes |   |
| `other_variants` | a list of an object | yes |   |
| `terms` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/metrics/{name}/variants`

A metric's variants, with their shifts and no DAX

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |
| `dataset` | query | text | no |   |
| `workspace` | query | text | no |   |
| `period` | query | text | no |   |
| `comparison` | query | one of "none", "difference", "growth_rate", "ratio" | no |   |
| `currency` | query | text | no |   |
| `cursor` | query | text | no |   |
| `limit` | query | a whole number, at least 1 and at most 500 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | A metric's variants, with their shifts and no DAX | an object with items, next_cursor |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `items` | a list of an object | yes |   |
| `next_cursor` | text or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

## oauth

### GET `/api/v1/oauth/consent`

What an MCP client asks to be allowed, from the signed query Better Auth sent

Who may call it: Any signed-in person, in a browser only.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | What an MCP client asks to be allowed, from the signed query Better Auth sent | ConsentRequest |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `person` | an object with email, name | yes |   |
| `client` | an object with id, vouched_host, claimed_name, registered_at, registered_by | yes |   |
| `redirect` | an object with scheme, host, private_use or null | yes |   |
| `scopes` | a list of text | yes |   |
| `will` | a list of text | yes |   |
| `will_not` | a list of text | yes |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### POST `/api/v1/oauth/consent`

Allow or deny an MCP client; answers where the browser goes next

Who may call it: Any signed-in person, in a browser only.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `request` | text | yes |   |
| `allow` | true or false | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Allow or deny an MCP client; answers where the browser goes next | an object with redirect_to |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `redirect_to` | text | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/oauth/device`

What the CLI asks to be allowed, for the code a person typed

Who may call it: Any signed-in person, in a browser only.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `user_code` | query | text | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | What the CLI asks to be allowed, for the code a person typed | DeviceRequest |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `person` | an object with email, name | yes |   |
| `user_code` | text | yes |   |
| `client_id` | text | yes |   |
| `client_name` | text | yes |   |
| `started_at` | text | yes |   |
| `started_from` | text or null | yes |   |
| `will` | a list of text | yes |   |
| `will_not` | a list of text | yes |   |

Other answers: 400 Validation Error; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### POST `/api/v1/oauth/device`

Allow or deny the CLI's device code

Who may call it: Any signed-in person, in a browser only.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `user_code` | text | yes |   |
| `allow` | true or false | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Allow or deny the CLI's device code |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

## powerbi

### GET `/api/v1/powerbi/connect`

Start the Power BI connection: on to Microsoft's sign-in

Who may call it: Any signed-in person, in a browser only.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `next` | query | text | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |

Other answers: 302 Start the Power BI connection: on to Microsoft's sign-in; 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 502 Power BI or another service the request needs failed.

### GET `/api/v1/powerbi/callback`

Finish the Power BI connection: back to the page it began from

Who may call it: Any signed-in person, in a browser only.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `state` | query | text | no |   |
| `code` | query | text | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |

Other answers: 302 Finish the Power BI connection: back to the page it began from; 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 502 Power BI or another service the request needs failed.

### DELETE `/api/v1/powerbi/connection`

Disconnect the caller's Power BI connection

Who may call it: A signed-in person with no role on the data; a viewer; a curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Disconnect the caller's Power BI connection |   |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.

## queries

### GET `/api/v1/queries`

Search the query log, newest first

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `text` | query | text | no |   |
| `dataset` | query | text | no |   |
| `workspace` | query | text | no |   |
| `metric` | query | text | no |   |
| `principal` | query | text | no |   |
| `mine` | query | one of "true", "false" | no |   |
| `status` | query | one of "succeeded", "truncated", "failed", "refused" | no |   |
| `since` | query | text (date-time) | no |   |
| `until` | query | text (date-time) | no |   |
| `cursor` | query | text | no |   |
| `limit` | query | a whole number, at least 1 and at most 100 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Search the query log, newest first | an object with items, next_cursor |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `items` | a list of Entry | yes |   |
| `next_cursor` | text or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### POST `/api/v1/queries`

Run DAX on a dataset as the caller; answers a preview and the result's anchor

Who may call it: A viewer; a curator; an admin; a curator signed in with `pbmb login`.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `dataset` | text | yes |   |
| `dax` | text | yes |   |
| `purpose` | text or null | no |   |
| `preview_rows` | a whole number, at least 0 and at most 100 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 201 | Run DAX on a dataset as the caller; answers a preview and the result's anchor | Anchor |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `result_id` | text | yes |   |
| `query_id` | text | yes |   |
| `dataset` | an object with id, name | yes |   |
| `columns` | a list of an object | yes |   |
| `row_count` | a number | yes |   |
| `bytes` | a number | yes |   |
| `truncated` | true or false | yes |   |
| `truncation_note` | text or null | yes |   |
| `preview` | a list of a list of any value | yes |   |
| `preview_note` | text or null | yes |   |
| `next_offset` | a number or null | yes |   |
| `csv_url` | text | yes |   |
| `csv_url_expires_at` | text (date-time) | yes |   |
| `expires_at` | text (date-time) | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is; 429 Too many requests; 502 Power BI or another service the request needs failed.

### GET `/api/v1/queries/{id}`

One query with its whole DAX and purpose

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | One query with its whole DAX and purpose | Entry |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `kind` | "query" | yes |   |
| `id` | text | yes |   |
| `at` | text (date-time) | yes |   |
| `principal` | an object with kind, id | yes |   |
| `via` | one of "browser", "mcp", "api", "cli" | yes |   |
| `client_id` | text or null | yes |   |
| `dataset` | an object with kind, id, name or null | yes |   |
| `workspace_id` | text or null | yes |   |
| `status` | one of "succeeded", "truncated", "failed", "refused" | yes |   |
| `dax` | text | yes |   |
| `dax_cut` | true or false | yes |   |
| `purpose` | text or null | yes |   |
| `purpose_cut` | true or false | yes |   |
| `error` | text or null | yes |   |
| `row_count` | a number or null | yes |   |
| `column_count` | a number or null | yes |   |
| `duration_ms` | a number | yes |   |
| `result_id` | text or null | yes |   |
| `measure_names` | a list of text | yes |   |
| `metric_ids` | a list of text | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

## requests

### GET `/api/v1/requests`

List the requests the caller may read, newest first

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `mine` | query | one of "true", "false" | no |   |
| `outcome` | query | one of "answered", "partly_answered", "not_answered" | no |   |
| `gap` | query | one of "no_metric", "unclear_metric", "wrong_definition", "missing_description", "missing_dimension", "no_access", "data_wrong", "other" | no |   |
| `since` | query | text (date-time) | no |   |
| `text` | query | text | no |   |
| `cursor` | query | text | no |   |
| `limit` | query | a whole number, at least 1 and at most 100 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | List the requests the caller may read, newest first | an object with items, next_cursor |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `items` | a list of Request | yes |   |
| `next_cursor` | text or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### POST `/api/v1/requests`

Record a question a person asked, its outcome and what was missing

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `question` | text | yes |   |
| `outcome` | one of "answered", "partly_answered", "not_answered" | yes |   |
| `gaps` | a list of one of "no_metric", "unclear_metric", "wrong_definition", "missing_description", "missing_dimension", "no_access", "data_wrong", "other" | no |   |
| `missing` | text | no |   |
| `elements` | a list of an object | no |   |
| `query_ids` | a list of text | no |   |
| `search_ids` | a list of text | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 201 | Record a question a person asked, its outcome and what was missing | RecordedRequest |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 429 Too many requests.

### GET `/api/v1/requests/{id}`

One request, with the queries and searches it links that the caller may read

Who may call it: A curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | One request, with the queries and searches it links that the caller may read | RequestDetail |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `id` | text | yes |   |
| `at` | text (date-time) | yes |   |
| `principal` | an object with kind, id | yes |   |
| `via` | one of "browser", "mcp", "api", "cli" | yes |   |
| `question` | text | yes |   |
| `outcome` | one of "answered", "partly_answered", "not_answered" | yes |   |
| `gaps` | a list of one of "no_metric", "unclear_metric", "wrong_definition", "missing_description", "missing_dimension", "no_access", "data_wrong", "other" | yes |   |
| `missing` | text or null | yes |   |
| `elements` | a list of an object | yes |   |
| `query_ids` | a list of text | yes |   |
| `search_ids` | a list of text | yes |   |
| `queries` | a list of an object | yes |   |
| `searches` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### DELETE `/api/v1/requests/{id}`

Delete a request: your own, or any as an admin

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Delete a request: your own, or any as an admin |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

## results

### GET `/api/v1/results/{id}`

A page of a result, for its owner

Who may call it: A curator; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |
| `offset` | query | a whole number, at least 0 and at most 1000000 | no |   |
| `limit` | query | a whole number, at least 0 and at most 100000 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | A page of a result, for its owner | ResultPage |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `result_id` | text | yes |   |
| `query_id` | text | yes |   |
| `columns` | a list of an object | yes |   |
| `row_count` | a number | yes |   |
| `offset` | a number | yes |   |
| `rows` | a list of a list of any value | yes |   |
| `next_offset` | a number or null | yes |   |
| `note` | text or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### POST `/api/v1/results/{id}/csv-link`

A fresh signed link to a result's CSV, for its owner

Who may call it: A curator; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | A fresh signed link to a result's CSV, for its owner | Link |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `csv_url` | text | yes |   |
| `csv_url_expires_at` | text (date-time) | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/results/{id}/csv`

A result as CSV, with a signed link (expires, signature) or the owner's own credential

Who may call it: Public: no credential is needed. Also allowed: a curator; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |
| `expires` | query | text | no |   |
| `signature` | query | text | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | RFC 4180 CSV, UTF-8, with a header row. |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 429 Too many requests.

## search

### GET `/api/v1/search`

Search the book by meaning and by words, among what the caller may describe

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `query` | query | text | no |   |
| `kinds` | query | text | no |   |
| `workspace` | query | text | no |   |
| `app` | query | text | no |   |
| `dataset` | query | text | no |   |
| `trust_states` | query | text | no |   |
| `category` | query | text | no |   |
| `unit` | query | text | no |   |
| `limit` | query | text | no |   |
| `custom.KEY` | query | text | no | Filter on custom fields with query parameters of the form custom.KEY=VALUE, such as custom.owner_team=finance. At most 16. |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Search the book by meaning and by words, among what the caller may describe | an object with items, counts, search_id, search_mode, note |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `items` | a list of an object | yes |   |
| `counts` | an object | yes |   |
| `search_id` | text or null | yes |   |
| `search_mode` | one of "hybrid", "words_only" | yes |   |
| `note` | text or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 429 Too many requests.

## setup

### POST `/api/setup/session`

Spend a setup link's token and open the setup session

Who may call it: Nobody once an admin exists: it answers 404. Before the first admin, only the holder of the setup link.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `token` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Spend a setup link's token and open the setup session |   |

Other answers: 400 The request is not valid; 404 There is no setup here for this caller; 429 Too many setup requests.

### GET `/api/setup`

The setup steps and where each stands

Who may call it: An admin.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The setup steps and where each stands | an object with holder, steps, completed_at, failure_docs_path |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `holder` | one of "admin", "setup_link" | yes |   |
| `steps` | a list of an object | yes |   |
| `completed_at` | text or null | yes |   |
| `failure_docs_path` | text | yes |   |

Other answers: 404 There is no setup here for this caller; 429 Too many setup requests.

### POST `/api/setup/tenant`

Find the tenant ID from a work email

Who may call it: An admin.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `email` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Find the tenant ID from a work email | an object with tenant_id, domain |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `tenant_id` | a GUID | yes |   |
| `domain` | text | yes |   |

Other answers: 400 The request is not valid; 404 There is no setup here for this caller, or Microsoft knows no tenant for the domain. The message distinguishes these cases; 429 Too many setup requests.

### POST `/api/setup/steps/address`

Run the Address step

Who may call it: An admin.

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `confirm_email` | text | no |   |
| `start_sync` | true | no |   |
| `start_check` | true | no |   |
| `credentials_only` | true | no |   |
| `settings` | an object | no |   |
| `secrets` | an object | no |   |
| `assignments` | a list of an object or an object or an object | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Run the Address step | an object with step, status, message, confirm, action, details, pending, next |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `step` | text | yes |   |
| `status` | one of "passing", "failing" | yes |   |
| `message` | text or null | yes |   |
| `confirm` | an object with email, name | no |   |
| `action` | one of "sign_in", "connect" | no |   |
| `details` | an object with reason or an object with workspaces, truncated, personal_count or an object with public_base_url, cookies_secure or an object with providers or an object with default_role, assignments or an object with provider or an object with provider, model, documents, estimated_tokens, cost_micro_usd or an object with mcp_url, cli_install, cli_login or an object with measures, datasets, drafts or an object with items | no |   |
| `pending` | true | no |   |
| `next` | an object with method, path, body or null | yes |   |

Other answers: 400 The request is not valid; 404 There is no setup here for this caller; 429 Too many setup requests.

### POST `/api/setup/steps/app_registration`

Run the The app registration step

Who may call it: An admin.

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `confirm_email` | text | no |   |
| `start_sync` | true | no |   |
| `start_check` | true | no |   |
| `credentials_only` | true | no |   |
| `settings` | an object | no |   |
| `secrets` | an object | no |   |
| `assignments` | a list of an object or an object or an object | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Run the The app registration step | an object with step, status, message, confirm, action, details, pending, next |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `step` | text | yes |   |
| `status` | one of "passing", "failing" | yes |   |
| `message` | text or null | yes |   |
| `confirm` | an object with email, name | no |   |
| `action` | one of "sign_in", "connect" | no |   |
| `details` | an object with reason or an object with workspaces, truncated, personal_count or an object with public_base_url, cookies_secure or an object with providers or an object with default_role, assignments or an object with provider or an object with provider, model, documents, estimated_tokens, cost_micro_usd or an object with mcp_url, cli_install, cli_login or an object with measures, datasets, drafts or an object with items | no |   |
| `pending` | true | no |   |
| `next` | an object with method, path, body or null | yes |   |

Other answers: 400 The request is not valid; 404 There is no setup here for this caller; 429 Too many setup requests.

### POST `/api/setup/steps/scanner`

Run the The scanner step

Who may call it: An admin.

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `confirm_email` | text | no |   |
| `start_sync` | true | no |   |
| `start_check` | true | no |   |
| `credentials_only` | true | no |   |
| `settings` | an object | no |   |
| `secrets` | an object | no |   |
| `assignments` | a list of an object or an object or an object | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Run the The scanner step | an object with step, status, message, confirm, action, details, pending, next |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `step` | text | yes |   |
| `status` | one of "passing", "failing" | yes |   |
| `message` | text or null | yes |   |
| `confirm` | an object with email, name | no |   |
| `action` | one of "sign_in", "connect" | no |   |
| `details` | an object with reason or an object with workspaces, truncated, personal_count or an object with public_base_url, cookies_secure or an object with providers or an object with default_role, assignments or an object with provider or an object with provider, model, documents, estimated_tokens, cost_micro_usd or an object with mcp_url, cli_install, cli_login or an object with measures, datasets, drafts or an object with items | no |   |
| `pending` | true | no |   |
| `next` | an object with method, path, body or null | yes |   |

Other answers: 400 The request is not valid; 404 There is no setup here for this caller; 429 Too many setup requests.

### POST `/api/setup/steps/what_to_sync`

Run the What to sync step

Who may call it: An admin.

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `confirm_email` | text | no |   |
| `start_sync` | true | no |   |
| `start_check` | true | no |   |
| `credentials_only` | true | no |   |
| `settings` | an object | no |   |
| `secrets` | an object | no |   |
| `assignments` | a list of an object or an object or an object | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Run the What to sync step | an object with step, status, message, confirm, action, details, pending, next |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `step` | text | yes |   |
| `status` | one of "passing", "failing" | yes |   |
| `message` | text or null | yes |   |
| `confirm` | an object with email, name | no |   |
| `action` | one of "sign_in", "connect" | no |   |
| `details` | an object with reason or an object with workspaces, truncated, personal_count or an object with public_base_url, cookies_secure or an object with providers or an object with default_role, assignments or an object with provider or an object with provider, model, documents, estimated_tokens, cost_micro_usd or an object with mcp_url, cli_install, cli_login or an object with measures, datasets, drafts or an object with items | no |   |
| `pending` | true | no |   |
| `next` | an object with method, path, body or null | yes |   |

Other answers: 400 The request is not valid; 404 There is no setup here for this caller; 429 Too many setup requests.

### POST `/api/setup/steps/sign_in`

Run the Sign-in step

Who may call it: An admin.

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `confirm_email` | text | no |   |
| `start_sync` | true | no |   |
| `start_check` | true | no |   |
| `credentials_only` | true | no |   |
| `settings` | an object | no |   |
| `secrets` | an object | no |   |
| `assignments` | a list of an object or an object or an object | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Run the Sign-in step | an object with step, status, message, confirm, action, details, pending, next |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `step` | text | yes |   |
| `status` | one of "passing", "failing" | yes |   |
| `message` | text or null | yes |   |
| `confirm` | an object with email, name | no |   |
| `action` | one of "sign_in", "connect" | no |   |
| `details` | an object with reason or an object with workspaces, truncated, personal_count or an object with public_base_url, cookies_secure or an object with providers or an object with default_role, assignments or an object with provider or an object with provider, model, documents, estimated_tokens, cost_micro_usd or an object with mcp_url, cli_install, cli_login or an object with measures, datasets, drafts or an object with items | no |   |
| `pending` | true | no |   |
| `next` | an object with method, path, body or null | yes |   |

Other answers: 400 The request is not valid; 404 There is no setup here for this caller; 429 Too many setup requests.

### POST `/api/setup/steps/who_gets_in`

Run the Who gets in step

Who may call it: An admin.

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `confirm_email` | text | no |   |
| `start_sync` | true | no |   |
| `start_check` | true | no |   |
| `credentials_only` | true | no |   |
| `settings` | an object | no |   |
| `secrets` | an object | no |   |
| `assignments` | a list of an object or an object or an object | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Run the Who gets in step | an object with step, status, message, confirm, action, details, pending, next |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `step` | text | yes |   |
| `status` | one of "passing", "failing" | yes |   |
| `message` | text or null | yes |   |
| `confirm` | an object with email, name | no |   |
| `action` | one of "sign_in", "connect" | no |   |
| `details` | an object with reason or an object with workspaces, truncated, personal_count or an object with public_base_url, cookies_secure or an object with providers or an object with default_role, assignments or an object with provider or an object with provider, model, documents, estimated_tokens, cost_micro_usd or an object with mcp_url, cli_install, cli_login or an object with measures, datasets, drafts or an object with items | no |   |
| `pending` | true | no |   |
| `next` | an object with method, path, body or null | yes |   |

Other answers: 400 The request is not valid; 404 There is no setup here for this caller; 429 Too many setup requests.

### POST `/api/setup/steps/search`

Run the Search step

Who may call it: An admin.

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `confirm_email` | text | no |   |
| `start_sync` | true | no |   |
| `start_check` | true | no |   |
| `credentials_only` | true | no |   |
| `settings` | an object | no |   |
| `secrets` | an object | no |   |
| `assignments` | a list of an object or an object or an object | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Run the Search step | an object with step, status, message, confirm, action, details, pending, next |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `step` | text | yes |   |
| `status` | one of "passing", "failing" | yes |   |
| `message` | text or null | yes |   |
| `confirm` | an object with email, name | no |   |
| `action` | one of "sign_in", "connect" | no |   |
| `details` | an object with reason or an object with workspaces, truncated, personal_count or an object with public_base_url, cookies_secure or an object with providers or an object with default_role, assignments or an object with provider or an object with provider, model, documents, estimated_tokens, cost_micro_usd or an object with mcp_url, cli_install, cli_login or an object with measures, datasets, drafts or an object with items | no |   |
| `pending` | true | no |   |
| `next` | an object with method, path, body or null | yes |   |

Other answers: 400 The request is not valid; 404 There is no setup here for this caller; 429 Too many setup requests.

### POST `/api/setup/steps/agents`

Run the Agents step

Who may call it: An admin.

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `confirm_email` | text | no |   |
| `start_sync` | true | no |   |
| `start_check` | true | no |   |
| `credentials_only` | true | no |   |
| `settings` | an object | no |   |
| `secrets` | an object | no |   |
| `assignments` | a list of an object or an object or an object | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Run the Agents step | an object with step, status, message, confirm, action, details, pending, next |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `step` | text | yes |   |
| `status` | one of "passing", "failing" | yes |   |
| `message` | text or null | yes |   |
| `confirm` | an object with email, name | no |   |
| `action` | one of "sign_in", "connect" | no |   |
| `details` | an object with reason or an object with workspaces, truncated, personal_count or an object with public_base_url, cookies_secure or an object with providers or an object with default_role, assignments or an object with provider or an object with provider, model, documents, estimated_tokens, cost_micro_usd or an object with mcp_url, cli_install, cli_login or an object with measures, datasets, drafts or an object with items | no |   |
| `pending` | true | no |   |
| `next` | an object with method, path, body or null | yes |   |

Other answers: 400 The request is not valid; 404 There is no setup here for this caller; 429 Too many setup requests.

### POST `/api/setup/steps/first_sync`

Run the First sync step

Who may call it: An admin.

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `confirm_email` | text | no |   |
| `start_sync` | true | no |   |
| `start_check` | true | no |   |
| `credentials_only` | true | no |   |
| `settings` | an object | no |   |
| `secrets` | an object | no |   |
| `assignments` | a list of an object or an object or an object | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Run the First sync step | an object with step, status, message, confirm, action, details, pending, next |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `step` | text | yes |   |
| `status` | one of "passing", "failing" | yes |   |
| `message` | text or null | yes |   |
| `confirm` | an object with email, name | no |   |
| `action` | one of "sign_in", "connect" | no |   |
| `details` | an object with reason or an object with workspaces, truncated, personal_count or an object with public_base_url, cookies_secure or an object with providers or an object with default_role, assignments or an object with provider or an object with provider, model, documents, estimated_tokens, cost_micro_usd or an object with mcp_url, cli_install, cli_login or an object with measures, datasets, drafts or an object with items | no |   |
| `pending` | true | no |   |
| `next` | an object with method, path, body or null | yes |   |

Other answers: 400 The request is not valid; 404 There is no setup here for this caller; 429 Too many setup requests.

### POST `/api/setup/steps/security`

Run the Security step

Who may call it: An admin.

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `confirm_email` | text | no |   |
| `start_sync` | true | no |   |
| `start_check` | true | no |   |
| `credentials_only` | true | no |   |
| `settings` | an object | no |   |
| `secrets` | an object | no |   |
| `assignments` | a list of an object or an object or an object | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Run the Security step | an object with step, status, message, confirm, action, details, pending, next |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `step` | text | yes |   |
| `status` | one of "passing", "failing" | yes |   |
| `message` | text or null | yes |   |
| `confirm` | an object with email, name | no |   |
| `action` | one of "sign_in", "connect" | no |   |
| `details` | an object with reason or an object with workspaces, truncated, personal_count or an object with public_base_url, cookies_secure or an object with providers or an object with default_role, assignments or an object with provider or an object with provider, model, documents, estimated_tokens, cost_micro_usd or an object with mcp_url, cli_install, cli_login or an object with measures, datasets, drafts or an object with items | no |   |
| `pending` | true | no |   |
| `next` | an object with method, path, body or null | yes |   |

Other answers: 400 The request is not valid; 404 There is no setup here for this caller; 429 Too many setup requests.

## terms

### GET `/api/v1/terms/{name}`

One term: its definition, values, backing columns and related metrics

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | One term: its definition, values, backing columns and related metrics | Term |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "term" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `icon` | text or null | yes |   |
| `type` | one of "dimension", "concept" | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `values` | any value | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `custom` | an object | yes |   |
| `columns` | a list of an object | yes |   |
| `metrics` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### POST `/api/v1/terms/{name}`

Create a term

Who may call it: A curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `definition` | text | no |   |
| `aliases` | a list of text or null | no |   |
| `not_the_same_as` | text or null | no |   |
| `values` | a list of text or an object or null | no |   |
| `owner` | text or null | no |   |
| `custom` | an object | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 201 | Create a term | Term |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "term" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `icon` | text or null | yes |   |
| `type` | one of "dimension", "concept" | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `values` | any value | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `custom` | an object | yes |   |
| `columns` | a list of an object | yes |   |
| `metrics` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 409 It conflicts with the book as it is.

### PATCH `/api/v1/terms/{name}`

Change a term, renaming it when name is sent

Who may call it: A curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `definition` | text | no |   |
| `aliases` | a list of text or null | no |   |
| `not_the_same_as` | text or null | no |   |
| `values` | a list of text or an object or null | no |   |
| `owner` | text or null | no |   |
| `custom` | an object | no |   |
| `name` | text | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Change a term, renaming it when name is sent | Term |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "term" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `icon` | text or null | yes |   |
| `type` | one of "dimension", "concept" | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `values` | any value | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `custom` | an object | yes |   |
| `columns` | a list of an object | yes |   |
| `metrics` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### DELETE `/api/v1/terms/{name}`

Delete a term

Who may call it: A curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 204 | Delete a term |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### PUT `/api/v1/terms/{name}/columns/{column_id}`

Link a column to a term

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |
| `column_id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Link a column to a term | Term |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "term" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `icon` | text or null | yes |   |
| `type` | one of "dimension", "concept" | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `values` | any value | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `custom` | an object | yes |   |
| `columns` | a list of an object | yes |   |
| `metrics` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### DELETE `/api/v1/terms/{name}/columns/{column_id}`

Unlink a column from a term

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |
| `column_id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Unlink a column from a term | Term |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "term" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `icon` | text or null | yes |   |
| `type` | one of "dimension", "concept" | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `values` | any value | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `custom` | an object | yes |   |
| `columns` | a list of an object | yes |   |
| `metrics` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### PUT `/api/v1/terms/{name}/metrics/{metric}`

Relate a term to a metric

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |
| `metric` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Relate a term to a metric | Term |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "term" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `icon` | text or null | yes |   |
| `type` | one of "dimension", "concept" | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `values` | any value | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `custom` | an object | yes |   |
| `columns` | a list of an object | yes |   |
| `metrics` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### DELETE `/api/v1/terms/{name}/metrics/{metric}`

Unrelate a term from a metric

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `name` | path | text | yes |   |
| `metric` | path | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Unrelate a term from a metric | Term |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `open_questions` | a number | yes |   |
| `accepted_answers` | a list of an object | yes |   |
| `kind` | "term" | yes |   |
| `id` | text | yes |   |
| `name` | text | yes |   |
| `icon` | text or null | yes |   |
| `type` | one of "dimension", "concept" | yes |   |
| `definition` | text | yes |   |
| `aliases` | a list of text or null | yes |   |
| `not_the_same_as` | text or null | yes |   |
| `values` | any value | yes |   |
| `owner` | text or null | yes |   |
| `trust_state` | one of "draft", "agent_verified", "human_verified" | yes |   |
| `custom` | an object | yes |   |
| `columns` | a list of an object | yes |   |
| `metrics` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/terms`

The glossary terms, A to Z, as small anchors

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `workspace` | query | text | no |   |
| `app` | query | text | no |   |
| `dataset` | query | text | no |   |
| `trust_states` | query | text | no |   |
| `cursor` | query | text | no |   |
| `limit` | query | text | no |   |
| `custom.KEY` | query | text | no | Filter on custom fields with query parameters of the form custom.KEY=VALUE, such as custom.owner_team=finance. At most 20. |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The glossary terms, A to Z, as small anchors | an object with items, next_cursor |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `items` | a list of an object | yes |   |
| `next_cursor` | text or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

## threads

### GET `/api/v1/threads`

Threads the caller may see

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `element_kind` | query | one of "workspace", "dataset", "table", "column", "measure", "metric", "variant", "term", "category", "query" | no |   |
| `element_id` | query | a GUID | no |   |
| `kind` | query | one of "question", "comment" | no |   |
| `status` | query | one of "open", "answered", "archived" | no |   |
| `mine` | query | one of "true", "false" | no |   |
| `text` | query | text | no |   |
| `cursor` | query | text | no |   |
| `limit` | query | a whole number, at least 1 and at most 100 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Threads the caller may see | an object with items, next_cursor |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `items` | a list of an object | yes |   |
| `next_cursor` | text or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it.

### POST `/api/v1/threads`

Ask a question or comment

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `kind` | one of "question", "comment" | yes |   |
| `element` | an object with kind, id | yes |   |
| `title` | text or null | no |   |
| `body` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 201 | Ask a question or comment | Thread |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `id` | text | yes |   |
| `kind` | one of "question", "comment" | yes |   |
| `title` | text or null | yes |   |
| `body` | text | yes |   |
| `status` | one of "open", "answered", "archived" | yes |   |
| `accepted_reply_id` | text or null | yes |   |
| `accepted_by_role` | one of "asker", "asker_own_reply", "curator", "other", "unknown" or null | yes | Who accepted: the asker, the asker on their own reply, a curator, or someone else a policy allows. |
| `accepted_by_kind` | one of "person", "service_account" or null | yes | A person, or a service_account (an agent). |
| `accepted_by_via` | one of "browser", "mcp", "api", "cli" or null | yes | Where it was accepted from: browser, mcp (an agent), api or cli. |
| `created_at` | text (date-time) | yes |   |
| `updated_at` | text (date-time) | yes |   |
| `reply_count` | a number | yes |   |
| `unread_replies` | a number | yes |   |
| `upvote_count` | a number | yes |   |
| `upvoted` | true or false | yes |   |
| `element` | an object with kind, id | yes |   |
| `author` | an object with kind, id | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### GET `/api/v1/threads/{id}`

A thread with its replies

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | A thread with its replies | an object with id, kind, title, body, status, accepted_reply_id, accepted_by_role, accepted_by_kind, accepted_by_via, created_at, updated_at, reply_count, unread_replies, upvote_count, upvoted, element, author, replies |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `id` | text | yes |   |
| `kind` | one of "question", "comment" | yes |   |
| `title` | text or null | yes |   |
| `body` | text | yes |   |
| `status` | one of "open", "answered", "archived" | yes |   |
| `accepted_reply_id` | text or null | yes |   |
| `accepted_by_role` | one of "asker", "asker_own_reply", "curator", "other", "unknown" or null | yes | Who accepted: the asker, the asker on their own reply, a curator, or someone else a policy allows. |
| `accepted_by_kind` | one of "person", "service_account" or null | yes | A person, or a service_account (an agent). |
| `accepted_by_via` | one of "browser", "mcp", "api", "cli" or null | yes | Where it was accepted from: browser, mcp (an agent), api or cli. |
| `created_at` | text (date-time) | yes |   |
| `updated_at` | text (date-time) | yes |   |
| `reply_count` | a number | yes |   |
| `unread_replies` | a number | yes |   |
| `upvote_count` | a number | yes |   |
| `upvoted` | true or false | yes |   |
| `element` | an object with kind, id | yes |   |
| `author` | an object with kind, id | yes |   |
| `replies` | a list of an object | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### POST `/api/v1/threads/{id}/replies`

Reply to a thread

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `body` | text | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 201 | Reply to a thread | Reply |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `id` | text | yes |   |
| `thread_id` | text | yes |   |
| `author` | an object with kind, id | yes |   |
| `body` | text | yes |   |
| `created_at` | text (date-time) | yes |   |
| `edited_at` | text (date-time) or null | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### PUT `/api/v1/threads/{id}/upvote`

Upvote a question

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Upvote a question | an object with thread_id, upvoted, upvote_count |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `thread_id` | text | yes |   |
| `upvoted` | true or false | yes |   |
| `upvote_count` | a number | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### DELETE `/api/v1/threads/{id}/upvote`

Take back an upvote

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Take back an upvote | an object with thread_id, upvoted, upvote_count |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `thread_id` | text | yes |   |
| `upvoted` | true or false | yes |   |
| `upvote_count` | a number | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### POST `/api/v1/threads/{id}/accept`

Accept a reply as the answer

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

Body (JSON, required):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `reply_id` | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Accept a reply as the answer | Thread |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `id` | text | yes |   |
| `kind` | one of "question", "comment" | yes |   |
| `title` | text or null | yes |   |
| `body` | text | yes |   |
| `status` | one of "open", "answered", "archived" | yes |   |
| `accepted_reply_id` | text or null | yes |   |
| `accepted_by_role` | one of "asker", "asker_own_reply", "curator", "other", "unknown" or null | yes | Who accepted: the asker, the asker on their own reply, a curator, or someone else a policy allows. |
| `accepted_by_kind` | one of "person", "service_account" or null | yes | A person, or a service_account (an agent). |
| `accepted_by_via` | one of "browser", "mcp", "api", "cli" or null | yes | Where it was accepted from: browser, mcp (an agent), api or cli. |
| `created_at` | text (date-time) | yes |   |
| `updated_at` | text (date-time) | yes |   |
| `reply_count` | a number | yes |   |
| `unread_replies` | a number | yes |   |
| `upvote_count` | a number | yes |   |
| `upvoted` | true or false | yes |   |
| `element` | an object with kind, id | yes |   |
| `author` | an object with kind, id | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

### POST `/api/v1/threads/{id}/archive`

Archive a thread

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Archive a thread | Thread |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `id` | text | yes |   |
| `kind` | one of "question", "comment" | yes |   |
| `title` | text or null | yes |   |
| `body` | text | yes |   |
| `status` | one of "open", "answered", "archived" | yes |   |
| `accepted_reply_id` | text or null | yes |   |
| `accepted_by_role` | one of "asker", "asker_own_reply", "curator", "other", "unknown" or null | yes | Who accepted: the asker, the asker on their own reply, a curator, or someone else a policy allows. |
| `accepted_by_kind` | one of "person", "service_account" or null | yes | A person, or a service_account (an agent). |
| `accepted_by_via` | one of "browser", "mcp", "api", "cli" or null | yes | Where it was accepted from: browser, mcp (an agent), api or cli. |
| `created_at` | text (date-time) | yes |   |
| `updated_at` | text (date-time) | yes |   |
| `reply_count` | a number | yes |   |
| `unread_replies` | a number | yes |   |
| `upvote_count` | a number | yes |   |
| `upvoted` | true or false | yes |   |
| `element` | an object with kind, id | yes |   |
| `author` | an object with kind, id | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

## usage

### GET `/api/v1/usage/report`

Report gaps in coverage and structure, for curators and admins

Who may call it: A curator; an admin; a curator outside the data's audience; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `since` | query | text (date-time) | yes |   |
| `until` | query | text (date-time) | no |   |
| `dataset` | query | text | no |   |
| `limit` | query | a whole number, at least 1 and at most 100 | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Report gaps in coverage and structure, for curators and admins | UsageReport |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `since` | text (date-time) | yes |   |
| `until` | text (date-time) | yes |   |
| `totals` | an object with searches, searches_with_no_hits, requests, requests_by_outcome, queries, queries_without_metric | yes |   |
| `not_covered` | an object with searches_with_no_hits, searches_without_metric, unanswered_requests, queries_without_metric | yes |   |
| `badly_structured` | an object with measures_without_metric, measures_without_description, flagged_elements, used_unverified_metrics, failed_queries | yes |   |
| `hidden` | a number | yes |   |
| `truncated_lists` | a list of text | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

## variants

### GET `/api/v1/variants/{id}`

One variant in full, with its DAX

Who may call it: A viewer; a curator; an admin; a service account with a grant; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | One variant in full, with its DAX | Variant |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `kind` | "variant" | yes |   |
| `id` | text | yes |   |
| `metric` | an object with kind, id, name, label | yes |   |
| `table` | Table | yes |   |
| `dataset` | Dataset | yes |   |
| `workspace` | Workspace | yes |   |
| `measure` | Measure | yes |   |
| `measure_reference` | text | yes |   |
| `reads_selection` | true or false | yes |   |
| `selection_columns` | a list of text | yes |   |
| `expression` | text or null | yes |   |
| `normalized_expression` | text or null | yes |   |
| `format_string` | text or null | yes |   |
| `display_folder` | text or null | yes |   |
| `description` | text or null | yes |   |
| `description_pbi` | text or null | yes |   |
| `assigned_by` | one of "sync", "curator" | yes |   |
| `assigned_at` | text (date-time) | yes |   |
| `removed` | true or false | yes |   |
| `shift` | an object with period, comparison, comparison_period, currency, custom_axes, shift_note | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see.

### PATCH `/api/v1/variants/{id}`

Move a variant to another metric, or change its shift

Who may call it: A curator; an admin; a curator signed in with `pbmb login`.

| Parameter | In | Accepts | Required | What |
| --- | --- | --- | --- | --- |
| `id` | path | a GUID | yes |   |

Body (JSON, optional):

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `to_metric` | text | no |   |
| `period` | text | no |   |
| `comparison` | one of "none", "difference", "growth_rate", "ratio" | no |   |
| `comparison_period` | text or null | no |   |
| `currency` | text or null | no |   |
| `custom_axes` | an object | no |   |
| `note` | text or null | no |   |

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | Move a variant to another metric, or change its shift | Variant |

Fields of the first answer:

| Field | Accepts | Required | What |
| --- | --- | --- | --- |
| `kind` | "variant" | yes |   |
| `id` | text | yes |   |
| `metric` | an object with kind, id, name, label | yes |   |
| `table` | Table | yes |   |
| `dataset` | Dataset | yes |   |
| `workspace` | Workspace | yes |   |
| `measure` | Measure | yes |   |
| `measure_reference` | text | yes |   |
| `reads_selection` | true or false | yes |   |
| `selection_columns` | a list of text | yes |   |
| `expression` | text or null | yes |   |
| `normalized_expression` | text or null | yes |   |
| `format_string` | text or null | yes |   |
| `display_folder` | text or null | yes |   |
| `description` | text or null | yes |   |
| `description_pbi` | text or null | yes |   |
| `assigned_by` | one of "sync", "curator" | yes |   |
| `assigned_at` | text (date-time) | yes |   |
| `removed` | true or false | yes |   |
| `shift` | an object with period, comparison, comparison_period, currency, custom_axes, shift_note | yes |   |

Other answers: 400 The request is not valid; 401 Sign in first; 403 The caller's role or credential does not allow it; 404 No such thing, or none the caller may see; 409 It conflicts with the book as it is.

## workspaces

### GET `/api/v1/workspaces`

The workspaces the caller can see, with their dataset counts

Who may call it: Any signed-in caller: a person in a browser or with `pbmb login`, or a service account.

| Answer | Meaning | Shape |
| --- | --- | --- |
| 200 | The workspaces the caller can see, with their dataset counts | a list of an object |

Other answers: 401 Sign in first; 403 The caller's role or credential does not allow it.
