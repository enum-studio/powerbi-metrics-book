import { LINK, PageFrame } from "../layout/ui";
import { isProvider } from "./providers-editor";
import type { FieldSpec } from "./fields";
import { Section } from "./section";

const PROVIDERS: FieldSpec[] = [
  { key: "sign_in.providers", label: "Providers", kind: "providers" },
];
const PASSKEYS: FieldSpec[] = [
  {
    key: "sign_in.passkeys",
    label: "Passkeys",
    kind: "bool",
    hint: "People may sign in with a passkey once they have added one.",
  },
];

const EMAIL: FieldSpec[] = [
  {
    key: "email.from",
    label: "Sender address",
    kind: "text",
    hint: "An address on a domain verified in Resend. Invites and password resets come from it.",
  },
];
const PASSWORD: FieldSpec[] = [
  {
    key: "sign_in.email_password",
    label: "Password sign-in",
    kind: "bool",
    hint: "Invited people may sign in with a password. Needs the sender address and the Resend key above. Turning it off signs out everyone who has only a password.",
  },
];

/** The secret names of the providers already saved: a provider has one only once its row exists. */
function providerSecrets(_draft: unknown, saved: Record<string, unknown>) {
  const rows = saved["sign_in.providers"];
  return Array.isArray(rows)
    ? rows.filter(isProvider).map((row) => `sign_in_${row.id}_client_secret`)
    : [];
}

export function SignInPage() {
  return (
    <PageFrame
      title="Authentication"
      lede="How people sign in. Microsoft is always on; add Google or any OpenID Connect provider beside it."
      help={
        <>
          <p>
            Copy a provider's redirect URI into its own console, then enter its
            client id here and its secret in the row that appears once the
            provider is saved.
          </p>
          <a className={LINK} href="/docs/set-up/sign-in/">
            The sign-in guide
          </a>
        </>
      }
    >
      <Section
        title="Providers"
        fields={PROVIDERS}
        secrets={providerSecrets}
        checkName="sign_in"
      />
      <Section title="Passkeys" fields={PASSKEYS} />
      <Section
        title="Email"
        fields={EMAIL}
        secrets={() => ["resend_api_key"]}
      />
      <Section title="Password sign-in" fields={PASSWORD} />
    </PageFrame>
  );
}
