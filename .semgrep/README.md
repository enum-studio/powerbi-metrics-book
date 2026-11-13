# Semgrep rules of this repository

`pnpm check:all` runs semgrep with the public TypeScript and Python rule sets
and these rules. Test them with:

```bash
docker run --name pbmb-semgrep-test -v "$PWD:/src" -w /src semgrep/semgrep:1.182.0 semgrep --test --metrics=off .semgrep/
docker rm pbmb-semgrep-test
```

| Rule                                           | What it refuses                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `no-fetch-outside-guarded-fetcher`             | `fetch(` anywhere under `apps/api/src/` except `apps/api/src/http/fetcher.ts`, so every outbound request keeps the https-only, public-address, size, time and no-redirect limits.                                                                |
| `no-undici-outside-guarded-fetcher`            | An import or call of `undici` under `apps/api/src/` except `apps/api/src/http/fetcher.ts` and the test files (`*.test.ts`, `*_security_test.ts`), which are clients of the app under test and not part of the image. Reaching undici directly skips the fetcher's limits. |
| `no-sql-built-by-string-formatting-python`     | An f-string, `%`, `.format` or `+` result passed to `execute`, `executemany` or `executescript`, directly or through a variable.                                                                                                                 |
| `no-sql-built-by-string-formatting-typescript` | A template literal or `+` result passed to `.query(` or `sql.raw(`, directly or through a variable. The `sql` tag is allowed: it parameterizes every interpolation.                                                                              |

## Layout

Semgrep's test runner skips a rule file whose parent directory starts with a
dot, so the rules live in `.semgrep/rules/`. Each rule file has fixtures
beside it with the same file name (`.ts`, `.py`), marked `ruleid:` where the
rule must fire and `ok:` where it must not. `semgrep --test` ignores a rule's
`paths:` block, so the fixtures stand in for the files the rule guards; real
scans honour `paths:`, and no rule's `paths:` reaches into `.semgrep/`, so the
fixtures are never scanned as code.
