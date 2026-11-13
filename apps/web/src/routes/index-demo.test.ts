import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { signInConfigQuery } from "../access/api";
import { meQuery } from "../api/me";
import { configWith } from "../shell/brand-test-support";
import { indexRoute } from "./index";

async function enter(demo: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  queryClient.setQueryData(meQuery.queryKey, null);
  queryClient.setQueryData(signInConfigQuery.queryKey, {
    ...configWith({ name: "M", company: null, logo_url: null, custom: false }),
    demo,
  });
  const before = indexRoute.options.beforeLoad;
  if (before === undefined) throw new Error("no beforeLoad");
  try {
    await before({ context: { queryClient } } as never);
    return null;
  } catch (thrown) {
    return thrown;
  }
}

it("sends nobody signed in to sign in, except on the demo", async () => {
  expect(await enter(false)).toMatchObject({ options: { href: "/sign-in" } });
  expect(await enter(true)).toBeNull();
});
