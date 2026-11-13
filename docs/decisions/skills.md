# Skills and their evals

## A skill change is measured with `pbmb agents eval`, on demand

**Each of the five eval tasks in `stack/agent_evals/` is run headless by an
agent, with the skills on and with them off, on the mock tenant, and the
pass rate, tokens and cost per run go into the tables below. The command
runs only when someone asks.**

Why: a skill is text an agent reads, so whether it helps can only be seen by
an agent doing a task. A task has an objective `check.py` (a program that
asks `pbmb` for the result and exits 0 or prints why not), so the
comparison is not an opinion. Every run costs model calls, so the evals are
never part of the default checks.

How one run goes (`apps/cli/src/powerbi_metrics_book/commands/agents.py`):

1. `pnpm dev:reset` and `pnpm dev:up`: a stack with nothing left from an
   earlier run (Node 24 first on PATH).
2. The sample admin's CLI login is saved in a folder of its own through the
   dev sign-in and the device code, so `pbmb` is signed in for the agent and
   the check and for nobody else.
3. The task's `setup.py`, if it has one, makes the starting state.
4. The agent gets `task.md` in an empty folder, after one sentence that says
   where the book is and that `pbmb` is signed in. The sentence is the same
   with and without the skill.
5. The task's `check.py` runs. Its last words are the reason a run failed.

Claude Code runs as `claude -p` with `--setting-sources project`, so the
person's own skills, hooks and memory reach neither arm. Skill on is
`--plugin-dir <repository root>`; skill off is `--disable-slash-commands`.
Each run is capped at 5 USD. Codex runs as `codex exec` in the same folder;
skill on copies `.agents/skills/` into it. Codex reports tokens and no cost.

Isolation: the person's own MCP servers can reach company data, so every
Claude run passes `--strict-mcp-config` with an `--mcp-config` that holds no
server at all. The tasks go through the `pbmb` command, which the prompt says
is signed in, so no connector is needed (and a headless run could not sign
one in). Codex runs with `--ignore-user-config`, which skips
`$CODEX_HOME/config.toml` where its MCP servers are set; auth still comes
from `CODEX_HOME`. Codex has no flag that refuses servers from a project
`.codex/config.toml`, so isolation there rests on the work folder being
empty. Each run's files and the agent's own output are copied to a folder
under the system temp directory, and its path is printed, because the work
folder is deleted. A failed run's reason holds the first 5 lines of each CSV
it left.

