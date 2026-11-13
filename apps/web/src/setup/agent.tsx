import { Link } from "@tanstack/react-router";
import { ConnectAgent, useConnectedAgents } from "../access/connect-agent";
import type { SetupState } from "./api";
import { FirstSyncLine } from "./first-sync";
import { BUTTON, LABEL, QUIET } from "./parts";
import { checkedAddress, SCREENS, STEP_COUNT } from "./screens";

/** One thing to do on this screen, as Claude Code's "Connect your terminal": a command, and it knows when it worked. */
export function AgentScreen({ setup }: { setup: SetupState }) {
  const agents = useConnectedAgents();
  const position = SCREENS.findIndex((screen) => screen.id === "agent") + 1;
  return (
    <section className="flex flex-col gap-6">
      <div className="grid gap-2">
        <p className={LABEL}>
          Step {position} of {STEP_COUNT}
        </p>
        <h1 className="text-title font-semibold text-ink">
          Connect your agent
        </h1>
        <p className="max-w-(--measure) text-ui text-ink-2">
          Your agent reads the book and queries Power BI as you, with your own
          rights.
        </p>
      </div>
      <FirstSyncLine setup={setup} />
      <ConnectAgent origin={checkedAddress(setup)} />
      <div className="flex flex-wrap gap-2">
        <Link
          to="/setup"
          search={{ step: "done" }}
          className={agents.length > 0 ? BUTTON : QUIET}
        >
          {agents.length > 0 ? "Continue" : "Skip for now"}
        </Link>
      </div>
    </section>
  );
}
