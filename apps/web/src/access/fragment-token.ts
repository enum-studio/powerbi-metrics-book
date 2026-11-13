/**
 * /invite and /set-password carry their token in the fragment. It leaves the
 * address before the router is created (createAppRouter), so no answer from
 * /me, an error included, can leave it in the address bar or the history.
 */
let token: string | null = null;

export function captureFragmentToken() {
  const { pathname, search, hash } = window.location;
  if (pathname !== "/invite" && pathname !== "/set-password") return;
  token = new URLSearchParams(hash.slice(1)).get("token");
  window.history.replaceState(window.history.state, "", `${pathname}${search}`);
}

export function readFragmentToken() {
  return token;
}
