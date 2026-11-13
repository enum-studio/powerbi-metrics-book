<!--
Fill every section. Write for a reader who does not know the code.
This description is public: name no client and nothing from a real tenant,
and link nothing a visitor cannot open. Check it first with
node scripts/check-private-names.mjs <file>.
Run the smallest test tier that catches the change; tier 3 runs before you
open the pull request.
-->

## What changed

<!-- In plain words: what a person using the book, the connector or the CLI sees differently. -->

## Areas touched

<!-- Tick every area that has a changed file. -->

- [ ] api (`apps/api`)
- [ ] web app (`apps/web`)
- [ ] docs site (`apps/docs`) or `docs/`
- [ ] CLI (`apps/cli`)
- [ ] Power BI mock (`packages/powerbi-mock`)
- [ ] tokens (`packages/tokens`)
- [ ] access (Cerbos policies in `access/`)
- [ ] stack (compose, Postgres roles, Cerbos config)
- [ ] conventions, skills or examples
- [ ] agent configuration (`.claude/`, `.codex/`, `.cursor/`, `.devcontainer/`)
- [ ] GitHub configuration (`.github/`)

## Tests run

<!--
Tier 1, 2 or 3, the command, how many tests passed, failed and were skipped,
and how long it took. A skipped test counts as a failed test.
-->

- Tier:
- Command:
- Passed / failed / skipped:
- Duration:

## Security review

<!--
A change to auth, access, Power BI tokens or clients, results, settings or
secrets, MCP, compose networks, database roles or the guarded fetcher needs a
review before it is done. A security test is never deleted, skipped or
loosened to make a change pass; if one changed, say why here.
-->

- [ ] Done: who or what ran it (the `security_review` skill, the `security-reviewer` agent, a person), and the result
- [ ] Not needed: this change touches none of the areas above, because:
