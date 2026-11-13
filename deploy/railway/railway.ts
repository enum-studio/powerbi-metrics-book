// Power BI Metrics Book on Railway, as Railway Infrastructure as Code. Copy
// it to .railway/railway.ts in the deployment repository, then
// `railway config plan` and `railway config apply`. The guide is
// apps/docs/src/content/docs/deploy/railway.md.
//
// The issue asked for a railway.json per service. Railway has deprecated that
// format: new services cannot use it, and existing files stop being read on
// 2026-12-01. This file is its replacement, one file for the whole project.
//
// Postgres is built here from the pinned pgvector image, not from Railway's
// pgvector template (https://railway.com/deploy/3jJFCA): the template names
// pgvector/pgvector:pg18 by tag, not digest, opens a public TCP proxy to the
// database, and has no place for the deployment's init script.
//
// Pages relied on, read 26 October 2026:
// https://docs.railway.com/infrastructure-as-code
// https://docs.railway.com/infrastructure-as-code/reference
// https://docs.railway.com/variables (shared, reference and sealed variables)
// https://docs.railway.com/volumes (volumes mount as root: RAILWAY_RUN_UID)
// https://docs.railway.com/builds/dockerfiles (variables reach the build as ARG)
// https://docs.railway.com/deployments/start-command (it replaces ENTRYPOINT)
// https://docs.railway.com/networking/public-networking/specs-and-limits
// (the edge sets X-Real-IP)
import {
  defineRailway,
  github,
  image,
  project,
  service,
  volume,
} from "railway/iac";

// Change these four. IMAGE is the image line in compose.yml, which pbmb init
// pins by digest; never a tag alone.
const IMAGE =
  "ghcr.io/enum-studio/powerbi-metrics-book:0.1.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
const PUBLIC_HOST = "metrics.example.com";
// The deployment repository on GitHub that pbmb init's directory was pushed to.
const REPOSITORY = "example-org/pbmb-deployment";
const BRANCH = "main";

// false: each container's age identity is a sealed shared variable,
// API_AGE_IDENTITY or WORKER_AGE_IDENTITY, and both run as uid 10001.
// true: each identity lives in a volume instead. Railway mounts a volume as
// root and documents one answer, RAILWAY_RUN_UID=0, so both then run as root;
// in return `server rotate-identity` works.
const IDENTITY_VOLUMES = false;

// Railway's edge sets X-Real-IP to the client's address, and its pages do not
// say it replaces one the client sent. EDGE_CHECK adds edge-check, a pinned
// Caddy that answers with the X-Real-IP it receives, so the guide can test
// the edge before the api trusts the header. Only once that test passes:
// EDGE_CHECK false, which deletes edge-check, and CLIENT_ADDRESS_FROM_EDGE
// true, which sets CLIENT_ADDRESS_HEADER=x-real-ip on the api.
const EDGE_CHECK = true;
const CLIENT_ADDRESS_FROM_EDGE = false;
const CADDY =
  "caddy:2.11.7@sha256:504a44d7d74bd2bc28a66afc4774912fc21223ca8a67734af1c54ab2f999b489";

// Railway's template syntax, ${{ name }}, which it resolves at deploy.
const reference = (name: string) => `\${{${name}}}`;

// A database URL for one role. The passwords are shared variables a person
// sets from .env, so this file holds no value.
const databaseUrl = (role: string, password: string) =>
  `postgres://${role}:${reference(`shared.${password}`)}@${reference("postgres.RAILWAY_PRIVATE_DOMAIN")}:5432/powerbi_metrics_book`;

