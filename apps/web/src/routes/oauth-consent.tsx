import { createRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../api/me";
import { consentQuery } from "../access/api";
import { Consent, ConsentFailed, NoConsentRequest } from "../access/consent";
import { rootRoute } from "./root";

/**
 * The query Better Auth signed, read from the address bar as it arrived:
 * the router's own parsing could change a byte the signature covers.
 */
const signedQuery = () => window.location.search.slice(1);

export const oauthConsentRoute = createRoute({
  getParentRoute: () => rootRoute,
  staticData: { focused: true },
  path: "/oauth/consent",
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.query(meQuery);
    if (me === null)
      redirect({
        href: `/sign-in?next=${encodeURIComponent(`/oauth/consent${window.location.search}`)}`,
        throw: true,
      });
  },
  loader: async ({ context }) => {
    const signed = signedQuery();
    if (signed !== "") await context.queryClient.query(consentQuery(signed));
  },
  errorComponent: ConsentFailed,
  component: function ConsentScreen() {
    const signed = signedQuery();
    if (signed === "") return <NoConsentRequest />;
    return <Consent signed={signed} />;
  },
});
