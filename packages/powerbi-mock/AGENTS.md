# packages/powerbi-mock

`@powerbi-metrics-book/powerbi-mock`: a small Hono server that answers as
Power BI, Microsoft identity, Microsoft Graph and the embedding providers
do, with the invented sample tenant. Development, every test and the
end-to-end run use it; no company's tenant is ever used. Tests start it
in-process with `startMockPowerBi(options?)`, which returns
`{ url, close, setActingUser(objectId) }`.

Standards: `docs/standards/typescript.md`.

## Routes, under one origin

- `{origin}/{tenant}/oauth2/v2.0/authorize`, `/token`,
  `/{tenant}/discovery/v2.0/keys`: identity (`powerbi.authority = {origin}`).
- `{origin}/powerbi/v1.0/myorg/...`: Power BI (`powerbi.api_url = {origin}/powerbi`).
- `{origin}/graph/v1.0/me/transitiveMemberOf`: Graph.
- `{origin}/openai/v1/embeddings` and
  `{origin}/gemini/v1beta/models/{model}:batchEmbedContents`: embeddings,
  with deterministic vectors.

## Rules here

- **The mock answers as Microsoft documents.** Paths, query parameters,
  bodies, status codes, error shapes and limits (429 with `Retry-After`,
  the scanner's call limits, the 100,000-row and 15 MB query limits) are
  Microsoft's. A shape change cites the Microsoft Learn page or the
  operation in `sdk/swaggers/swagger.json` of `microsoft/PowerBI-CSharp`
  in the commit message and beside the code.
- Where Microsoft's pages disagree, or document nothing, the mock does the
  stricter thing and the decision goes in `docs/decisions/powerbi.md`.
- It refuses what Power BI refuses: the `/groups/{id}` query path to a
  person who reaches a dataset only through an app, a person without
  access, a reused refresh token (`invalid_grant`), `INFO` views on the
  dataset that real tenants sometimes refuse.
- **The sample tenant is invented, and labelled at the tenant.** The web
  app's band, `pbmb whoami` and the MCP instructions say it is sample
  data; the names are plain (Sales, Finance, Analysts). The people and
  groups are listed in `src/sample/README.md`, the tenant id is
  `11111111-1111-4111-8111-111111111111`. Nothing from a real tenant,
  company or person enters it.
- The drafter's expected groups are written down beside the sample, so a
  test fails when the drafter changes its mind. A change to the sample
  changes them on purpose.
- Only tests and the dev stack use the mock: no module the api ships
  imports it.

## Check

```bash
pnpm --filter @powerbi-metrics-book/powerbi-mock test
pnpm --filter @powerbi-metrics-book/powerbi-mock typecheck
```