The agent's environment is the parent's without every `CLAUDE*` and
`ANTHROPIC*` variable, except the ones a login reads (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`,
`CLAUDE_CONFIG_DIR`). On this machine `claude -p` signs in from the stored
claude.ai login and needs none of them (`claude auth status` shows the login
with all of them removed). A run started from inside a Claude Code session
would otherwise inherit that session's model overrides, such as
`CLAUDE_CODE_SUBAGENT_MODEL`.

**Codex runs are not isolated from the user's own skills and instructions.**
Codex still loads `~/.codex/AGENTS.md`, `~/.agents/skills` and
`~/.codex/skills`, so `--without-skill` is not skill-free for Codex, and
instructions of the person's own reach both arms. The only way to stop that is
to point `HOME` or `CODEX_HOME` somewhere else, and that would mean copying
Codex's auth file into it, which an eval should not do with a person's login.
So a Codex comparison here measures the skills on top of whatever the person
has already installed. No Codex row has been recorded, and none should be read
as a with and without comparison until this is solved.

The five tasks:

| Task | The ask | Passes when |
|---|---|---|
| `structure_sample_drafts` | structure the drafts about net sales, orders and ad spend | Revenue USD is a USD variant of net sales and Ad spend LY a previous-year variant of ad spend; the three look-alikes (web net sales LY, order count, revenue in selected currency) stay metrics of their own; the three are verified and pass `pbmb metrics check` |
| `danish_conventions` | measures named in Danish with spaces: set up conventions that fit | the saved conventions validate, every check passes on three Danish metrics described in full, and the fields check still fails the one described in nothing |
| `csv_sales_by_month` | how much did we sell last year, by month, as a file | a CSV holds the mock's figure for each of the 12 months, in calendar order (a Total row is allowed), and the query log shows a successful Sales query that used the `[Net sales]` measure of a metric |
| `answer_orders_question` | answer the open question about orders | the question is answered by an accepted reply that speaks of returns |
| `curate_from_an_agreed_list` | the person is away and has agreed to descriptions only | at least three metrics have a new definition, no metric is merged, renamed or dismissed, no category is created, and `curation_progress.md` names `revenue_usd` and `ad_spend_ly` |

Read a row with its limits in mind:

- The mock reaches a monthly aggregate only through a recorded query, and
  answers any other aggregate DAX with a refusal. So an agent can reach the
  monthly figure only through a query it finds. `csv_sales_by_month` has a
  `setup.py` for that (below); the first four rows of that task ran before it
  existed and could not pass.

- The mock evaluates only the recorded queries (`SAMPLE_QUERIES` in
  `packages/powerbi-mock/src/sample/tenant.ts`), so `csv_sales_by_month`
  can pass only in 2026, when last year is 2025; its check says so in any
  other year.
- Three runs show a rate of 0, 33, 67 or 100 percent. A difference of one
  run between two rows is not a result.
- `structure_sample_drafts` reads the spec's "the two known merges" as the
  two the drafter suggests by name, Revenue USD and Ad spend LY, which sit
  in the Finance and Marketing datasets, not in Sales.

When it stops being right: when a skill, the conventions' default preset, the
sample tenant or `pbmb`'s flags change, the rows below describe the old
version; run the task again and add a row. The command replaces a row of the
same date, agent and skill and keeps the others.

## `pbmb curate` prints the curation skill, and the agent works in batches

**One sentence starts curation: "Run `pbmb curate` and follow what it prints."
The command reads only, needs a person's own login with the curator role, and
prints the counts and the `curate_metrics_book` skill. The skill works in
batches with four check-ins, and a yes names a list the person can strike lines
from.**

Why: on a tenant with thousands of drafts, a yes per draft does not scale, and
the agent can read the DAX and query the data itself. Merges, renames, deletes,
dismissals and new categories still need a named yes, so they go in one list.

- The brief is the skill, copied into the package by
  `apps/cli/scripts/sync_assets.py`, so an agent needs nothing installed and a
  deployment cannot change what it is told to do.
- No route was added. The counts page through `GET /api/v1/metrics`, so `draft`
  also holds drafts someone has touched. The role check is the api's refusal on
  `GET /api/v1/drafts/next`.
- `pbmb curate` refuses a service account, though the api would let one with the
  role curate, because `docs/security/agents.md` allows a curating agent only
  through a person's `pbmb login`.

**Not measured yet.** No eval has run on this skill. Run
`curate_from_an_agreed_list` with the commands under "Not run yet". The arms
differ less than in other tasks: `--without-skill` can still find `pbmb curate`
in `pbmb --help`, and then reads the same words.

**One blind run, 2026-11.** An agent given only this brief curated 20 harder
metrics of a real tenant, and its result was compared with definitions a person
had written. It took about 5 minutes and about 0.75 USD. It read every
calculation correctly, asked the right business questions (where a timing clock
starts, what an internal word means), and wrote all six fields on all 20. One
meaning was wrong: a positive part of a profit figure was described as a cost.
This is one run, not the paid eval, and says nothing about the skill against no
skill. Each finding led to one change in the skill and `metrics_curator.md`:
the sign mistake, to reading the measures that use a measure; definitions that
named a column, to describing the thing and listing the question; invented
aliases, to allowing only names that exist; no answer for a value before its
data arrives, to querying values by month and blanks for money metrics; the
timing clock asked once per measure, to asking it once per family.

When it stops being right: when a route counts the queue, use it. When batches
merge wrongly more often than a yes per draft did, go back to asking per draft.

## Not run yet

Only `csv_sales_by_month` has been run (one run with Claude, with and
without the skill, on 2026-10-27). Every other task, and every Codex run,
waits for Martin to ask, because each run calls a model. The commands:

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
uv run pbmb agents eval --task structure_sample_drafts --runs 3
uv run pbmb agents eval --task structure_sample_drafts --runs 3 --without-skill
uv run pbmb agents eval --task danish_conventions --runs 3
uv run pbmb agents eval --task danish_conventions --runs 3 --without-skill
uv run pbmb agents eval --task answer_orders_question --runs 3
uv run pbmb agents eval --task answer_orders_question --runs 3 --without-skill
uv run pbmb agents eval --task csv_sales_by_month --runs 3
uv run pbmb agents eval --task csv_sales_by_month --runs 3 --without-skill
uv run pbmb agents eval --task curate_from_an_agreed_list --runs 3
uv run pbmb agents eval --task curate_from_an_agreed_list --runs 3 --without-skill
```

Add `--agent codex` to each for Codex. A task with no table below has not
been run.

## The history `csv_sales_by_month` plants

**Its `setup.py` runs the recorded query once as the sample analyst, so the
query log holds a colleague's successful "Net sales by month for 2025" on the
Sales dataset before the agent starts.**

Why: the query log shows every entry to every signed-in person
(`access/policies/query_log.yaml` allows `read` to all roles; the route filters
only on what the caller asks for), so an agent signed in as the admin sees the
analyst's entry with `pbmb queries search "Net sales" --dataset "Sales"`.
That is the case the query_power_bi skill describes: someone asked this
before. The setup gives the analyst the viewer role, connects the analyst's
Power BI account at the mock (a query runs with the person's own token), and
signs the analyst in to the CLI in a folder of its own. `check.py` still
looks only at the eval person's own queries (`--mine`), so the agent has to
run the DAX itself; finding it is not enough.

Proved on a live stack on 2026-10-27 with a scripted agent: with the seed and
no CSV the check says the CSV is missing; the script searched, found two entries,
took the analyst's DAX and ran it with `--csv` (12 rows, the right figures);
the check then passed. A CSV that was there before the agent's own query
failed the check with "no successful ... query".

When it stops being right: when the mock answers more aggregate DAX, the seed
no longer decides whether the task can be passed, and the history can go.

## What the first two runs showed

Both runs of `csv_sales_by_month` on 2026-10-27 (one with the skill, one
without, `--runs 1`) failed the same line of the check, and both left one
file, `net_sales_by_month_2025.csv`. One run each says little about the
skill; it shows the harness works from the stack to the table.

What is known about why:

- The check printed only the sum it expected, not what the CSV held, and
  the working folder is deleted after a run, so the CSVs are gone. The check
  now prints each numeric column's row count and sum, so the next failure
  says what was wrong.
- The query log of the skill-off run survived in the stack's volume. It
  shows that agent downloaded the whole `Sales` and `Date` tables (2,938 and
  1,096 rows) and added the months up itself. Its one query that used the
  `[Net sales]` measure, with extra columns, failed. It never ran a
  successful query on the measure, so it would have failed the second half
  of the check too.
- The skill-on run's log was removed by the next run's `dev:reset`. Whether
  that agent found the metric's measure is not known.

The pass criteria were not changed after seeing these runs.

## csv_sales_by_month

The first two rows ran with the person's own MCP servers loaded, before the
isolation above. They are kept and are not a valid comparison with later
rows.

| Date | Agent | Skill | Runs | Passed | Pass rate | Tokens per run | Cost per run | Why runs failed |
|---|---|---|---|---|---|---|---|---|
| 2026-10-27 | claude | on, user MCP servers loaded, eval unpassable: no query to find | 1 | 0 | 0% | 789,537 | $0.68 | no column of net_sales_by_month_2025.csv has 12 months summing to 175802.39 |
| 2026-10-27 | claude | off, user MCP servers loaded, eval unpassable: no query to find | 1 | 0 | 0% | 868,427 | $0.79 | no column of net_sales_by_month_2025.csv has 12 months summing to 175802.39 |
| 2026-10-27 | claude | on, eval unpassable: no query to find | 1 | 0 | 0% | 570,439 | $0.55 | the query log has no successful Sample data: Sales query using [Net sales] [first lines: net_sales_2025_by_month.csv: Month,Net sales / 2025-01,14702.21 / 2025-02,14731.32 / 2025-03,15911.55 / 2025-04,14435.14] |
| 2026-10-27 | claude | off, eval unpassable: no query to find | 1 | 0 | 0% | 658,715 | $0.61 | the query log has no successful Sample data: Sales query using [Net sales] [first lines: net_sales_2025_by_month.csv: Month,Net sales / 2025-01,14702.21 / 2025-02,14731.32 / 2025-03,15911.55 / 2025-04,14435.14] |
| 2026-10-27 | claude | off | 1 | 1 | 100% | 758,893 | $0.36 | none |
| 2026-10-27 | claude | on | 1 | 1 | 100% | 353,478 | $0.27 | none |

### What the isolated runs showed

With no MCP server loaded, both runs (files kept in the system temp folder)
left a CSV with the right figure for every month and a Total row of
175,802.39, so the first half of the check passes in both arms. Both fail
the second half: neither ran a successful `[Net sales]` query. Each agent
said in its answer that the book's query engine would not run a monthly
summary query, so it downloaded the 2,938 rows of the Sales table and added
them up itself (15 and 14 turns). The mock answers only the recorded query
text exactly, so any other DAX using the measure fails, and an agent that
writes its own DAX, with or without the skill, ends up here.

With one run each, the skill shows no difference on this task: on, 570,439
tokens and $0.55; off, 658,715 tokens and $0.61. The check is unchanged.
Whether the skill's step "take a metric's variant DAX instead of inventing
it" gets an agent to the recorded query is a question for `--runs 3`, not
for these rows. The first two rows say nothing about the CSV: their check
printed only the expected sum, and their files are gone.

### What the runs with the planted history showed

Both runs on 2026-10-27 passed, with no MCP server loaded: with the skill in
10 turns, 353,478 tokens and $0.27; without it in 16 turns, 758,893 tokens
and $0.36. Both left `net_sales_by_month_2025.csv` with the right months and
ran the metric's DAX themselves, which the check confirms from the query log.
One run each cannot say the skill helped; the gap in tokens and turns is the
thing to measure with `--runs 3`. The first attempt of the skill-on run
crashed in the harness (a 500 from the dev sign-in right after `dev:up`, before
any model call), so it was run again once; the row is the second attempt.
The 500 is not explained and has happened once.

The two passing runs above ran from inside a Claude Code session, so they
inherited its environment, including `CLAUDE_CODE_SUBAGENT_MODEL`. Neither
spawned a subagent (`subagent_stats.spawned` is 0 in both kept outputs, and
only `claude-opus-5-5` is in `modelUsage`), so the variable changed nothing
and the rows stand. The runs are in `pbmb-eval-kept-o0jxkgad` (skill on) and
`pbmb-eval-kept-lh0ml_rl` (skill off) in the system temp folder.

The mention of `pbmb variants list` in the curate skill was not measured with an eval, since it adds a command name and no step.
