// The stack's outer wall: published ports, networks, shared volumes, container
// hardening and pinned images, read from stack/compose.yml as written. Each
// rule is also run on a copy of the document with one boundary opened, so a
// rule that could never fail fails here. A failure on the real file means a
// boundary opened: fix compose.yml, never the test.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument, Scalar, visit } from "yaml";

const COMPOSE_FILE = new URL("../../../../stack/compose.yml", import.meta.url);
const DEV_OVERLAY = new URL(
  "../../../../stack/dev/compose.dev.yml",
  import.meta.url,
);
const BUILT_IMAGE = "powerbi-metrics-book";
const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;
const NETWORKS_BY_SERVICE: Record<string, string[]> = {
  api: ["app", "edge", "egress"],
  worker: ["app", "egress"],
  postgres: ["app"],
  cerbos: ["app"],
};

type Mount = string | { type?: string; source?: string; target?: string };
type Service = {
  image?: string;
  user?: string;
  read_only?: boolean;
  tmpfs?: string | string[];
  security_opt?: string[];
  cap_drop?: string[];
  cap_add?: string[];
  privileged?: boolean;
  network_mode?: string;
  networks?: string[] | Record<string, unknown>;
  ports?: unknown[];
  environment?: Record<string, string | null>;
  depends_on?: Record<string, { condition: string }>;
  labels?: string[] | Record<string, string>;
  command?: string[];
  restart?: string;
  volumes?: Mount[];
  volumes_from?: string[];
  healthcheck?: { test?: unknown; disable?: boolean };
  deploy?: { resources?: { limits?: { memory?: string; cpus?: string } } };
};
type ComposeDocument = {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean } | null>;
};

/**
 * Compose's !reset drops the map or sequence it tags, so the file is read as
 * Compose merges it: that value is null. merge: compose.yml starts each
 * service from an anchor with `<<`. Anything yaml warns about fails the read.
 */
function parseCompose(text: string): ComposeDocument {
  const doc = parseDocument(text, {
    merge: true,
    customTags: [
      { tag: "!reset", collection: "map" },
      { tag: "!reset", collection: "seq" },
    ],
  });
  for (const problem of [...doc.errors, ...doc.warnings]) throw problem;
  visit(doc, {
    Collection: (_key, node) =>
      node.tag === "!reset" ? new Scalar(null) : undefined,
  });
  return doc.toJS() as ComposeDocument;
}

function readCompose(file: URL = COMPOSE_FILE): ComposeDocument {
  return parseCompose(readFileSync(file, "utf8"));
}

// These layers change service maps and reset ports; other base fields stay put.
function readDemo(): ComposeDocument {
  const doc = readCompose();
  for (const path of [
    "deploy/dokploy/compose.dokploy.yml",
    "deploy/demo/compose.demo.yml",
  ]) {
    const layer = readCompose(new URL(`../../../../${path}`, import.meta.url));
    for (const [name, service] of Object.entries(layer.services)) {
      const base = doc.services[name];
      doc.services[name] = {
        ...base,
        ...service,
        environment: { ...base?.environment, ...service.environment },
        depends_on: { ...base?.depends_on, ...service.depends_on },
      };
    }
  }
  return doc;
}

/** Compose's own variable, as the demo layer writes it in an image tag. */
const PROJECT_TAG = "$" + "{COMPOSE_PROJECT_NAME}";

