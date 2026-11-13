import { queryOptions } from "@tanstack/react-query";
import { ApiError, api, read } from "../api/client";
import type { components } from "../api/schema";

export type SignInConfig = components["schemas"]["SignInConfig"];
export type ConsentRequest = components["schemas"]["ConsentRequest"];
export type DeviceRequest = components["schemas"]["DeviceRequest"];
export type Grant = components["schemas"]["Grant"];

export const signInConfigQuery = queryOptions({
  queryKey: ["sign-in-config"],
  queryFn: () => read(api.GET("/api/auth/config")),
});

export const connectionQuery = queryOptions({
  queryKey: ["me", "connection"],
  queryFn: () => read(api.GET("/api/v1/me/connection")),
});

export const grantsQuery = queryOptions({
  queryKey: ["me", "grants"],
  queryFn: () => read(api.GET("/api/v1/me/grants")),
});

/**
 * The consent request, from the query Better Auth signed, sent on byte for
 * byte: the signature covers it as it is. Never cached: each visit asks again,
 * so an expired request says so.
 */
export function consentQuery(signed: string) {
  return queryOptions({
    queryKey: ["oauth-consent", signed],
    queryFn: () =>
      read(api.GET("/api/v1/oauth/consent", { querySerializer: () => signed })),
    staleTime: 0,
    retry: false,
  });
}

/** A call the api answers 204: read() expects a body, so a success without one counts as done. */
export async function sent(
  request: Promise<{ error?: unknown; response: Response }>,
): Promise<void> {
  await read(
    request.then((answer) =>
      answer.response.ok ? { ...answer, data: true } : answer,
    ),
  );
}

/**
 * A call to Better Auth's own routes under /api/auth, which are not in the
 * OpenAPI file and answer errors as { message } rather than the api's shape.
 */
export async function authCall(
  path: string,
  init: { method: "GET" } | { method: "POST"; body: object },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/auth${path}`, {
      method: init.method,
      credentials: "include",
      ...(init.method === "POST"
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(init.body),
          }
        : {}),
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ApiError(
      0,
      "unreachable",
      "Power BI Metrics Book could not be reached. Check your connection, then try again.",
      { cause: error },
    );
  }
  // A route Better Auth does not have (passkeys off) answers 404 with no JSON.
  const isJson = response.headers
    .get("content-type")
    ?.includes("application/json");
  const text = await response.text();
  const body: unknown =
    isJson === true && text !== "" ? JSON.parse(text) : null;
  if (response.ok) return body;
  const message =
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
      ? body.message
      : `Sign-in answered ${String(response.status)} without saying why. Try again; if it happens again, the api's log has the reason.`;
  const code =
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    typeof body.code === "string"
      ? body.code
      : "unknown";
  throw new ApiError(response.status, code, message);
}

/** The address Better Auth answers a sign-in with, when it sends the browser on. */
export function answeredUrl(body: unknown): string | null {
  return typeof body === "object" &&
    body !== null &&
    "url" in body &&
    typeof body.url === "string"
    ? body.url
    : null;
}
