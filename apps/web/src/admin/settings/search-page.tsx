import { LINK, PageFrame } from "../layout/ui";
import type { FieldSpec } from "./fields";
import { Section } from "./section";

const FIELDS: FieldSpec[] = [
  {
    key: "search.provider",
    label: "Provider",
    kind: "choice",
    options: [
      { value: "none", label: "None: search by name only" },
      { value: "openai", label: "OpenAI" },
      { value: "gemini", label: "Gemini" },
    ],
  },
  {
    key: "search.model",
    label: "Model",
    kind: "text",
    hint: "The embedding model's name. Empty uses the provider's default.",
  },
  {
    key: "search.base_url",
    label: "Provider address",
    kind: "text",
    hint: "Empty uses the provider's own address.",
  },
];

/** The key of the provider being edited; none has none. */
function keyOf(draft: Record<string, unknown>): string[] {
  const provider = draft["search.provider"];
  return provider === "openai"
    ? ["openai_api_key"]
    : provider === "gemini"
      ? ["gemini_api_key"]
      : [];
}

export function SearchPage() {
  return (
    <PageFrame
      title="Search"
      lede="Search by meaning embeds the book's words with a provider. Without one, search matches names and words only."
      help={
        <>
          <p>
            The check embeds one sentence and says what embedding the book as it
            stands would cost.
          </p>
          <a className={LINK} href="/docs/set-up/search/">
            The search guide
          </a>
        </>
      }
    >
      <Section
        title="Embedding provider"
        fields={FIELDS}
        secrets={keyOf}
        checkName="search"
      />
    </PageFrame>
  );
}
