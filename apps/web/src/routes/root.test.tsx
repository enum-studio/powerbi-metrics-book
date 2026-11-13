import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { rootRoute } from "./root";
import { signInRoute } from "./sign-in";
import { inviteRoute } from "./invite";
import { setPasswordRoute } from "./set-password";
import { forgotPasswordRoute } from "./forgot-password";

const state = vi.hoisted(() => ({ staticData: {} }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useLocation: () => "/different-path",
  useMatches: ({
    select,
  }: {
    select: (matches: (typeof state)[]) => unknown;
  }) => select([state]),
  Outlet: () => null,
}));
vi.mock("../shell/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => (
    <>
      <header />
      {children}
    </>
  ),
}));
vi.mock("../access/parts", () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}));

it.each([signInRoute, inviteRoute, setPasswordRoute, forgotPasswordRoute])(
  "leaves the header off $path through route metadata",
  (route) => {
    state.staticData = route.options.staticData ?? {};
    const Screen = rootRoute.options.component;
    if (typeof Screen !== "function") throw new Error("Root component missing");
    expect(renderToStaticMarkup(<Screen />)).not.toContain("<header");
  },
);
it("keeps the header on another route", () => {
  state.staticData = { focused: true };
  const Screen = rootRoute.options.component;
  if (typeof Screen !== "function") throw new Error("Root component missing");
  expect(renderToStaticMarkup(<Screen />)).toContain("<header");
});
