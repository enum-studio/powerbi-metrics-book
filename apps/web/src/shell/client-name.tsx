const MAX_CHARS = 80;
const NO_NAME = "An app with no name";
/** Characters that reorder or hide the text around them: embeddings, overrides, isolates and marks. */
const BIDI_CONTROLS = new RegExp(
  "[\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  "g",
);

type Client = {
  client_id: string;
  client_name: string | null;
  via: "mcp" | "cli";
};

/**
 * A client's name as shown to a person or an admin. Whoever registered the
 * client chose it, so it loses its direction controls and is cut to a line's
 * worth. Also the name for a button's aria-label.
 */
export function clientLabel(client: Pick<Client, "client_name">) {
  const name = (client.client_name ?? NO_NAME).replace(BIDI_CONTROLS, "");
  const chars = Array.from(name);
  return chars.length > MAX_CHARS
    ? `${chars.slice(0, MAX_CHARS).join("")}…`
    : name;
}

/**
 * The client of a grant: its name in its own text direction, and for an MCP
 * client, or one with no name, its id beside it, because a name can copy
 * another client's. It wraps, so a long name or id never widens its table.
 */
export function ClientName({ client }: { client: Client }) {
  return (
    <span className="min-w-0 break-words [overflow-wrap:anywhere]">
      <bdi title={client.client_name ?? NO_NAME} className="text-ink">
        {clientLabel(client)}
      </bdi>
      {(client.via === "mcp" || client.client_name === null) && (
        <>
          {" "}
          <code className="font-mono text-meta text-ink-3">
            {client.client_id}
          </code>
        </>
      )}
    </span>
  );
}
