# Changelog

What each release of Power BI Metrics Book changes, newest first. Upgrade notes sit under the release that needs them.

## 0.1.0

First public release of the app, CLI and container image.

### Added

- A metrics guide with business areas, metric relationships, a glossary and Markdown and PDF exports.
- Metric documentation for importance, direction, uses, caveats, decisions, actions and primary dimensions.
- Metric owners, person titles and follows, with a personal metrics check-in through the connector.
- Curation commands for documentation, owners, relationships and guide content, with conventions-driven checks.

### Included

- A catalog of Power BI workspaces, datasets, tables, columns and measures, kept up to date by scheduled syncs.
- A metrics book that groups measures into variants, with categories, glossary terms, documentation, questions and human verification.
- An MCP connector, the `pbmb` CLI and a REST API for finding definitions and querying Power BI. The connector reads the book; curation uses the CLI or API.
- Queries under each person's Power BI identity, with private results, paged reads and CSV downloads. Service accounts cannot query models that need a person's identity.
- Configurable naming conventions, sign-in providers and access policies, with encrypted secrets and an audit history.
- A browser setup guide, deployment documentation, a sample tenant and a public demo on invented data.
