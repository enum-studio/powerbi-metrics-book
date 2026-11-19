import { queryOptions } from "@tanstack/react-query";
import { ApiError, api, failed, read } from "../../api/client";
import type { components, operations } from "../../api/schema";
import { ADMIN_KEY } from "../settings/api";

export type RoleAssignment = components["schemas"]["AdminRoleAssignment"];
export type ServiceAccount = components["schemas"]["AdminServiceAccount"];
export type ApiKey = components["schemas"]["AdminApiKey"];
export type NewApiKey = components["schemas"]["AdminNewApiKey"];
export type AuditEvent = components["schemas"]["AdminAuditEvent"];
export type Person =
  operations["getApiV1AdminPeople"]["responses"][200]["content"]["application/json"]["people"][number];
export type NewAssignment = NonNullable<
  operations["postApiV1AdminRoles"]["requestBody"]
>["content"]["application/json"];
export type NewServiceAccount = NonNullable<
  operations["postApiV1AdminServiceAccounts"]["requestBody"]
>["content"]["application/json"];

/** The api's own refusals (401 to 404) are answers, not faults: asking again changes nothing. */
const retry = (count: number, error: unknown) =>
  !(error instanceof ApiError && error.status > 0 && error.status < 500) &&
  count < 2;

export const AUDIT_PAGE = 25;

export const rolesQuery = queryOptions({
  retry,
  queryKey: [...ADMIN_KEY, "roles"],
  queryFn: async () => (await read(api.GET("/api/v1/admin/roles"))).roles,
});

export const peopleQuery = queryOptions({
  retry,
  queryKey: [...ADMIN_KEY, "people"],
  queryFn: async () => (await read(api.GET("/api/v1/admin/people"))).people,
});

export const serviceAccountsQuery = queryOptions({
  retry,
  queryKey: [...ADMIN_KEY, "service-accounts"],
  queryFn: async () =>
    (await read(api.GET("/api/v1/admin/service-accounts"))).service_accounts,
});

export const keysQuery = (name: string) =>
  queryOptions({
    retry,
    queryKey: [...ADMIN_KEY, "service-accounts", name, "keys"],
    queryFn: async () =>
      (
        await read(
          api.GET("/api/v1/admin/service-accounts/{name}/keys", {
            params: { path: { name } },
          }),
        )
      ).keys,
  });

export type AuditFilter = {
  principal: string;
  action: string;
  /** A date, as the date field holds it: the events from its first moment on. */
  since: string;
  /** The ids that began the pages before this one. */
  before_id?: number;
};

export const auditQuery = (filter: AuditFilter) =>
  queryOptions({
    retry,
    queryKey: [...ADMIN_KEY, "audit", filter],
    queryFn: async () =>
      (
        await read(
          api.GET("/api/v1/admin/audit", {
            params: {
              query: {
                limit: AUDIT_PAGE,
                principal: filter.principal || undefined,
                action: filter.action || undefined,
                since:
                  filter.since === "" ? undefined : `${filter.since}T00:00:00Z`,
                before_id: filter.before_id,
              },
            },
          }),
        )
      ).events,
  });

export const conventionsQuery = queryOptions({
  retry,
  queryKey: ["conventions"],
  queryFn: () => read(api.GET("/api/v1/conventions")),
});

export type ConventionVersion =
  operations["getApiV1ConventionsVersions"]["responses"][200]["content"]["application/json"]["versions"][number];
export const conventionVersionsQuery = queryOptions({
  retry,
  queryKey: ["conventions", "versions"],
  queryFn: async () =>
    (await read(api.GET("/api/v1/conventions/versions"))).versions,
});

export type ConventionRule =
  operations["getApiV1ConventionsRules"]["responses"][200]["content"]["application/json"]["rules"][number];
export const conventionRulesQuery = queryOptions({
  retry,
  queryKey: ["conventions", "rules"],
  queryFn: async () => (await read(api.GET("/api/v1/conventions/rules"))).rules,
});

