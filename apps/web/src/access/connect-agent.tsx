import { useSuspenseQuery } from "@tanstack/react-query";
import { Check, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { ClientName } from "../shell/client-name";
import { CopyBlock, CopyValue } from "../shell/copy-button";
import { grantsQuery } from "./api";

const ASK_MS = 3000;
/** How often a connected agent that has not reached the book yet is asked about. */
const UNUSED_MS = 30_000;
const SERVER = "powerbi_metrics_book";

type Line =
  | { say: string }
  | { copy: string; value: string }
  | { block: string; value: string };

/** The same steps as the guide's Agents page, with this stack's own address. */
const TOOLS: {
  id: string;
  label: string;
  steps: (origin: string) => Line[];
  ask: string;
}[] = [
  {
    id: "claude_code",
    label: "Claude Code",
    steps: (origin) => [
      {
        copy: "Run this in a terminal",
        value: `claude mcp add --transport http ${SERVER} ${origin}/api/mcp`,
      },
      {
        say: `In Claude Code, run /mcp, choose ${SERVER} and sign in. Press Allow when your browser asks.`,
      },
    ],
    ask: `Run whoami on the ${SERVER} connector.`,
  },
  {
    id: "codex",
    label: "Codex",
    steps: (origin) => [
      {
        block: "Add this to ~/.codex/config.toml",
        value: `[mcp_servers.${SERVER}]\nurl = "${origin}/api/mcp"`,
      },
      {
        copy: "Then run this in a terminal",
        value: `codex mcp login ${SERVER}`,
      },
      { say: "Press Allow when your browser asks." },
    ],
    ask: `Run whoami on the ${SERVER} connector.`,
  },
  {
    id: "cursor",
    label: "Cursor",
    steps: (origin) => [
      {
        block: "Add this to ~/.cursor/mcp.json",
        value: JSON.stringify(
          { mcpServers: { [SERVER]: { url: `${origin}/api/mcp` } } },
          null,
          2,
        ),
      },
      {
        say: `Open Cursor's Customize page, find ${SERVER} and sign in. Press Allow when your browser asks.`,
      },
    ],
    ask: `Run whoami on the ${SERVER} connector.`,
  },
  {
    id: "cli",
    label: "Command line",
    steps: (origin) => [
      { copy: "Install it", value: "uv tool install powerbi-metrics-book" },
      { copy: "Sign it in", value: `pbmb login --url ${origin}` },
      {
        say: "It prints a code and a page. Open the page, type the code and press Allow.",
      },
    ],
    ask: "pbmb whoami",
  },
];

/**
 * A person's connected agents, asked again every few seconds until one signs
 * in, so the screen sees that moment, then now and then until one has
 * reached the book.
 */
export function useConnectedAgents() {
  const { data } = useSuspenseQuery({
    ...grantsQuery,
    refetchInterval: (query) => {
      const grants = query.state.data?.grants ?? [];
      if (grants.length === 0) return ASK_MS;
      return grants.some((grant) => grant.last_used_at !== null)
        ? false
        : UNUSED_MS;
    },
  });
  return data.grants;
}

export function ConnectAgent({ origin }: { origin: string }) {
  const [tool, setTool] = useState(TOOLS[0]);
  const agents = useConnectedAgents();
  if (tool === undefined) throw new Error("There is no agent to connect.");
  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label="Your agent"
        className="flex gap-4 overflow-x-auto border-b border-line sm:gap-5"
      >
        {TOOLS.map((each) => (
          <button
            key={each.id}
            type="button"
            role="tab"
            aria-selected={each.id === tool.id}
            onClick={() => {
              setTool(each);
            }}
            className={`border-b-2 py-2 text-ui whitespace-nowrap pointer-coarse:min-h-(--tap) ${each.id === tool.id ? "border-accent font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
          >
            {each.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="flex flex-col gap-4">
        {tool.steps(origin).map((line) =>
          "say" in line ? (
            <p key={line.say} className="max-w-(--measure) text-ui text-ink-2">
              {line.say}
            </p>
          ) : "copy" in line ? (
            <CopyValue key={line.copy} label={line.copy} value={line.value} />
          ) : (
            <CopyBlock
              key={line.block}
              label={line.block}
              value={line.value}
              mono
            />
          ),
        )}
        <CopyValue
          label={tool.id === "cli" ? "Then check it" : "Then ask it"}
          value={tool.ask}
        />
      </div>
      {agents.length === 0 ? (
        <p role="status" className="flex gap-2 text-ui text-ink-2">
          <LoaderCircle
            size={16}
            aria-hidden="true"
            className="mt-0.5 shrink-0 animate-spin text-ink-3"
          />
          Waiting for your agent to sign in. This page sees it when it does.
        </p>
      ) : (
        <div role="status" className="flex gap-2 text-ui font-medium text-ink">
          <Check
            size={16}
            strokeWidth={2.5}
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-accent"
          />
          <ul className="flex min-w-0 flex-col gap-1">
            {agents.map((agent) => (
              <li key={agent.id}>
                Connected: <ClientName client={agent} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
