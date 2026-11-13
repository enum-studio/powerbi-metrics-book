import { createRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../api/me";
import { Device } from "../access/device";
import { rootRoute } from "./root";

/** `?user_code=` is never read into the page: the person types the code their own terminal shows. */
const linkCarriedCode = () =>
  new URLSearchParams(window.location.search).has("user_code");

export const deviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  staticData: { focused: true },
  path: "/device",
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.query(meQuery);
    // Back to /device alone: a code in the link stays out of sign-in's next.
    if (me === null) redirect({ href: "/sign-in?next=%2Fdevice", throw: true });
  },
  component: function DeviceScreen() {
    return <Device linkCarriedCode={linkCarriedCode()} />;
  },
});
