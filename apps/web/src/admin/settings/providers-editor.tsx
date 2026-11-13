import { useId } from "react";
import { CopyButton } from "../../shell/copy-button";
import { Button, INPUT, Label } from "../layout/ui";

export type Provider = {
  id: string;
  kind: "google" | "oidc";
  label: string;
  client_id: string;
  issuer: string | null;
};

/** The redirect URIs the api sends, by way of signing in. */
export type RedirectUris = {
  microsoft: string[];
  google: string[];
  oidc: string[];
};

export function isProvider(value: unknown): value is Provider {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "kind" in value &&
    "label" in value &&
    "client_id" in value &&
    "issuer" in value
  );
}

/** Microsoft has two redirect URIs; each is named by what Microsoft sends the person back for. */
export function uriPurpose(uri: string): { label: string; hint: string } {
  const path = new URL(uri).pathname;
  if (path === "/api/auth/callback/microsoft")
    return {
      label: "Sign-in redirect URI",
      hint: "Paste this into the app registration. Microsoft sends people back here after they sign in.",
    };
  if (path === "/api/v1/powerbi/callback")
    return {
      label: "Power BI connection redirect URI",
      hint: "Paste this into the app registration too. Microsoft sends people back here after they connect Power BI.",
    };
  return {
    label: "Redirect URI",
    hint: "Paste this into the provider as a redirect URI.",
  };
}

function CopyRow({ uri }: { uri: string }) {
  const id = useId();
  const { label, hint } = uriPurpose(uri);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} hint={hint}>
        {label}
      </Label>
      <div className="flex gap-2">
        <input id={id} readOnly value={uri} className={`${INPUT} font-mono`} />
        <CopyButton text={uri} label={`Copy the ${label}`} />
      </div>
    </div>
  );
}

function Row({
  provider,
  saved,
  uris,
  onChange,
  onRemove,
}: {
  provider: Provider;
  /** Saved already: its id names its secret, so it can no longer change. */
  saved: boolean;
  uris: string[];
  onChange: (next: Provider) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const set = (patch: Partial<Provider>) => {
    onChange({ ...provider, ...patch });
  };
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ui font-semibold text-ink">
          {provider.label || provider.id}
        </h3>
        <Button onClick={onRemove}>Remove</Button>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-label`}>Name on the sign-in page</Label>
        <input
          id={`${id}-label`}
          value={provider.label}
          className={INPUT}
          onChange={(event) => {
            set({ label: event.target.value });
          }}
        />
      </div>
      {provider.kind === "oidc" && (
        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor={`${id}-id`}
            hint={
              saved
                ? "Fixed once saved: a new id would delete the provider's secret."
                : "Lower case letters, digits and underscores. It names the provider's secret, so it cannot change once saved."
            }
          >
            Id
          </Label>
          <input
            id={`${id}-id`}
            value={provider.id}
            readOnly={saved}
            spellCheck={false}
            className={`${INPUT} font-mono ${saved ? "text-ink-3" : ""}`}
            onChange={(event) => {
              set({ id: event.target.value });
            }}
          />
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-client`}>Client id</Label>
        <input
          id={`${id}-client`}
          value={provider.client_id}
          spellCheck={false}
          autoComplete="off"
          className={`${INPUT} font-mono`}
          onChange={(event) => {
            set({ client_id: event.target.value });
          }}
        />
      </div>
      {provider.kind === "oidc" && (
        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor={`${id}-issuer`}
            hint="The address that serves /.well-known/openid-configuration."
          >
            Issuer
          </Label>
          <input
            id={`${id}-issuer`}
            value={provider.issuer ?? ""}
            spellCheck={false}
            className={`${INPUT} font-mono`}
            onChange={(event) => {
              set({ issuer: event.target.value });
            }}
          />
        </div>
      )}
      {uris.map((uri) => (
        <CopyRow key={uri} uri={uri} />
      ))}
    </li>
  );
}

/** Microsoft, always on, then the providers added besides it; each one's secret is set in its own row below the form. */
export function ProvidersEditor({
  providers,
  savedIds,
  redirectUris,
  onChange,
}: {
  providers: Provider[];
  savedIds: readonly string[];
  redirectUris: RedirectUris;
  onChange: (providers: Provider[]) => void;
}) {
  const hasGoogle = providers.some((p) => p.kind === "google");
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y divide-line">
        <li className="flex flex-col gap-3 pb-4">
          <h3 className="text-ui font-semibold text-ink">Microsoft</h3>
          <p className="text-meta text-ink-2">
            Always on. It is how people connect Power BI, so it cannot be turned
            off. Its client id and secret are the app registration's, on the
            Power BI page. Add both redirect URIs to that app registration.
          </p>
          {redirectUris.microsoft.map((uri) => (
            <CopyRow key={uri} uri={uri} />
          ))}
        </li>
        {providers.map((provider, index) => (
          <Row
            key={index}
            provider={provider}
            saved={savedIds.includes(provider.id)}
            uris={redirectUris[provider.kind]}
            onChange={(next) => {
              onChange(providers.map((p, i) => (i === index ? next : p)));
            }}
            onRemove={() => {
              onChange(providers.filter((_, i) => i !== index));
            }}
          />
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={hasGoogle}
          onClick={() => {
            onChange([
              ...providers,
              {
                id: "google",
                kind: "google",
                label: "Google",
                client_id: "",
                issuer: null,
              },
            ]);
          }}
        >
          Add Google
        </Button>
        <Button
          onClick={() => {
            onChange([
              ...providers,
              { id: "", kind: "oidc", label: "", client_id: "", issuer: "" },
            ]);
          }}
        >
          Add an OpenID Connect provider
        </Button>
      </div>
    </div>
  );
}
