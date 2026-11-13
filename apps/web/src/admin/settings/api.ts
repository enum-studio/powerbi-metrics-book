import { queryOptions } from "@tanstack/react-query";
import { ApiError, api, read } from "../../api/client";
import type { components } from "../../api/schema";

export type Setting = components["schemas"]["AdminSetting"];
export type Secret = components["schemas"]["AdminSecret"];
export type Check = components["schemas"]["AdminCheck"];
export type SyncRun = components["schemas"]["AdminSyncRun"];

/** Everything under ["admin"] is refetched after a write or a check, so the band and every page agree. */
export const ADMIN_KEY = ["admin"] as const;

/** The api's own refusals (401 to 404) are answers, not faults: asking again changes nothing. */
const retry = (count: number, error: unknown) =>
  !(error instanceof ApiError && error.status > 0 && error.status < 500) &&
  count < 2;

export const settingQuery = (key: string) =>
  queryOptions({
    retry,
    queryKey: [...ADMIN_KEY, "setting", key],
    queryFn: () =>
      read(
        api.GET("/api/v1/admin/settings/{key}", {
          params: { path: { key } },
        }),
      ),
  });

export const secretsQuery = queryOptions({
  retry,
  queryKey: [...ADMIN_KEY, "secrets"],
  queryFn: async () => (await read(api.GET("/api/v1/admin/secrets"))).secrets,
});

export const statusQuery = queryOptions({
  retry,
  queryKey: [...ADMIN_KEY, "status"],
  queryFn: () => read(api.GET("/api/v1/admin/status")),
});

export const runsQuery = queryOptions({
  retry,
  queryKey: [...ADMIN_KEY, "runs"],
  queryFn: async () =>
    (
      await read(
        api.GET("/api/v1/admin/sync", { params: { query: { limit: 10 } } }),
      )
    ).runs,
});

export const putSetting = (
  key: string,
  value: unknown,
  save_failing: boolean,
) =>
  read(
    api.PUT("/api/v1/admin/settings/{key}", {
      params: { path: { key } },
      body: { value, save_failing },
    }),
  );

/** Not a mutation hook: the value lives in the caller's closure until it is sent, and TanStack would keep it in the mutation cache. */
export const putSecret = (
  name: string,
  value: string,
  expires_at: string | null,
) =>
  read(
    api.PUT("/api/v1/admin/secrets/{name}", {
      params: { path: { name } },
      body: { value, expires_at },
    }),
  );

export const putSecretExpiry = (name: string, expires_at: string | null) =>
  read(
    api.PUT("/api/v1/admin/secrets/{name}/expiry", {
      params: { path: { name } },
      body: { expires_at },
    }),
  );

export const runCheck = (name: string) =>
  read(api.POST("/api/v1/admin/checks/{name}", { params: { path: { name } } }));

export const startSync = () =>
  read(api.POST("/api/v1/admin/sync", { body: {} }));
