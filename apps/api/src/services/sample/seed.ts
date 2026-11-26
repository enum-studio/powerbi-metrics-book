import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { createApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { buildDeps } from "../../deps.js";
import { isMockHost } from "../../http/fetcher.js";
import { refuseDemoOffTheSample } from "../demo/locks.js";
import { onTheMock } from "../auth/sign-in-config.js";
import type { Environment } from "../settings/env.js";
import { newSetupLink } from "../setup/link.js";
import { seedSampleBook, seedSampleDocs, type Send } from "./book.js";
import { seedSampleReadingPage } from "./reading.js";
import { SAMPLE } from "./tenant.js";

const SYNC_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STEPS = [
  "what_to_sync",
  "sign_in",
  "who_gets_in",
  "search",
  "agents",
  "security",
];

const ADMIN = "admin@sample.example";

const resultSchema = z.object({
  status: z.string(),
  message: z.string().nullable(),
  pending: z.boolean().optional(),
  action: z.string().optional(),
  confirm: z.object({ email: z.string() }).optional(),
  details: z
    .looseObject({
      items: z
        .array(
          z.object({
            item: z.string(),
            status: z.string(),
            sentence: z.string(),
          }),
        )
        .optional(),
    })
    .optional(),
});
const stateSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      passed: z.boolean(),
      check: z.object({ message: z.string().nullable() }).nullable(),
    }),
  ),
});
const secretValue = (value: string) => ({
  value,
  expires_at: "2099-12-31T00:00:00Z",
});

type Item = NonNullable<
  NonNullable<z.infer<typeof resultSchema>["details"]>["items"]
>[number];
type SetupState = z.infer<typeof stateSchema>;

/** The last line: how many steps pass, and each open step with its check's sentence and failing items. */
export function setupLine(
  state: SetupState,
  checklists: ReadonlyMap<string, readonly Item[]>,
): string {
  const open = state.steps
    .filter((each) => !each.passed)
    .flatMap(({ id, check }) => [
      `${id}: ${check?.message ?? "not run"}`,
      ...(checklists.get(id) ?? [])
        .filter((item) => item.status === "failing")
        .map((item) => `${item.item}: ${item.sentence}`),
    ]);
  return `Setup: ${String(state.steps.filter((each) => each.passed).length)} of ${String(state.steps.length)} steps pass. Open: ${open.length === 0 ? "none" : open.join("; ")}`;
}

async function answered(
  response: Response,
  status: number,
  what: string,
): Promise<Response> {
  if (response.status !== status)
    throw new Error(
      `${what}: the api answered ${String(response.status)}: ${await response.text()}`,
    );
  return response;
}

/**
 * Runs as a browser against an app of its own, built without the demo's
 * read-only rule even in the demo's environment, so only this process can
 * write through it.
 */
