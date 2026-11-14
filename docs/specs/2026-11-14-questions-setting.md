# Questions as an admin setting

Taken on 2026-11-14. Follows `docs/specs/2026-11-13-connector-list-anchors.md`, whose follow-ups
name this spec.

## Goal

Questions (threads: ask about a metric, dataset or term, reply, accept an answer, upvote) become a
feature an admin turns on. Off by default. A deployment that has not turned them on shows no trace of
them: no tools, no routes, no screens, no fields.

**Done means:**

- A new deployment has `questions.enabled` false, and its connector lists 26 tools.
- An admin turns questions on under Settings, General, and the six thread tools, the REST thread
  routes, the open and answered questions on the catalog pages and the question fields come back.
- Turning them off again hides the same things and deletes nothing.
- A security test proves every write and read of a thread is refused while questions are off, through
  every door.

## Non-goals

- No change to who may ask, reply, accept or archive. Cerbos still decides that, as today.
- No change to requests and the usage report. `record_request`, `pbmb requests` and a request's
  `question` text are a separate feature and stay on.
- No change to the thread tables. Stored threads are kept while questions are off. Production has
  none today.
- No thread screen in the web app. There is none today.

## Design

### 1. The setting

`questions.enabled`, a boolean, default `false`, in `SettingValues` (`apps/api/src/context.ts`),
`SETTINGS` (`apps/api/src/services/settings/registry.ts`) and the test double's defaults
(`apps/api/test/doubles.ts`). The `setting` table's `setting_key_known` check is built from the
registry's keys, so one migration, made by `pnpm --filter @powerbi-metrics-book/api db:generate`,
adds the key to it, as `0007` did for the usage settings. Description: "Let people and agents ask questions about metrics,
datasets and terms, reply, and accept an answer." The admin section shows it on the General page as
"Questions", a switch.

### 2. One gate, in the service layer

The rule lives in `apps/api/src/services/threads/`, so the SPA, the CLI, MCP and service accounts are
gated in one place (load-bearing rule 4).

- `questionsOn(context: ServiceContext): Promise<boolean>` reads the setting.
- Every exported entry point of `threads.ts` (`postThread`, `reply`, `getThread`, `listThreads`,
  `acceptReply`, `archiveThread`, `setUpvote`) first awaits `requireQuestions(context)`, which throws
  a `ServiceError` of a new kind, `questions_off`, when the setting is false. `ERROR_STATUS` in
  `apps/api/src/http/error-response.ts` answers it with 404. The check comes before Cerbos and before any read, so
  an off deployment answers the same whatever the thread id.
- `openQuestionsFor(db, element)` becomes `openQuestionsFor(context: ServiceContext, element)` and
  returns `null` when questions are off. Its three callers
  (`services/book/metrics.ts`, `services/book/terms.ts`, `services/mirror/read.ts`) then leave out
  `open_questions` and `accepted_answers`.
- `services/events/feed.ts` leaves out the `thread.*` event kinds when questions are off.

Why the service and not the routes: a route-only gate would leave the MCP tools, the change feed and
the get answers open, and the next door added would forget it.

### 3. MCP

- `defineTool` gains an optional `requires: "questions.enabled"`. The six tools in
  `mcp/tools/talk.ts` carry it.
- `tools/list` leaves out a tool whose setting is false. `tools/call` answers a hidden tool with the
  same error as a name that does not exist, so an agent cannot tell a hidden tool from a missing one.
  The service gate stays behind it.
- `instructionsFor` drops the thread sentence when questions are off.
- `get_metric`'s description reads "and the answered questions about it, when questions are on".
- `whoami` gains `questions: boolean`, so an agent and the skills can check.
- The anchors keep `open_questions` and `accepted_answers` as today; they are absent when off because
  the service left them out.

### 4. REST

- Each route in `routes/v1/threads.ts` checks its credential first (rule 2), then the service's
  `questions_off` error becomes `404 {"error": "questions_off", "message": "Questions are off. An admin
  turns them on under Settings, General."}`. An unauthenticated call still gets 401.
- `open_questions` and `accepted_answers` become optional in the Metric, Term and Dataset schemas
  (`routes/v1/schemas.ts`, `routes/v1/read.ts`): absent when off.
- `GET /api/v1/me` gains `questions: boolean`.
- `openapi.json` and `apps/web/src/api/schema.d.ts` are regenerated.

### 5. Web

- `me.questions` false: `QuestionsSection` and `AcceptedAnswers` render nothing.
- The admin General page gains the "Questions" switch, owned by that page in `admin/layout/nav.ts`.

### 6. CLI

- `pbmb questions` stays. On `questions_off` it prints the server's message and exits 1.
- `pbmb metrics show` and `pbmb terms show` print the question fields only when present.
- `pbmb whoami` prints "Questions: on" or "off".

### 7. Skills, docs and evals

- `skills/answer_questions/SKILL.md` starts with: call `whoami`; if `questions` is false, this skill
  does not apply. `skills/query_power_bi` and `skills/curate_metrics_book` say "when questions are
  on" where they point at threads, and so does the CLI's `assets/curation_brief.md`. `.agents/skills`
  is synced.
- `apps/docs`: `use/for-agents-questions.md` opens with how to turn questions on; the catalog and
  curator pages that mention open questions say "when questions are on"; the settings, MCP, REST and
  CLI reference pages are regenerated.
- The product spec's MCP, REST and settings tables, and `docs/decisions/book.md` (a short section:
  questions are off by default, and why the gate is in the service).
- `stack/agent_evals/answer_orders_question/setup.py` turns questions on.
- `apps/api/e2e/end-to-end.e2e.ts` turns questions on through the admin API before its thread steps,
  and checks a thread route answers 404 before that.

### 8. Tests

- New `apps/api/src/services/threads/questions_setting_security_test.ts`, on real Postgres, with
  questions off:
  - every thread route answers 404 `questions_off` to a signed-in admin and to a service account, and
    401 without a credential;
  - every `threads.ts` entry point throws the `questions_off` error, also for a thread that exists;
  - `tools/list` has 26 tools, and `tools/call` of each thread tool answers as an unknown tool;
  - `get_metric`, `get_dataset`, `get_term` and their REST routes carry no question fields while a
    thread with an accepted answer exists;
  - the change feed carries no `thread.*` event that exists;
  - turned on again, the same thread is readable and nothing was deleted.
- `connector_surface_security_test.ts`: 32 tools with questions on, 26 with them off. No assertion
  is loosened (rule 15).
- Existing thread tests (`services/threads`, `routes/v1/threads.test.ts`, the authorization matrix,
  `pii_security_test.ts`, `events_visibility_security_test.ts`, `tools.test.ts`) turn questions on in
  their setup and keep every assertion.
- Web: `questions.test.tsx` and `accepted-answers.test.tsx` cover `me.questions` false. CLI: the
  `questions_off` message and whoami line.

### 9. Security review

The change touches MCP, routes and settings, so the `security-reviewer` checks:

- no thread is read, written or counted through any door while questions are off;
- the gate runs after the credential check and before Cerbos, and leaks nothing about which threads
  exist;
- a hidden tool cannot be told from a missing one;
- `docs/security/threat_model.md` notes the setting under the threads boundary.

## Decomposition

3 issues, 2 waves.

1. **api** (wave 1): sections 1 to 4 and their tests, `openapi.json` and `schema.d.ts` regenerated.
   Budget about 650 lines.
2. **web** (wave 2, depends on 1): section 5. Budget about 150 lines.
3. **cli, skills, docs, evals** (wave 2, depends on 1): sections 6 and 7. Budget about 350 lines.
