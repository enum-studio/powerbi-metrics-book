import { queryOptions, useQuery } from "@tanstack/react-query";
import { ApiError, api, read } from "./client";
import type { components } from "./schema";

export type Me = components["schemas"]["Me"];

/** Who is signed in, or null for nobody: the api answers 401 to a browser without a session. */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<Me | null> => {
    try {
      return await read(api.GET("/api/v1/me"));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
});

/** Whether questions are enabled for this deployment. */
export function useQuestions(): boolean {
  return useQuery(meQuery).data?.questions === true;
}