function demoViolations(doc: ComposeDocument): string[] {
  const found = violations(
    doc,
    {
      ...NETWORKS_BY_SERVICE,
      "powerbi-mock": ["egress"],
      seed: ["app", "egress"],
    },
    // Tagged per project, so the demo's build never replaces another stack's image.
    [
      `${BUILT_IMAGE}:${PROJECT_TAG}`,
      `powerbi-metrics-book-mock:${PROJECT_TAG}`,
    ],
  );
  for (const [name, service] of Object.entries(doc.services)) {
    const labels = Array.isArray(service.labels)
      ? service.labels
      : Object.entries(service.labels ?? {}).map(
          ([key, value]) => `${key}=${value}`,
        );
    if (
      name !== "api" &&
      labels.some((label) => /traefik\.|Host\(/i.test(label))
    )
      found.push(`${name} has a domain label`);
    if (name === "api" || name === "worker") {
      for (const [key, value] of Object.entries({
        DEMO_MODE: "1",
        NODE_ENV: "production",
      })) {
        if (service.environment?.[key] !== value)
          found.push(`${name} lacks ${key}=${value}`);
      }
    }
  }
  return found;
}

describe("the demo boundary", () => {
  it("rejects a copy of the demo mock with a published port", () => {
    const doc = readDemo();
    serviceOf(doc, "powerbi-mock").ports = ["3001:3001"];
    expect(demoViolations(doc)).toContain("powerbi-mock publishes a port");
  });

  it("opens no boundary and shares only the api identity with the seed", () => {
    const doc = readDemo();
    expect(demoViolations(doc)).toEqual([]);
    expect(serviceOf(doc, "api").ports ?? []).toEqual([]);
    const api = serviceOf(doc, "api");
    const seed = serviceOf(doc, "seed");
    expect(seed.image).toBe(api.image);
    expect(seed.command).toEqual(["server", "sample-seed"]);
    expect(seed.restart).toBe("no");
    expect(seed.environment).toEqual(api.environment);
    // The api's identity volume, mounted read-only: the seed never writes it.
    expect(seed.volumes).toEqual(
      (api.volumes ?? []).map((volume) =>
        typeof volume === "string" ? volume : { ...volume, read_only: true },
      ),
    );
    expect(seed.depends_on).toEqual({
      api: { condition: "service_healthy" },
      worker: { condition: "service_healthy" },
    });
    for (const name of ["api", "worker"]) {
      expect(serviceOf(doc, name).depends_on?.["powerbi-mock"]?.condition).toBe(
        "service_healthy",
      );
    }
  });

  it.each<[string, Partial<Service>, string]>([
    ["worker", { ports: ["9000:9000"] }, "worker publishes a port"],
    [
      "seed",
      {
        labels: {
          "traefik.http.routers.seed.rule": "Host(`demo.example.com`)",
        },
      },
      "seed has a domain label",
    ],
    [
      "worker",
      { labels: ["traefik.enable=true"] },
      "worker has a domain label",
    ],
    [
      "powerbi-mock",
      { networks: ["app", "egress"] },
      "powerbi-mock is on networks app, egress",
    ],
    [
      "seed",
      { networks: ["app", "edge", "egress"] },
      "seed is on networks app, edge, egress",
    ],
    [
      "worker",
      { volumes: ["api_identity:/shared"] },
      "api and worker share api_identity",
    ],
  ])("rejects %s changed to %j", (name, change, expected) => {
    const doc = readDemo();
    Object.assign(serviceOf(doc, name), change);
    expect(demoViolations(doc)).toContain(expected);
  });

  it.each(["api", "worker"])(
    "requires demo production settings on %s",
    (name) => {
      for (const key of ["DEMO_MODE", "NODE_ENV"]) {
        const doc = readDemo();
        const service = serviceOf(doc, name);
        service.environment = { ...service.environment, [key]: "wrong" };
        expect(demoViolations(doc)).toContain(
          `${name} lacks ${key}=${key === "DEMO_MODE" ? "1" : "production"}`,
        );
      }
    },
  );
});

function serviceOf(doc: ComposeDocument, name: string): Service {
  const service = doc.services[name];
  if (service === undefined)
    throw new Error(`compose.yml has no service ${name}`);
  return service;
}

function mountParts(mount: Mount): {
  type: string;
  source: string;
  target: string;
} {
  if (typeof mount === "string") {
    const [source = "", target = ""] = mount.split(":");
    const type =
      source.startsWith(".") || source.startsWith("/") ? "bind" : "volume";
    return { type, source, target };
  }
  return {
    type: mount.type ?? "volume",
    source: mount.source ?? "",
    target: mount.target ?? "",
  };
}

function networksOf(service: Service): string[] {
  return Array.isArray(service.networks)
    ? service.networks
    : Object.keys(service.networks ?? {});
}

/** The services named in volumes_from, as `name`, `name:ro` or `container:name`. */
function volumesFromServices(service: Service | undefined): string[] {
  return (service?.volumes_from ?? []).map((entry) => {
    const [first = "", second = ""] = entry.split(":");
    return first === "container" ? second : first;
  });
}

function namedVolumes(service: Service | undefined): Set<string> {
  return new Set(
    (service?.volumes ?? [])
      .map(mountParts)
      .filter((mount) => mount.type === "volume")
      .map((mount) => mount.source),
  );
}

function hardeningGaps(service: Service): string[] {
  const gaps: string[] = [];
  const user = service.user ?? "";
  if (user === "" || /^(0|root)(:|$)/.test(user)) gaps.push("user");
  if (service.read_only !== true) gaps.push("read_only");
  if ([service.tmpfs ?? []].flat().length === 0) gaps.push("tmpfs");
  if (!service.security_opt?.includes("no-new-privileges:true"))
    gaps.push("security_opt");
  if (
    service.cap_drop?.join() !== "ALL" ||
    (service.cap_add ?? []).length > 0 ||
    service.privileged
  ) {
    gaps.push("cap_drop");
  }
  const limits = service.deploy?.resources?.limits;
  if (!limits?.memory || !limits.cpus) gaps.push("deploy");
  if (!service.healthcheck?.test || service.healthcheck.disable)
    gaps.push("healthcheck");
  return gaps;
}

/** Every boundary the document opens, one line each; empty when it holds. */
function violations(
  doc: ComposeDocument,
  expectedNetworks = NETWORKS_BY_SERVICE,
  builtImages = [BUILT_IMAGE],
): string[] {
  const found: string[] = [];
  for (const [name, service] of Object.entries(doc.services)) {
    // A service on the host's network publishes every port it listens on.
    if (
      name !== "api" &&
      ((service.ports ?? []).length > 0 || service.network_mode !== undefined)
    ) {
      found.push(`${name} publishes a port`);
    }
    const networks = networksOf(service);
    if ([...networks].sort().join() !== (expectedNetworks[name] ?? []).join()) {
      found.push(`${name} is on networks ${networks.join(", ")}`);
    }
    for (const gap of hardeningGaps(service))
      found.push(`${name} lacks ${gap}`);
    if (
      !builtImages.includes(service.image ?? "") &&
      !DIGEST_PINNED.test(service.image ?? "")
    ) {
      found.push(`${name} runs an image not pinned by digest`);
    }
    for (const mount of (service.volumes ?? []).map(mountParts)) {
      if (
        mount.source.includes("docker.sock") ||
        mount.target.includes("docker.sock")
      ) {
        found.push(`${name} mounts the Docker socket`);
      }
    }
  }
  if (doc.networks.app?.internal !== true) found.push("app is not internal");
  for (const volume of namedVolumes(doc.services.api)) {
    if (namedVolumes(doc.services.worker).has(volume))
      found.push(`api and worker share ${volume}`);
  }
  // volumes_from mounts every volume of the other container, identity included.
  for (const [name, other] of [
    ["api", "worker"],
    ["worker", "api"],
  ] as const) {
    if (volumesFromServices(doc.services[name]).includes(other))
      found.push(`${name} takes volumes from ${other}`);
  }
  return found;
}

describe("stack/compose.yml", () => {
  it("opens no boundary", () => {
    const doc = readCompose();
    expect(Object.keys(doc.services).sort()).toEqual(
      Object.keys(NETWORKS_BY_SERVICE).sort(),
    );
    expect(violations(doc)).toEqual([]);
  });

  it("publishes the api's port on loopback only, for the proxy on the same machine", () => {
    const ports = serviceOf(readCompose(), "api").ports ?? [];
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatch(/^127\.0\.0\.1:\$\{PBMB_PORT:-3000\}:3000$/);
  });
});

describe("the rules fail when a boundary opens", () => {
  // The real document with one service changed, checked as a whole.
  function opened(name: string, change: Partial<Service>): string[] {
    const doc = readCompose();
    Object.assign(serviceOf(doc, name), change);
    return violations(doc);
  }
  const socket = "/var/run/docker.sock";

  it.each<[string, Partial<Service>, string]>([
    ["worker", { ports: ["9000:9000"] }, "worker publishes a port"],
    ["postgres", { network_mode: "host" }, "postgres publishes a port"],
    [
      "postgres",
      { networks: ["app", "egress"] },
      "postgres is on networks app, egress",
    ],
    [
      "worker",
      { volumes: ["api_identity:/shared"] },
      "api and worker share api_identity",
    ],
    ["worker", { volumes_from: ["api"] }, "worker takes volumes from api"],
    [
      "api",
      { volumes_from: ["container:worker:ro"] },
      "api takes volumes from worker",
    ],
    [
      "cerbos",
      { image: "ghcr.io/cerbos/cerbos:0.57.0" },
      "cerbos runs an image not pinned by digest",
    ],
    [
      "worker",
      { volumes: [{ type: "bind", source: socket, target: socket }] },
      "worker mounts the Docker socket",
    ],
  ])("%s changed to %j: %s", (name, change, expected) => {
    expect(opened(name, change)).toEqual([expected]);
  });

  it("app is not internal", () => {
    const doc = readCompose();
    doc.networks.app = {};
    expect(violations(doc)).toEqual(["app is not internal"]);
  });

  it.each<[string, Partial<Service>]>([
    ["user", { user: "0:0" }],
    ["read_only", { read_only: false }],
    ["tmpfs", { tmpfs: [] }],
    ["security_opt", { security_opt: [] }],
    ["cap_drop", { cap_add: ["NET_ADMIN"] }],
    ["deploy", { deploy: {} }],
    ["healthcheck", { healthcheck: { disable: true } }],
  ])("a service lacks %s", (key, change) => {
    for (const name of Object.keys(NETWORKS_BY_SERVICE)) {
      expect(opened(name, change)).toEqual([`${name} lacks ${key}`]);
    }
  });
});

describe("a !reset in compose.yml", () => {
  const text = readFileSync(COMPOSE_FILE, "utf8");

  // Compose would drop each of these from the service, as it drops a hardening key.
  it.each<[string, string, string[]]>([
    [
      "security_opt: [no-new-privileges:true]",
      "security_opt: !reset [no-new-privileges:true]",
      Object.keys(NETWORKS_BY_SERVICE).map(
        (name) => `${name} lacks security_opt`,
      ),
    ],
    [
      "cap_drop: [ALL]",
      "cap_drop: !reset [ALL]",
      Object.keys(NETWORKS_BY_SERVICE).map((name) => `${name} lacks cap_drop`),
    ],
    [
      'deploy: { resources: { limits: { memory: 512m, cpus: "1.0" } } }',
      'deploy: !reset { resources: { limits: { memory: 512m, cpus: "1.0" } } }',
      ["api lacks deploy"],
    ],
  ])("fails on a hardening key reset: %s", (line, reset, expected) => {
    expect(text).toContain(line);
    expect(violations(parseCompose(text.replace(line, reset)))).toEqual(
      expected,
    );
  });
});

describe("stack/dev/compose.dev.yml", () => {
  it("keeps the mock on egress only, never on app with postgres and cerbos", () => {
    const mock = serviceOf(readCompose(DEV_OVERLAY), "powerbi-mock");
    expect(networksOf(mock)).toEqual(["egress"]);
  });
});

describe("apps/api/Dockerfile", () => {
  // The docs and the setup screen say `docker compose exec api server setup-link`.
  // exec skips the entry point, so the image needs `server` on PATH, running
  // the same file the entry point runs.
  const dockerfile = readFileSync(
    new URL("../../Dockerfile", import.meta.url),
    "utf8",
  );
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));

  it("puts server on PATH, running the entry point's file, before it drops root", () => {
    const wrapper =
      /RUN printf '#!\/bin\/sh\\nexec node (\S+) server "\$@"\\n' > \/usr\/local\/bin\/server \\\n\s+&& chmod 0755 \/usr\/local\/bin\/server/.exec(
        runtime,
      );
    expect(wrapper, "the RUN that writes /usr/local/bin/server").not.toBeNull();
    const workdir = [...runtime.matchAll(/^WORKDIR (\S+)$/gm)].at(-1)?.[1];
    const entry = /^ENTRYPOINT \["node", "(\S+)"\]$/m.exec(runtime)?.[1];
    expect(wrapper?.[1]).toBe(`${String(workdir)}/${String(entry)}`);
    expect(runtime.indexOf("/usr/local/bin/server")).toBeLessThan(
      runtime.indexOf("USER 10001:10001"),
    );
  });
});
