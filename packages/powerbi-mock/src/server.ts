import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { controlRoutes } from "./control.js";
import {
  createState,
  setActingUser as selectActingUser,
  type MockState,
} from "./entra/context.js";
import { entraRoutes } from "./entra/routes.js";
import { embeddingRoutes } from "./embeddings/routes.js";
import { graphRoutes } from "./graph/routes.js";
import { oidcRoutes } from "./oidc/routes.js";
import { powerBiRoutes } from "./powerbi/routes.js";
import { resendRoutes, type Outbox } from "./resend.js";
import type { Tenant } from "./tenant.js";

export type MockPowerBiOptions = {
  tenant: Tenant;
  /** The origin the mock's tokens and links name. Without it, each answer names the origin the request came to. */
  origin?: string;
  /** Mounts /_mock, which changes the tenant without a token. */
  control?: boolean;
};

export type MockPowerBiHandle = {
  url: string;
  outbox: Outbox;
  close(): Promise<void>;
  /** The person authorize signs in from now on. */
  setActingUser(object_id: string): void;
  /** The next request whose path starts with route_prefix answers this status once, with a Retry-After header when given. */
  failNext(
    route_prefix: string,
    status: number,
    retry_after_seconds?: number,
  ): void;
};

/** The app with the state it serves, for tests that reach into both. */
export function buildMock(options: MockPowerBiOptions): {
  app: Hono;
  state: MockState;
  outbox: Outbox;
} {
  const state = createState(options.tenant, options.origin);
  const app = new Hono();
  const outbox: Outbox = [];
  app.route("/", resendRoutes(outbox));

  app.get("/health", (c) => c.json({ status: "ok" }));
  if (options.control) app.route("/_mock", controlRoutes(state, outbox));

  app.use(async (c, next) => {
    const index = state.failures.findIndex((failure) =>
      c.req.path.startsWith(failure.route_prefix),
    );
    const [failure] = index === -1 ? [] : state.failures.splice(index, 1);
    if (!failure) return next();
    const headers = new Headers({ "content-type": "application/json" });
    if (failure.retry_after_seconds !== undefined)
      headers.set("retry-after", String(failure.retry_after_seconds));
    const message = `The next request to ${failure.route_prefix} was set to fail with ${String(failure.status)}.`;
    return new Response(
      JSON.stringify({ error: { code: "MockInjectedFailure", message } }),
      { status: failure.status, headers },
    );
  });

  app.route("/", entraRoutes(state));
  app.route("/graph", graphRoutes(state));
  app.route("/oidc", oidcRoutes(state));
  app.route("/powerbi", powerBiRoutes(state));
  app.route("/", embeddingRoutes());
  return { app, state, outbox };
}

export function createMockPowerBi(options: MockPowerBiOptions): Hono {
  return buildMock(options).app;
}

/** Serves the mock on a free port of the loopback interface. */
export async function startMockPowerBi(
  options: MockPowerBiOptions,
): Promise<MockPowerBiHandle> {
  const { app, state, outbox } = buildMock(options);
  const listener = getRequestListener(app.fetch);
  const server = createServer((request, response) => {
    void listener(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The mock did not bind a TCP port.");

  return {
    outbox,
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
    setActingUser(object_id) {
      if (!selectActingUser(state, object_id))
        throw new RangeError(`No person ${object_id} in the tenant.`);
    },
    failNext(route_prefix, status, retry_after_seconds) {
      state.failures.push({ route_prefix, status, retry_after_seconds });
    },
  };
}