export async function seedSample(
  env: Environment,
  print: (line: string) => void,
): Promise<void> {
  const config = loadConfig(env, "api");
  const deps = await buildDeps(config, env);
  const signedIn: Send[] = [];
  try {
    await refuseDemoOffTheSample(deps);
    const authority = await deps.settings.get("powerbi.authority");
    if (!onTheMock(authority))
      throw new Error("sample-seed runs only on the mock tenant.");
    const mockOrigin = new URL(authority).origin;
    const origin = config.public_base_url.origin;
    const app = createApp(deps, { serveDemo: false });
    function browser(): Send {
      const jar = new Map<string, { value: string; path: string }>();
      return async (target, { method = "GET", json } = {}) => {
        const url = new URL(target, origin);
        if (url.origin !== origin && url.origin !== mockOrigin)
          throw new Error(
            `sample-seed refused a redirect outside the api and mock: ${url.origin}`,
          );
        const headers = new Headers();
        if (method !== "GET") headers.set("origin", origin);
        if (json !== undefined) headers.set("content-type", "application/json");
        if (url.origin === origin) {
          const cookie = [...jar]
            .filter(([, c]) => url.pathname.startsWith(c.path))
            .map(([name, c]) => `${name}=${c.value}`)
            .join("; ");
          if (cookie !== "") headers.set("cookie", cookie);
        }
        const body = json === undefined ? undefined : JSON.stringify(json);
        // The mock's authorize GETs answer with a redirect the seed follows itself.
        const response =
          url.origin === origin
            ? await app.request(
                new Request(url, { method, headers, body, redirect: "manual" }),
              )
            : await deps.fetcher.fetchFixed(url, {
                method,
                headers,
                body,
                redirect: method === "GET" ? "return" : "refuse",
              });
        if (url.origin === origin)
          for (const line of response.headers.getSetCookie()) {
            const pair = /^([^=]+)=([^;]*)/.exec(line);
            const name = pair?.[1];
            const value = pair?.[2];
            if (name === undefined || value === undefined)
              throw new Error("The api set a malformed cookie.");
            if (value === "") jar.delete(name);
            else
              jar.set(name, {
                value,
                path: /;\s*path=([^;]+)/i.exec(line)?.[1] ?? "/",
              });
          }
        return response;
      };
    }
    const web = browser();
    async function step(id: string, input: object = {}) {
      const response = await answered(
        await web(`/api/setup/steps/${id}`, { method: "POST", json: input }),
        200,
        `The ${id} step`,
      );
      return resultSchema.parse(await response.json());
    }
    function passing(result: z.infer<typeof resultSchema>, id: string) {
      if (result.status !== "passing")
        throw new Error(
          `The ${id} step does not pass: ${String(result.message)}`,
        );
    }
    async function settled(id: string, input: object) {
      print(`Setup: ${id}`);
      let result = await step(id, input);
      const deadline = Date.now() + SYNC_TIMEOUT_MS;
      while (result.pending === true) {
        if (Date.now() > deadline)
          throw new Error(
            `The ${id} step did not finish in time: ${String(result.message)}`,
          );
        await sleep(2000);
        result = await step(id);
      }
      return result;
    }
    async function authorizeAt(send: Send, url: string, objectId: string) {
      await answered(
        await send(`${mockOrigin}/_mock/acting-user`, {
          method: "POST",
          json: { object_id: objectId },
        }),
        204,
        "The mock's acting user",
      );
      const authorized = await answered(
        await send(url),
        302,
        "Microsoft's authorization",
      );
      const back = authorized.headers.get("location");
      if (back === null)
        throw new Error("Microsoft did not send the sign-in back to the api.");
      const callback = await answered(
        await send(back),
        302,
        "Microsoft's callback",
      );
      const location = callback.headers.get("location");
      if (location === null)
        throw new Error(
          "Microsoft's callback did not redirect back to the app.",
        );
      const returned = new URL(location, origin);
      const error = returned.searchParams.get("error");
      if (error !== null)
        throw new Error(`Microsoft's callback failed: ${error}`);
    }
    async function signIn(send: Send, objectId: string) {
      const started = await answered(
        await send("/api/auth/sign-in/social", {
          method: "POST",
          json: { provider: "microsoft", callbackURL: "/setup" },
        }),
        200,
        "Sign-in",
      );
      const { url } = z.object({ url: z.string() }).parse(await started.json());
      await authorizeAt(send, url, objectId);
      signedIn.push(send);
    }
    const state = async () =>
      stateSchema.parse(
        await (
          await answered(await web("/api/setup"), 200, "The setup state")
        ).json(),
      );
    const link = await newSetupLink(deps, { revoke_earlier: true });
    if (link !== null) {
      print("Setup: first admin");
      const token = new URLSearchParams(new URL(link).hash.slice(1)).get(
        "token",
      );
      await answered(
        await web("/api/setup/session", { method: "POST", json: { token } }),
        204,
        "The setup link",
      );
      passing(await step("address"), "address");
      const registered = await step("app_registration", {
        settings: {
          "powerbi.tenant_id": SAMPLE.tenant_id,
          "powerbi.app_client_id": SAMPLE.app.client_id,
        },
        secrets: { powerbi_app_client_secret: secretValue(SAMPLE.app.secret) },
      });
      if (registered.action !== "sign_in")
        throw new Error(
          `The app_registration step: ${String(registered.message)}`,
        );
      await signIn(web, SAMPLE.people[ADMIN]);
      const { confirm } = await step("app_registration");
      if (confirm?.email !== ADMIN)
        throw new Error(
          "The app_registration step did not ask to confirm the sample admin.",
        );
      await step("app_registration", { confirm_email: confirm.email });
    } else {
      print("Setup: sign in the sample admin");
      await signIn(web, SAMPLE.people[ADMIN]);
    }
    const initial = await state();
    const passed = (id: string) =>
      initial.steps.some((each) => each.id === id && each.passed);
    if (!passed("app_registration")) {
      print("Setup: Power BI connection");
      const started = await answered(
        await web("/api/v1/powerbi/connect?next=/setup"),
        302,
        "Connecting Power BI",
      );
      const url = started.headers.get("location");
      if (url === null)
        throw new Error("Connecting Power BI did not redirect to Microsoft.");
      await authorizeAt(web, url, SAMPLE.people[ADMIN]);
      passing(await step("app_registration"), "app_registration");
    }
    if (!passed("scanner"))
      passing(
        await settled("scanner", {
          settings: { "powerbi.scanner_client_id": SAMPLE.scanner.client_id },
          secrets: {
            powerbi_scanner_client_secret: secretValue(SAMPLE.scanner.secret),
          },
        }),
        "scanner",
      );
    if (!passed("first_sync"))
      passing(await settled("first_sync", { start_sync: true }), "first_sync");
    const checklists = new Map<string, Item[]>();
    const embeddings = await deps.settings.get("search.base_url");
    const embedOnMock =
      deps.config.demo_mode &&
      embeddings !== null &&
      isMockHost(new URL(embeddings).hostname) &&
      (await deps.settings.get("search.provider")) === "none";
    const inputs: Record<string, object> = {
      what_to_sync: { start_check: true },
      search: embedOnMock
        ? {
            settings: { "search.provider": "openai" },
            secrets: { openai_api_key: secretValue(SAMPLE.embedding_key) },
          }
        : {},
    };
    for (const id of DEFAULT_STEPS)
      if (!passed(id)) {
        const result = await settled(id, inputs[id] ?? {});
        checklists.set(id, result.details?.items ?? []);
      }
    print(await seedSampleBook(web));
    print(await seedSampleDocs(web));
    const listed = z
      .object({ items: z.array(z.object({ id: z.string() })) })
      .parse(
        await (
          await answered(
            await web("/api/v1/datasets?limit=200"),
            200,
            "Listing datasets",
          )
        ).json(),
      );
    let read = 0;
    for (const { id } of listed.items) {
      const dataset = z
        .object({ relationships_read_at: z.string().nullable() })
        .parse(
          await (
            await answered(
              await web(`/api/v1/datasets/${id}`),
              200,
              "Opening a dataset",
            )
          ).json(),
        );
      if (dataset.relationships_read_at !== null) read++;
    }
    print(
      `Relationships read for ${String(read)} of ${String(listed.items.length)} datasets`,
    );
    print("Assign the sample viewer role");
    const assignments = z
      .object({
        roles: z.array(
          z.object({
            role: z.string(),
            subject_kind: z.string(),
            subject: z.string().nullable(),
          }),
        ),
      })
      .parse(
        await (
          await answered(await web("/api/v1/admin/roles"), 200, "Listing roles")
        ).json(),
      );
    for (const [email, role] of [
      ["viewer@sample.example", "viewer"],
      ["analyst@sample.example", "curator"],
      ["leader@sample.example", "viewer"],
    ] as const) {
      if (
        !assignments.roles.some(
          (assignment) =>
            assignment.role === role &&
            assignment.subject_kind === "person" &&
            assignment.subject === email,
        )
      )
        await answered(
          await web("/api/v1/admin/roles", {
            method: "POST",
            json: { role, subject_kind: "person", subject: email },
          }),
          201,
          "Assigning a sample role",
        );
      await signIn(browser(), SAMPLE.people[email]);
    }
    print(await seedSampleReadingPage(web));
    const final = await state();
    print(setupLine(final, checklists));
  } finally {
    for (const send of signedIn)
      try {
        await answered(
          await send("/api/auth/sign-out", { method: "POST", json: {} }),
          200,
          "Signing out",
        );
      } catch (error) {
        print(`Signing out failed: ${String(error)}`);
      }
    await deps.close();
  }
}
