import { queryOptions } from "@tanstack/react-query";
import { ApiError, api, read } from "../api/client";
import type { operations, paths } from "../api/schema";

/** The setup API (apps/api/src/routes/setup.ts): outside /api/v1, and answering 404 to anyone setup is not for. */

export type StepPath = Extract<keyof paths, `/api/setup/steps/${string}`>;
export type StepId = StepPath extends `/api/setup/steps/${infer Id}`
  ? Id
  : never;
export type SetupState =
  operations["getApiSetup"]["responses"][200]["content"]["application/json"];
export type StepState = SetupState["steps"][number];
export type Field = StepState["fields"][number];
export type StepInput = NonNullable<
  operations["postApiSetupStepsAddress"]["requestBody"]
>["content"]["application/json"];
export type StepAnswer =
  operations["postApiSetupStepsAddress"]["responses"][200]["content"]["application/json"];

/** The state, or null when there is no setup here for this browser. */
export const setupQuery = queryOptions({
  queryKey: ["setup"],
  // The setup API's rate limit refuses for a few seconds; asking again then is
  // the answer, where any other refusal is final.
  retry: (count, error) =>
    error instanceof ApiError && error.kind === "rate_limited" && count < 6,
  retryDelay: 10_000,
  queryFn: async (): Promise<SetupState | null> => {
    try {
      return await read(api.GET("/api/setup"));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
});

/** A call the api answers 204 with no body, which read() would take for data that never came; its failures as read() gives them. */
export async function done(
  request: Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<void> {
  await read(
    request.then((answer) =>
      answer.response.status === 204
        ? { response: answer.response, data: true }
        : answer,
    ),
  );
}

async function spend(token: string): Promise<boolean> {
  try {
    await done(api.POST("/api/setup/session", { body: { token } }));
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

/** The spending of a link's token, while it is under way. */
let opening: Promise<boolean> | null = null;

/**
 * Spends the link's token in the fragment, which the setup API turns into
 * the setup session's cookie: true when it opened one, false for a token it
 * refuses. The token leaves the address bar and the history before anything
 * is sent, so a request that fails leaves it in neither. A route load while
 * it is under way (a hash change loads the route twice) gets the same answer;
 * null when there is no token and none under way.
 */
export function openSetupSession(): Promise<boolean> | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (token !== null) {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    opening = spend(token).finally(() => {
      opening = null;
    });
  }
  return opening;
}

export const runStep = (id: StepId, body: StepInput): Promise<StepAnswer> =>
  read(api.POST(`/api/setup/steps/${id}`, { body }));

/**
 * Where the step sends the browser next: Microsoft's sign-in, which Better
 * Auth starts outside the api's OpenAPI and answers with the address to go
 * to, or the Power BI connection, which is a page of its own.
 */
export async function follow(
  next: NonNullable<StepAnswer["next"]>,
): Promise<void> {
  if (next.method === "GET") {
    window.location.assign(next.path);
    return;
  }
  const response = await fetch(next.path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(next.body ?? {}),
  });
  const answer: unknown = response.ok ? await response.json() : null;
  if (
    typeof answer !== "object" ||
    answer === null ||
    !("url" in answer) ||
    typeof answer.url !== "string"
  )
    throw new ApiError(
      response.status,
      "unknown",
      `Microsoft's sign-in did not start: the server answered ${String(response.status)}. Run the check again; if it repeats, the api's log has the reason.`,
    );
  window.location.assign(answer.url);
}
