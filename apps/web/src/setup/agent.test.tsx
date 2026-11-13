// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { AGENT, mount, PUBLIC_BASE_URL } from "./screen-test-support";

const tab = (host: HTMLElement, name: string) => {
  const found = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (each) => each.textContent === name,
  );
  if (found === undefined) throw new Error(`Missing tab: ${name}`);
  return found;
};

it("gives each agent's steps with the checked address, not this page's", async () => {
  const view = await mount("agent");
  try {
    expect(view.host.textContent).toContain(
      `claude mcp add --transport http powerbi_metrics_book ${PUBLIC_BASE_URL}/api/mcp`,
    );
    act(() => {
      tab(view.host, "Codex").click();
    });
    expect(view.host.textContent).toContain(
      `url = "${PUBLIC_BASE_URL}/api/mcp"`,
    );
    act(() => {
      tab(view.host, "Cursor").click();
    });
    expect(view.host.textContent).toContain(
      `"url": "${PUBLIC_BASE_URL}/api/mcp"`,
    );
    act(() => {
      tab(view.host, "Command line").click();
    });
    expect(view.host.textContent).toContain(
      `pbmb login --url ${PUBLIC_BASE_URL}`,
    );
    expect(view.host.textContent).not.toContain(window.location.origin);
  } finally {
    view.close();
  }
});

it("lets a person pass by until an agent signs in, then says which one did", async () => {
  const waiting = await mount("agent");
  try {
    expect(waiting.host.textContent).toContain("Waiting for your agent");
    expect(waiting.host.textContent).toContain("Skip for now");
  } finally {
    waiting.close();
  }
  const connected = await mount("agent", "admin", false, {}, [AGENT]);
  try {
    expect(connected.host.textContent).toContain("Connected: Claude Code");
    expect(connected.host.textContent).toContain(AGENT.client_id);
    expect(connected.host.textContent).not.toContain("Skip for now");
    expect(connected.host.textContent).toContain("Continue");
  } finally {
    connected.close();
  }
});
