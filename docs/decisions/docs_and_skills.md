# Docs, skills and the open-source files

Taken in the spec of 2026-10-25 or during the build (2026-10-25 to 2026-10-27), as each says. The
skills' own decisions and their eval results are in `skills.md`, and the release workflow's in
`release.md`.

## The README frames the product as Agent First BI

**The README says "Power BI Metrics Book is Agent First BI"; the product, repository, packages and
command keep their names.** Martin, 2026-10-25. Metrics Book's README uses the same phrase, so the
two read alike. The phrase is in the README only, so a rename stays a README edit. Stops being right
if Martin drops the phrase from Metrics Book.

## One set of open-source files, adapted from Metrics Book

**`LICENSE` is Apache-2.0, `NOTICE` names Enum Studio ApS, and `CODE_OF_CONDUCT.md`, `SECURITY.md`,
the issue and pull request templates, `README.md` and `CONTRIBUTING.md` are adapted from Metrics
Book's.** Taken 2026-10-25. Two products read alike when an agent moves between them. `AGENTS.md`
sits at the root and in each area, and there is no `CLAUDE.md`: Claude Code, Codex and Cursor all
read the same files. Stops being right if the two products' contributing rules diverge, such as a
different test tier.

## The docs site is a section per reader

**The docs are Starlight in `apps/docs`, in seven parts: start, set-up, use, deploy, make-it-yours,
security and reference.** The Set up part is served at `/docs/set-up/`, matching its folder, and a test pins every
setup step's `docs_path` to it. The Set up pages use the words
of the setup screens, and every page ends with the check that proves its step worked. The REST and
MCP references take "who may call it" from the authorization matrix, so the docs and the tested
access rules have one source. Stops being right if the product's steps and the pages are no longer
one to one.

## The setup link in agent-facing docs

**Every skill, guide and the quickstart tells the person to run `server setup-link` themselves.**
Spec text said the deploy skill "hands the person the setup link"; the enforced rules win, because
all three agents deny `docker compose exec`. See `security.md`.

## Deploy guides: four targets, three of them untested

**The guides are one VM with Docker Compose (the reference), Dokploy or Coolify, Railway, and Azure
Container Apps. Kubernetes waits for someone to ask.** The VM guide is the one the build follows to the
letter. Review item 12 (2026-10-25): the others can be followed to the letter
only with accounts Martin owns, so each is marked untested until it is. Choices that came from the
security reviews: Azure uses three managed identities with per-secret roles, because one identity
would let the api read the worker's; VM backups are encrypted with age to off-VM recipients, with
write-only credentials and bucket-side retention, and dump as the `migrator` role because
`setting_check` has row-level security; Railway uses Infrastructure as Code in one
`.railway/railway.ts`, because Railway stops reading `railway.json` on 2026-12-01 (docs.railway.com,
read 2026-10-26); Railway trusts the client address from `X-Real-IP` only after a step in the guide
checks it with a pinned `edge-check` service, because Railway's docs do not say the edge overwrites
a forged value. Stops being right when Railway or Azure change their products, or the first real
run of a guide finds a step wrong.

## The skills ship as a plugin and as copies

**The five skills live in `skills/`, ship as the `powerbi-metrics-book` Claude Code plugin
(`.claude-plugin/`) with a `metrics_curator` subagent that has no settings tools, and are copied to
`.agents/skills/` for Codex by `scripts/sync-agent-skills.mjs`.** Codex follows copies, not
symlinks, so the script keeps them equal and `--check` fails on a difference. The plugin carries no
MCP server (see `architecture.md`). Stops being right if Codex follows symlinks.

## How a customer gets the skills

**A customer installs the skills from the public repository, with the commands in `set-up/agents.md`.**
Those are `claude plugin marketplace add` and `claude plugin install` for Claude Code, and a clone copied to
`~/.agents/skills` for Codex and Cursor. Martin decided on 2026-11-05 to open the repository, as `release.md`
already plans, so no customer needs read access and the skills need no second way to ship, such as inside the
`pbmb` package. Changing the repository's visibility is the last step, and it is his. Both commands ran on
2026-11-04 with a git login that has access. Until the repository opens, a login without access stops with
`could not read Username` and the `skills/` link answers 404.

Once a release is tagged the commands should pin to it, as the deploy guides do:
`enum-studio/powerbi-metrics-book#v0.1.0` and `git clone --branch v0.1.0`. They follow `main` until then,
because no tag exists to pin to (`threat_model.md`, Residual risks). Stops being right if the repository stays
private past the first customer who needs the skills.
