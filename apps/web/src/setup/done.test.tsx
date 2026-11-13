// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { runStep } from "./api";
import { AGENT, mount } from "./screen-test-support";
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  runStep: vi.fn(),
}));
beforeEach(() =>
  vi.mocked(runStep).mockReset().mockResolvedValue({
    step: "first_sync",
    status: "passing",
    message: "20 measures in 3 datasets, 10 drafts ready for your agent.",
    next: null,
  }),
);
it("says what is in place and what is not, and offers the way back to each", async () => {
  const view = await mount("done");
  try {
    expect(view.host.textContent).toContain(
      "Who gets inOnly the people you gave a role.",
    );
    expect(view.host.textContent).toContain("Your agentNot connected yet.");
    const links = [...view.host.querySelectorAll("a")].map((link) =>
      link.getAttribute("href"),
    );
    expect(links).toEqual(
      expect.arrayContaining(["/setup?step=people", "/setup?step=agent"]),
    );
  } finally {
    view.close();
  }
});

it("names the agent that signed in", async () => {
  const view = await mount("done", "admin", false, {}, [AGENT]);
  try {
    expect(view.host.textContent).toContain("Your agentConnected: Claude Code");
    expect(view.host.textContent).not.toContain("Not connected yet.");
  } finally {
    view.close();
  }
});

it("updates the first sync's progress until its counts are ready", async () => {
  vi.useFakeTimers();
  vi.mocked(runStep).mockResolvedValueOnce({
    step: "first_sync",
    status: "failing",
    pending: true,
    message: "The first sync is running: 2 workspaces scanned so far.",
    next: null,
  });
  const view = await mount("done");
  try {
    expect(view.host.textContent).toContain("2 workspaces scanned so far");
    expect(view.host.querySelector("h1")?.textContent).toBe(
      "The first sync is running",
    );
    expect(
      [...view.host.querySelectorAll("button")].find(
        (button) => button.textContent === "Start using the app",
      )?.disabled,
    ).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(view.host.querySelector("h1")?.textContent).toBe(
      "The setup is done",
    );
    expect(view.host.textContent).toContain(
      "20 measures in 3 datasets, 10 drafts",
    );
    const start = [...view.host.querySelectorAll("a")].find(
      (link) => link.textContent === "Start using the app",
    );
    expect(start?.getAttribute("href")).toBe("/");
    expect(runStep).toHaveBeenCalledWith("first_sync", {});
  } finally {
    view.close();
    vi.useRealTimers();
  }
});

it("says the sync failed and leads back to where it can start again", async () => {
  vi.mocked(runStep).mockResolvedValue({
    step: "first_sync",
    status: "failing",
    message: "Power BI refused the scan.",
    next: null,
  });
  const view = await mount("done");
  try {
    expect(view.host.querySelector("h1")?.textContent).toBe(
      "The first sync failed",
    );
    expect(view.host.textContent).toContain("Power BI refused the scan.");
    const back = [...view.host.querySelectorAll("a")].find(
      (link) => link.textContent === "Back to What to sync",
    );
    expect(back?.getAttribute("href")).toBe("/setup?step=sync");
    expect(view.host.textContent).not.toContain("Start using the app");
  } finally {
    view.close();
  }
});

it("adds the worker hint only after two minutes queued", async () => {
  vi.useFakeTimers();
  vi.mocked(runStep).mockResolvedValue({
    step: "first_sync",
    status: "failing",
    pending: true,
    next: null,
    message:
      "The first sync waits for the worker to start it. Check that the worker container is running.",
  });
  const view = await mount("done");
  try {
    expect(view.host.textContent).toContain(
      "Waiting for the worker to start the first sync.",
    );
    expect(view.host.textContent).not.toContain(
      "Check that the worker container is running.",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(119_999);
    });
    expect(view.host.textContent).not.toContain(
      "Check that the worker container is running.",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(view.host.textContent).toContain(
      "Check that the worker container is running.",
    );
  } finally {
    view.close();
    vi.useRealTimers();
  }
});
