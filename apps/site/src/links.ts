// Every address the landing page links to, in one place. The docs paths are
// the public docs build's, which scripts/build.mjs puts under /docs.
export const GITHUB = "https://github.com/enum-studio/powerbi-metrics-book";

export const LINKS = {
  github: GITHUB,
  issues: `${GITHUB}/issues/new/choose`,
  contributing: `${GITHUB}/blob/main/CONTRIBUTING.md`,
  licence: `${GITHUB}/blob/main/LICENSE`,
  metricsBook: "https://github.com/enum-studio/metrics-book",
  enumStudio: "https://enumstudio.com",
  demo: "https://demo.powerbimetricsbook.io",
  docs: "/docs/",
  quickstart: "/docs/start/quickstart/",
  stack: "/docs/start/the-stack/",
  agents: "/docs/set-up/agents/",
  buildOnApi: "/docs/make-it-yours/building-on-the-api/",
  deploy: "/docs/deploy/",
  deployVm: "/docs/deploy/vm/",
  deployDokploy: "/docs/deploy/dokploy/",
  deployRailway: "/docs/deploy/railway/",
  deployAzure: "/docs/deploy/azure/",
  deployKubernetes: "/docs/deploy/kubernetes/",
  security: "/docs/security/reporting/",
  changelog: "/docs/reference/changelog/",
  microsoftPrepForAi:
    "https://learn.microsoft.com/en-us/power-bi/create-reports/copilot-prepare-data-ai",
  dbtBenchmark:
    "https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026",
  anthropicAnalytics:
    "https://claude.com/resources/articles/how-anthropic-enables-self-service-data-analytics-with-claude",
  sigmaSurvey:
    "https://www.sigmacomputing.com/resources/announcements/new-research-reveals-frustration-embarrassment-insecurity-dominate-the-data-conversation",
} as const;