export type CompanyPart =
  operations["getApiV1ConventionsCompany"]["responses"][200]["content"]["application/json"];
export const conventionCompanyQuery = queryOptions({
  retry,
  queryKey: ["conventions", "company"],
  queryFn: () => read(api.GET("/api/v1/conventions/company")),
});

export const assignRole = (body: NewAssignment) =>
  read(api.POST("/api/v1/admin/roles", { body }));

/** The api answers 204, which `read` takes for no data, so these read the answer's status themselves. */
async function done(
  request: Promise<{ response: Response; error?: unknown }>,
): Promise<void> {
  const { response, error } = await request;
  if (response.ok) return;
  throw failed(response.status, error);
}

export const revokeRole = (id: string) =>
  done(api.DELETE("/api/v1/admin/roles/{id}", { params: { path: { id } } }));

export const revokeGrant = (id: string) =>
  done(api.DELETE("/api/v1/admin/grants/{id}", { params: { path: { id } } }));

export const createServiceAccount = (body: NewServiceAccount) =>
  read(api.POST("/api/v1/admin/service-accounts", { body }));

export const setDisabled = (name: string, disabled: boolean) =>
  read(
    api.PATCH("/api/v1/admin/service-accounts/{name}", {
      params: { path: { name } },
      body: { disabled },
    }),
  );

export const deleteServiceAccount = (name: string) =>
  done(
    api.DELETE("/api/v1/admin/service-accounts/{name}", {
      params: { path: { name } },
    }),
  );

export const createKey = (name: string, expires_in_days: number) =>
  read(
    api.POST("/api/v1/admin/service-accounts/{name}/keys", {
      params: { path: { name } },
      body: { expires_in_days },
    }),
  );

export const revokeKey = (name: string, id: string) =>
  done(
    api.DELETE("/api/v1/admin/service-accounts/{name}/keys/{id}", {
      params: { path: { name, id } },
    }),
  );

export type InviteRequest = NonNullable<
  operations["postApiV1AdminPeopleInvites"]["requestBody"]
>["content"]["application/json"];
export const invitePeople = (body: InviteRequest) =>
  read(api.POST("/api/v1/admin/people/invites", { body }));
export type Invite =
  operations["getApiV1AdminPeopleInvites"]["responses"][200]["content"]["application/json"]["invites"][number];
/** The open invites, and whether the api can email one. */
export const invitesQuery = queryOptions({
  queryKey: [...ADMIN_KEY, "invites"],
  retry,
  queryFn: () => read(api.GET("/api/v1/admin/people/invites")),
});
export const resendInvite = (id: string) =>
  read(
    api.POST("/api/v1/admin/people/invites/{id}/resend", {
      params: { path: { id } },
    }),
  );
export const revokeInvite = (id: string) =>
  done(
    api.DELETE("/api/v1/admin/people/invites/{id}", {
      params: { path: { id } },
    }),
  );
export const setPersonRole = (
  id: string,
  role: "viewer" | "curator" | "admin",
) =>
  done(
    api.PUT("/api/v1/admin/people/{id}/role", {
      params: { path: { id } },
      body: { role },
    }),
  );
export const setPersonPii = (id: string, allowed: boolean) =>
  done(
    api.PUT("/api/v1/admin/people/{id}/pii", {
      params: { path: { id } },
      body: { allowed },
    }),
  );
export const deactivatePerson = (id: string) =>
  done(
    api.POST("/api/v1/admin/people/{id}/deactivate", {
      params: { path: { id } },
    }),
  );
export const signOutPerson = (id: string) =>
  done(
    api.POST("/api/v1/admin/people/{id}/sign-out", {
      params: { path: { id } },
    }),
  );
export const reactivatePerson = (id: string) =>
  done(
    api.POST("/api/v1/admin/people/{id}/reactivate", {
      params: { path: { id } },
    }),
  );
export const deletePerson = (id: string) =>
  done(api.DELETE("/api/v1/admin/people/{id}", { params: { path: { id } } }));
