import { useSuspenseQuery } from "@tanstack/react-query";
import { EmptyState } from "../../shell/states";
import { PageFrame } from "../layout/ui";
import { secretsQuery } from "./api";
import { SecretRow } from "./secret-row";

export function SecretsPage() {
  const { data: secrets } = useSuspenseQuery(secretsQuery);
  return (
    <PageFrame
      title="Secrets"
      lede="Every secret the stack keeps. A value is write-only: once saved, only its last four characters are shown."
      help={
        <p>
          Each secret is encrypted for the containers that read it. Set one
          here, with <code className="font-mono">pbmb admin secrets set</code>,
          or in the environment, which wins.
        </p>
      }
    >
      {secrets.length === 0 ? (
        <EmptyState title="No secrets yet">
          Secrets appear here as the setup asks for them.
        </EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {secrets.map((secret) => (
            <li key={secret.name} className="py-4 first:pt-0 last:pb-0">
              <SecretRow secret={secret} withCheck />
            </li>
          ))}
        </ul>
      )}
    </PageFrame>
  );
}
