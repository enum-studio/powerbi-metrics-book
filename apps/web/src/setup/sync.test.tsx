// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { runStep } from "./api";
import { MICROSOFT_LINKS } from "./links";
import { click, mount, WORKSPACES } from "./screen-test-support";
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  runStep: vi.fn(),
}));
it("shows the sign-in app's note quietly, and leaves Start to work", async () => {
  const note =
    "Not needed by this app, which never uses it: App.Read.All. The app can still do what it allows.";
  vi.mocked(runStep)
    .mockClear()
    .mockImplementation((id) =>
      Promise.resolve({
        step: id,
        status: "passing",
        message: null,
        next: null,
        ...(id === "what_to_sync"
          ? {
              details: {
                workspaces: WORKSPACES,
                truncated: false,
                personal_count: 1,
              },
            }
          : {}),
      }),
    );
  const view = await mount("sync", "admin", true, {
    passed: true,
    action: null,
    check: {
      status: "passing",
      message: note,
      checked_at: "2026-10-29T00:00:00Z",
    },
  });
  try {
    expect(view.host.querySelector('[role="note"]')?.textContent).toBe(
      `The sign-in app passed its check. ${note}`,
    );
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    await click(view.host, "Start");
    expect(runStep).toHaveBeenCalledWith("first_sync", { start_sync: true });
  } finally {
    view.close();
  }
});

it("shows no note for a check that says nothing, or one that failed", async () => {
  vi.mocked(runStep)
    .mockClear()
    .mockImplementation((id) =>
      Promise.resolve({
        step: id,
        status: "failing",
        message: "No.",
        next: null,
      }),
    );
  for (const check of [
    { status: "passing", message: null },
    { status: "failing", message: "Refused." },
  ] as const) {
    const view = await mount("sync", "admin", false, {
      passed: true,
      action: null,
      check: { ...check, checked_at: "2026-10-29T00:00:00Z" },
    });
    try {
      expect(view.host.querySelector('[role="note"]')).toBeNull();
    } finally {
      view.close();
    }
  }
});

it.each([
  ["a sync that failed", false, "The last sync failed."],
  ["no failure while another sync runs", true, null],
])("says %s", async (_, pending, alert) => {
  vi.mocked(runStep)
    .mockClear()
    .mockImplementation((id) =>
      Promise.resolve({
        step: id,
        status: "passing",
        message: null,
        next: null,
        details: {
          workspaces: WORKSPACES,
          truncated: false,
          personal_count: 1,
        },
      }),
    );
  const view = await mount("sync", "admin", false, {}, [], {
    pending,
    check: {
      status: "failing",
      message: pending ? "The first sync is running." : "The last sync failed.",
      checked_at: "2026-10-29T00:00:00Z",
    },
  });
  try {
    expect(view.host.querySelector('[role="alert"]')?.textContent ?? null).toBe(
      alert,
    );
  } finally {
    view.close();
  }
});