export default defineRailway((context) => {
  const pgdata = volume("pgdata", { sizeMB: 5000 });
  const apiIdentity = volume("api-identity", { sizeMB: 500 });
  const workerIdentity = volume("worker-identity", { sizeMB: 500 });

  // Where one container's identity comes from, by IDENTITY_VOLUMES.
  const identity = (
    variable: "API_AGE_IDENTITY" | "WORKER_AGE_IDENTITY",
    store: typeof apiIdentity,
  ): {
    volumeMounts: Record<string, typeof store>;
    env: Record<string, string>;
  } => ({
    volumeMounts: IDENTITY_VOLUMES ? { "/var/lib/pbmb/identity": store } : {},
    env: IDENTITY_VOLUMES
      ? { RAILWAY_RUN_UID: "0" }
      : { [variable]: context.shared[variable] },
  });
  const apiIdentitySource = identity("API_AGE_IDENTITY", apiIdentity);
  const workerIdentitySource = identity("WORKER_AGE_IDENTITY", workerIdentity);

  // pgvector's image with the deployment's own init script baked in, which
  // makes the roles, the database and the extensions on the first start.
  const postgres = service("postgres", {
    source: github(REPOSITORY, { branch: BRANCH }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "railway/postgres.Dockerfile",
    },
    volumeMounts: { "/var/lib/postgresql": pgdata },
    deploy: { restartPolicyType: "ALWAYS" },
    env: {
      POSTGRES_PASSWORD: context.shared.POSTGRES_PASSWORD,
      MIGRATOR_PASSWORD: context.shared.MIGRATOR_PASSWORD,
      API_RW_PASSWORD: context.shared.API_RW_PASSWORD,
      WORKER_RW_PASSWORD: context.shared.WORKER_RW_PASSWORD,
      AUDIT_WRITER_PASSWORD: context.shared.AUDIT_WRITER_PASSWORD,
    },
  });

  // Cerbos with the default policies from IMAGE and the deployment's own
  // from access/policies, built into one small image that runs as uid 10001.
  const cerbos = service("cerbos", {
    source: github(REPOSITORY, { branch: BRANCH }),
    build: { builder: "DOCKERFILE", dockerfilePath: "cerbos.Dockerfile" },
    deploy: { restartPolicyType: "ALWAYS" },
    env: { PBMB_IMAGE: IMAGE },
  });

  const shared = {
    PUBLIC_BASE_URL: `https://${PUBLIC_HOST}`,
    CERBOS_URL: `http://${reference("cerbos.RAILWAY_PRIVATE_DOMAIN")}:3592`,
    AUDIT_DATABASE_URL: databaseUrl("audit_writer", "AUDIT_WRITER_PASSWORD"),
    LOG_LEVEL: "info",
  };

  // The only service with a public domain.
  const api = service("api", {
    source: image(IMAGE),
    start: "node dist/cli-entry.js api",
    healthcheck: "/health",
    healthcheckTimeout: 120,
    domains: [{ domain: PUBLIC_HOST, port: 3000 }],
    volumeMounts: apiIdentitySource.volumeMounts,
    deploy: { restartPolicyType: "ALWAYS" },
    env: {
      ...shared,
      ...apiIdentitySource.env,
      PORT: "3000",
      DATABASE_URL: databaseUrl("api_rw", "API_RW_PASSWORD"),
      MIGRATOR_DATABASE_URL: databaseUrl("migrator", "MIGRATOR_PASSWORD"),
      AUTH_SECRET: context.shared.AUTH_SECRET,
      // The edge is the api's only public route.
      ...(CLIENT_ADDRESS_FROM_EDGE
        ? { CLIENT_ADDRESS_HEADER: "x-real-ip" }
        : {}),
    },
  });

  // No domain: nothing calls the worker. One replica: each worker runs the
  // schedule.
  const worker = service("worker", {
    source: image(IMAGE),
    start: "node dist/cli-entry.js worker",
    replicas: 1,
    volumeMounts: workerIdentitySource.volumeMounts,
    deploy: { restartPolicyType: "ALWAYS" },
    env: {
      ...shared,
      ...workerIdentitySource.env,
      DATABASE_URL: databaseUrl("worker_rw", "WORKER_RW_PASSWORD"),
    },
  });

  const edgeCheck = service("edge-check", {
    source: image(CADDY),
    start: "caddy respond --listen :8080 {http.request.header.X-Real-IP}",
  });

  return project("powerbi-metrics-book", {
    resources: [
      postgres,
      cerbos,
      api,
      worker,
      pgdata,
      ...(IDENTITY_VOLUMES ? [apiIdentity, workerIdentity] : []),
      ...(EDGE_CHECK ? [edgeCheck] : []),
    ],
  });
});
