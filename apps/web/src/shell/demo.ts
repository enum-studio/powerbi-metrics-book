import { useQuery } from "@tanstack/react-query";
import { signInConfigQuery } from "../access/api";

/** True on the public demo: read-only, no sign-in, nothing that writes is shown. Read from the auth config, which the root route loads and the Shell waits for before any control draws. */
export function useDemo(): boolean {
  return useQuery(signInConfigQuery).data?.demo === true;
}