it.each([false, true])("saves personal=%s", async (personal) => {
  vi.mocked(runStep)
    .mockClear()
    .mockImplementation((id) =>
      Promise.resolve({
        step: id,
        status: "passing",
        message: null,
        next: null,
        ...(id === "what_to_sync"
          ? {
              details: {
                workspaces: WORKSPACES.filter(
                  (workspace) => personal || !workspace.personal,
                ),
                truncated: false,
                personal_count: 1,
              },
            }
          : {}),
      }),
    );
  const view = await mount("sync", "admin", personal);
  try {
    expect(runStep).toHaveBeenCalledWith("what_to_sync", {
      start_check: true,
    });
    expect(view.host.querySelector("fieldset legend")?.textContent).toBe(
      "Workspaces",
    );
    const boxes = [
      ...view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    expect(
      boxes.map((box) => [box.parentElement?.textContent, box.checked]),
    ).toEqual([
      ["Sales", true],
      ["Finance", true],
      ...(personal ? [["My workspace Personal", true]] : []),
      ["Personal workspaces", personal],
    ]);
    await act(async () => {
      boxes[1]?.click();
      await Promise.resolve();
    });
    await click(view.host, "Start");
    expect(runStep).toHaveBeenCalledWith("what_to_sync", {
      settings: {
        "powerbi.sync.workspaces.include": "all",
        "powerbi.sync.workspaces.exclude": ["finance"],
        "powerbi.sync.workspaces.personal": personal,
      },
    });
    const calls = vi.mocked(runStep).mock.calls;
    expect(calls.at(-1)).toEqual(["first_sync", { start_sync: true }]);
    expect(view.router.state.location.search.step).toBe("people");
  } finally {
    view.close();
  }
});

it("waits for the worker after one start request", async () => {
  vi.mocked(runStep).mockClear().mockResolvedValue({
    step: "what_to_sync",
    status: "failing",
    message: "Queued",
    pending: true,
    next: null,
  });
  const view = await mount("sync");
  try {
    expect(runStep).toHaveBeenCalledExactlyOnceWith("what_to_sync", {
      start_check: true,
    });
    expect(view.host.textContent).toContain("Waiting for the worker");
  } finally {
    view.close();
  }
});
it("shows a failed check's sentence and tenant settings link without empty controls", async () => {
  vi.mocked(runStep).mockResolvedValue({
    step: "what_to_sync",
    status: "failing",
    message: "Power BI refused admin APIs to this service principal.",
    next: null,
  });
  const view = await mount("sync");
  try {
    expect(view.host.textContent).toContain(
      "Power BI refused admin APIs to this service principal.",
    );
    expect(view.host.querySelector("a")?.getAttribute("href")).toBe(
      MICROSOFT_LINKS.powerBiTenantSettings.href,
    );
    expect(view.host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(view.host.textContent).not.toContain("The default schedule");
    expect(view.host.querySelector("button")).toBeNull();
  } finally {
    view.close();
  }
});

it.each(
  [0, 1, 3].flatMap((count) =>
    [false, true].map((truncated) => ({ count, truncated })),
  ),
)(
  "shows the count of $count personal workspaces with truncated=$truncated",
  async ({ count, truncated }) => {
    vi.mocked(runStep).mockResolvedValue({
      step: "what_to_sync",
      status: "passing",
      message: null,
      next: null,
      details: {
        workspaces: WORKSPACES.filter((workspace) => !workspace.personal),
        truncated,
        personal_count: count,
      },
    });
    const view = await mount("sync");
    try {
      const text = `${truncated ? "At least " : ""}${String(count)} personal workspace${count === 1 ? "" : "s"}, not synced`;
      expect(
        [...view.host.querySelectorAll("p")].some(
          (line) => line.textContent === text,
        ),
      ).toBe(count > 0);
      expect(view.host.textContent).not.toContain("My workspace");
    } finally {
      view.close();
    }
  },
);
it("saves and rechecks both toggle choices, marking personal ones and excluding only visible choices", async () => {
  let personal = false;
  vi.mocked(runStep)
    .mockClear()
    .mockImplementation((id, body) => {
      if (body.settings?.["powerbi.sync.workspaces.personal"] !== undefined)
        personal = body.settings["powerbi.sync.workspaces.personal"] === true;
      return Promise.resolve({
        step: id,
        status: "passing",
        message: null,
        next: null,
        details: {
          workspaces: WORKSPACES.filter(
            (workspace) => personal || !workspace.personal,
          ),
          truncated: false,
          personal_count: 1,
        },
      });
    });
  const view = await mount("sync");
  const toggle = async (label: string) => {
    const box = [
      ...view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].find((box) => box.parentElement?.textContent.startsWith(label));
    if (!box) throw new Error(`Missing checkbox: ${label}`);
    await act(async () => {
      box.click();
      await Promise.resolve();
    });
  };
  try {
    await toggle("Personal workspaces");
    expect(runStep).toHaveBeenLastCalledWith("what_to_sync", {
      settings: { "powerbi.sync.workspaces.personal": true },
      start_check: true,
    });
    expect(view.host.textContent).toContain("My workspace Personal");
    expect(view.host.textContent).not.toContain("not synced");
    await toggle("My workspace");
    await toggle("Finance");
    await toggle("Personal workspaces");
    expect(runStep).toHaveBeenLastCalledWith("what_to_sync", {
      settings: { "powerbi.sync.workspaces.personal": false },
      start_check: true,
    });
    expect(view.host.textContent).not.toContain("My workspace");
    expect(view.host.textContent).toContain("1 personal workspace, not synced");
    await click(view.host, "Start");
    expect(runStep).toHaveBeenCalledWith("what_to_sync", {
      settings: {
        "powerbi.sync.workspaces.include": "all",
        "powerbi.sync.workspaces.exclude": ["finance"],
        "powerbi.sync.workspaces.personal": false,
      },
    });
  } finally {
    view.close();
  }
});
