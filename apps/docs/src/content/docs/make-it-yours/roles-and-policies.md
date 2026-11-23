---
title: Roles and policies
description: The shipped roles, how to assign them, how to add a role of your own with a Cerbos policy and its test, and how your policies sit on top of the defaults.
sidebar:
  order: 3
---

Who may see and do what is decided by Cerbos policies, read on every request. The image ships default policies. You add your own beside them in files, with a test for each, and you never touch the core's code.

## The shipped roles

| Role | May |
|---|---|
| `viewer` | Read, search, run queries on what Power BI lets them see, ask questions, comment, upvote, and read the query log. |
| `curator` | Everything a viewer may, and change the book (`curate`), verify, approve, accept answers and archive threads. |
| `admin` | Everything a curator may, and settings, secrets, conventions, people, service accounts, sync and audit. |
| `pii_reader` | Read and query marked personal data within the person's Power BI rights. Add it to the person's normal role. |

Admins do not receive `pii_reader` automatically. Assign it only to a person or group; service accounts never read PII. See [PII](/docs/make-it-yours/pii/) for rules and a worked check.

What a person may see in the first place is a separate rule, `access.metadata_visibility`: `powerbi` (the default, what Power BI lets them reach), `everyone` (anyone signed in), or `policy` (only what your own policy allows). Power BI then applies the person's own rights again on every query, so a role never gives access to data Power BI refuses.

## Assign roles

Roles are kept in the database and read on every request. Assign them in the admin section or with the CLI:

```bash
pbmb admin roles list
pbmb admin roles assign curator --person ada@sample.example
pbmb admin roles assign viewer --domain sample.example
pbmb admin roles assign curator --group <group id> --provider microsoft
pbmb admin roles revoke <assignment id>
```

Give one of `--person` (an email), `--domain` (an email domain) or `--group` (the id the sign-in provider puts in the token, with `--provider`, which defaults to `microsoft`). The last admin cannot be revoked.

The default after setup is that everyone in your Power BI tenant is a `viewer` (the setting `access.default_role`: `viewer`, `curator` or `none`, where `none` lets in only people who are assigned) and the person who ran the setup is an `admin`. Change the default with `pbmb admin settings set access.default_role none`. `pbmb admin export` writes the assignments into `book.yml` for git.

## Add a role

A role exists when a policy names it. Say a team of metric stewards should curate and verify the book, but leave approval to curators. Three steps: the policy, its test, the assignment.

`pbmb init` made two folders in your deployment directory, `access/policies/` and `access/tests/`. Put the policy in `access/policies/book.yaml`:

```yaml
# Metric stewards may curate and verify the book, but not approve.
apiVersion: api.cerbos.dev/v1
resourcePolicy:
  resource: book
  version: default
  scope: deployment
  scopePermissions: SCOPE_PERMISSIONS_OVERRIDE_PARENT
  rules:
    - actions: [curate, verify]
      effect: EFFECT_ALLOW
      roles: [metric_steward]
```

Put its test in `access/tests/book_test.yaml`. Cerbos expects a refusal for every combination the test lists and `expected` leaves out, so the test checks what a steward may not do as well:

```yaml
name: metric_steward
description: A steward curates and verifies; a viewer and the shipped curator keep what the defaults give them.
options:
  lenientScopeSearch: true
principals:
  steward:
    id: steward
    roles: [viewer, metric_steward]
  viewer:
    id: viewer
    roles: [viewer]
  curator:
    id: curator
    roles: [curator]
resources:
  book:
    kind: book
    id: book
    scope: deployment
tests:
  - name: who may do what to the book
    input:
      principals: [steward, viewer, curator]
      resources: [book]
      actions: [curate, verify, approve]
    expected:
      - principal: steward
        resource: book
        actions: { curate: EFFECT_ALLOW, verify: EFFECT_ALLOW }
      - principal: curator
        resource: book
        actions: { curate: EFFECT_ALLOW, verify: EFFECT_ALLOW, approve: EFFECT_ALLOW }
```

Run the tests before you start anything:

```bash
pbmb check
```

`pbmb check` validates `book.yml` when there is one, checks that `.env` holds every bootstrap value and is readable only by you, and runs your policy tests in the pinned Cerbos image through Docker, with the default policies underneath. Run it from the deployment directory, or pass the directory. It exits 1 when a step fails, and prints the last lines of Cerbos's output so you can see which test failed.

Cerbos reads policies once at start. Load the new policy, then assign the role. Because the api does not know your role, assigning it takes `--custom`, which says you mean a role your own policies define:

```bash
docker compose restart cerbos
pbmb admin roles assign metric_steward --person grace@sample.example --custom
```

The person keeps `viewer` from the default assignment, and gains `metric_steward`.

## What a policy can decide

Every request that reads or changes data asks Cerbos about a resource and an action:

| Resource | Attributes | Actions |
|---|---|---|
| `dataset` | `workspace_id`, `workspace_name`, `app_ids`, `app_names`, `has_row_level_security`, `endorsement`, `sensitivity_label`, `custom` | `describe`, `query` |
| `book` | none | `curate`, `verify`, `approve`, `edit_conventions` |
| `thread` | `author_id`, `kind`, `status` | `create`, `reply`, `upvote`, `accept`, `archive` |
| `query_log` | `principal_kind`, `principal_id` | `read` |
| `result` | `owner_id` | `read` |
| `admin` | none | `manage_settings`, `manage_secrets`, `manage_people`, `manage_service_accounts`, `run_sync`, `read_audit`, `revoke_connection`, `sign_out_person`, `read_sync_events`, `read_status` |

The principal carries its roles, its kind (`person` or `service_account`), and what Power BI says it can reach: `powerbi_workspace_ids`, `powerbi_app_ids` and `powerbi_dataset_ids`. Read the default policies in `access/policies/` of the repository: they are short, and they are the best examples.

`has_row_level_security` is true when the model defines row-level security roles, as Power BI's scan reports it. Before the release of 23 November 2026 the sync never stored it, so it was false on every dataset, and a rule that reads it starts to apply at the first full scan after that release (`powerbi.sync.full_scan_schedule`).

Lists and search apply `describe` inside their SQL, using Cerbos's query plan. A `describe` rule may therefore use only `workspace_id`, `has_row_level_security`, `endorsement`, `sensitivity_label`, the dataset id and `app_ids`, with `and`, `or`, `not`, `==`, `in` and `hasIntersection`. A condition the api cannot translate fails every list loudly instead of showing too much. A `query` rule is checked for one dataset at a time and may use any attribute, including `custom`.

Searching the query log applies `read` inside its SQL the same way. A `query_log` rule may use only `principal_kind`, `principal_id` and the entry's id, with `and`, `or`, `not`, `==` and `in`. Write `!(R.attr.principal_id == P.id)`, because `!=` is not translated and fails every search of the log loudly.

`pbmb check` compiles your policies and runs their tests, and does not ask for the query plan, so it passes such a rule. To find why a list or a search answers 500, take the `X-Request-Id` header of that answer and search the api's log for it with `docker compose logs api`. The error line with that `request_id` names the rule and the condition the api could not translate.

## How your policies layer on the defaults

The defaults sit at the root scope. The api asks every question at the scope `deployment`. A resource you write no policy for falls back to the default. For one you do write, a rule of yours that matches decides, and where none matches the defaults decide.

Your policies must use `scope: deployment`. Cerbos makes every policy in one scope share one `scopePermissions`, so you make one choice for all of them:

| `scopePermissions` | Your rules | Use it to |
|---|---|---|
| `SCOPE_PERMISSIONS_OVERRIDE_PARENT` | Replace a default. An ALLOW widens and a DENY narrows. | Add a role, open or close a dataset. |
| `SCOPE_PERMISSIONS_REQUIRE_PARENTAL_CONSENT_FOR_ALLOWS` | An ALLOW counts only where a default allows too. Only DENY rules take effect. | Narrow the defaults and be sure nothing widens. |

Both are shown with their tests in `access/layering_tests/` in the repository. In `override/`, a deployment policy opens certified datasets to everyone signed in, and the defaults decide the rest. In `narrowing/`, the book policy denies `approve` to curators, so only admins approve, and its ALLOW for everyone to curate changes nothing:

```yaml
resourcePolicy:
  resource: book
  version: default
  scope: deployment
  scopePermissions: SCOPE_PERMISSIONS_REQUIRE_PARENTAL_CONSENT_FOR_ALLOWS
  rules:
    - actions: [approve]
      effect: EFFECT_DENY
      roles: [curator]
```

The PII widening in `override/` has no effect for anyone who is not a person holding `pii_reader`; the api refuses it in code.

Copy the one you want into `access/policies/` and its test into `access/tests/`, then run `pbmb check`.

## What no policy can widen

The api holds some rules in code, because a policy cannot see how a request arrived. They apply whatever your policies say:

- A service account's workspace and app grant can never be widened. A policy that allows a service account a dataset outside its grant is overridden by the api.
- The api refuses every admin action to a service account, except reading the status.
- A result can be read only by the caller who ran the query.
- Only a person in a browser session approves a metric, unless the conventions' `trust.human_verify_from` says `any`.

These are listed again in [What is not a setting](/docs/make-it-yours/what-is-not-a-setting/).

## Check

```bash
pbmb check
pbmb admin roles list
pbmb whoami
```

`pbmb check` prints `ok   policy tests` (and `ok   .env`, `ok   book.yml`) and exits 0. `roles list` shows the assignment you made. Run `pbmb whoami` as that person: it lists `metric_steward` among their roles.
