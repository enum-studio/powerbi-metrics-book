import { KeyRound } from "lucide-react";
import { useState } from "react";
import { unlessRefused } from "../shell/storage";
import type { SignInConfig } from "./api";
import { Button } from "./parts";

export type Provider = SignInConfig["providers"][number];
const LAST_USED = "pbmb:last-sign-in-provider";

function lastProvider(): string | null {
  return unlessRefused(() => window.localStorage.getItem(LAST_USED));
}

function ProviderMark({ kind }: { kind: Provider["kind"] }) {
  if (kind === "oidc")
    return <KeyRound size={16} strokeWidth={1.5} aria-hidden="true" />;
  if (kind === "microsoft")
    return (
      <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
        <path fill="#F25022" d="M0 0h10v10H0z" />
        <path fill="#7FBA00" d="M11 0h10v10H11z" />
        <path fill="#00A4EF" d="M0 11h10v10H0z" />
        <path fill="#FFB900" d="M11 11h10v10H11z" />
      </svg>
    );
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.4a5.5 5.5 0 0 1-2.4 3.6v3h3.8c2.3-2.1 3.7-5.2 3.7-8.8Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 5.9-1.1 7.8-2.9l-3.8-3c-1.1.7-2.4 1.1-4 1.1-3.1 0-5.8-2.1-6.7-5H1.4v3.1A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.3 14.2a7.2 7.2 0 0 1 0-4.4V6.7H1.4a12 12 0 0 0 0 10.6Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.8c1.8 0 3.3.6 4.5 1.8l3.4-3.4A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.4 6.7l3.9 3.1c.9-2.9 3.6-5 6.7-5Z"
      />
    </svg>
  );
}

export function ProviderButtons({
  providers,
  busy,
  onStart,
}: {
  providers: Provider[];
  busy: boolean;
  onStart: (provider: Provider) => void;
}) {
  const [last, setLast] = useState(lastProvider);
  return providers.map((provider) => (
    <Button
      key={provider.id}
      kind="secondary"
      disabled={busy}
      onClick={() => {
        unlessRefused(() => {
          window.localStorage.setItem(LAST_USED, provider.id);
        });
        setLast(provider.id);
        onStart(provider);
      }}
    >
      <ProviderMark kind={provider.kind} />
      Continue with {provider.name}
      {last === provider.id && (
        <span className="text-meta text-ink-3">Last used</span>
      )}
    </Button>
  ));
}
