import { useMutation, useQuery } from "@tanstack/react-query";
import { roleLabel } from "../admin/access/roles";
import { LINK } from "../admin/layout/ui";
import { formatDate } from "../shell/time";
import { authCall, signInConfigQuery, type SignInConfig } from "./api";
import { providerStart, signInAddress } from "./provider-start";
import { AccessCard, AuthPanel, Button, Problem } from "./parts";
import { ProviderButtons, type Provider } from "./provider-marks";
import { readFragmentToken } from "./fragment-token";
import { authRefusal } from "./refusals";

type InviteLookup =
  | {
      state: "open";
      email: string;
      role: string;
      inviter_name: string;
      expires_at: string;
      password_allowed: boolean;
    }
  | { state: "expired"; inviter_name: string; expires_at: string }
  | { state: "invalid" };

function parseInvite(value: unknown): InviteLookup {
  if (typeof value === "object" && value !== null && "state" in value) {
    if (value.state === "invalid") return { state: "invalid" };
    if (
      "inviter_name" in value &&
      typeof value.inviter_name === "string" &&
      "expires_at" in value &&
      typeof value.expires_at === "string" &&
      Number.isFinite(Date.parse(value.expires_at))
    ) {
      const common = {
        inviter_name: value.inviter_name,
        expires_at: value.expires_at,
      };
      if (value.state === "expired") return { state: "expired", ...common };
      if (
        value.state === "open" &&
        "email" in value &&
        typeof value.email === "string" &&
        "role" in value &&
        typeof value.role === "string" &&
        "password_allowed" in value &&
        typeof value.password_allowed === "boolean"
      ) {
        return {
          state: "open",
          ...common,
          email: value.email,
          role: value.role,
          password_allowed: value.password_allowed,
        };
      }
    }
  }
  throw new Error("The invitation lookup returned an invalid answer.");
}

export function Invite() {
  const token = readFragmentToken();
  const config = useQuery(signInConfigQuery);
  const lookup = useQuery({
    queryKey: ["invite-lookup"],
    queryFn: async () =>
      token === null
        ? { state: "invalid" as const }
        : parseInvite(
            await authCall("/invites/lookup", {
              method: "POST",
              body: { token },
            }),
          ),
    // One lookup per visit: each one counts against the address's rate limit.
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });
  const invite = lookup.data;
  if (invite?.state === "open" && token !== null && config.data)
    return <OpenInvite invite={invite} token={token} config={config.data} />;
  const failure = lookup.error ?? config.error;
  return (
    <AccessCard>
      <h1 className="text-title font-semibold text-ink">Invitation</h1>
      <AuthPanel>
        {failure === null && (lookup.isPending || invite?.state === "open") && (
          <p role="status" className="text-ui text-ink-2">
            Checking invitation...
          </p>
        )}
        {failure !== null && <Problem>{authRefusal(failure)}</Problem>}
        {invite?.state === "expired" && (
          <Problem>
            This invite expired on {formatDate(invite.expires_at)}. Ask{" "}
            {invite.inviter_name} to send a new one.
          </Problem>
        )}
        {invite?.state === "invalid" && (
          <Problem>
            This invite is no longer valid. Sign in, or ask an admin for a new
            one.
          </Problem>
        )}
        <a href="/sign-in" className={LINK}>
          Sign in
        </a>
      </AuthPanel>
    </AccessCard>
  );
}

function OpenInvite({
  invite,
  token,
  config,
}: {
  invite: Extract<InviteLookup, { state: "open" }>;
  token: string;
  config: SignInConfig;
}) {
  const start = useMutation({
    mutationFn: async (provider: Provider) => {
      const answer = await providerStart(provider, "/", null);
      window.location.assign(signInAddress(answer) ?? "/");
    },
  });
  return (
    <AccessCard>
      <h1 className="text-title font-semibold text-ink">
        {invite.inviter_name} invited you to {config.brand.name}
      </h1>
      <AuthPanel>
        <p className="text-ui text-ink-2">
          You will join as {/^[aeiou]/i.test(invite.role) ? "an" : "a"}{" "}
          {roleLabel(invite.role)}.
        </p>
        <p className="text-ui text-ink-2">Sign in as {invite.email}.</p>
        <p className="text-ui text-ink-2">
          This invite expires on {formatDate(invite.expires_at)}.
        </p>
        <ProviderButtons
          providers={config.providers}
          busy={start.isPending}
          onStart={(provider) => {
            start.mutate(provider);
          }}
        />
        {invite.password_allowed && (
          <Button
            kind="secondary"
            disabled={start.isPending}
            onClick={() => {
              window.location.assign(
                `/set-password?kind=invite#token=${encodeURIComponent(token)}`,
              );
            }}
          >
            Set a password
          </Button>
        )}
        {start.error !== null && <Problem>{authRefusal(start.error)}</Problem>}
      </AuthPanel>
    </AccessCard>
  );
}
