import { describe, expect, it } from "vitest";
import type { SetupState, StepState } from "./api";
import {
  capScreen,
  currentScreen,
  isWhileItSyncs,
  SCREENS,
  standing,
  type ScreenId,
  type Standing,
} from "./screens";

function setup(changes: Record<string, Partial<StepState>> = {}): SetupState {
  return {
    holder: "admin",
    completed_at: null,
    failure_docs_path: "/docs/set-up/when-a-check-fails/",
    steps: [
      "address",
      "app_registration",
      "scanner",
      "what_to_sync",
      "first_sync",
    ].map((id) => ({
      id,
      title: id,
      docs_path: "/docs/set-up/address/",
      fields: [],
      passed: false,
      pending: false,
      action: null,
      check: null,
      ...changes[id],
    })),
  };
}

describe("standing", () => {
  it("waits on Microsoft while the scanner check is pending in the worker", () => {
    expect(standing(setup({ scanner: { pending: true } }), "microsoft")).toBe(
      "waiting",
    );
  });

  it("waits while the scanner's credentials check is pending, and fails on its refusal", () => {
    const credentials = (check: StepState["check"], pending = false) => ({
      scanner: { credentials: { pending, check } },
    });
    expect(standing(setup(credentials(null, true)), "microsoft")).toBe(
      "waiting",
    );
    expect(
      standing(
        setup(
          credentials({
            status: "failing",
            message: "Microsoft refused.",
            checked_at: "2026-10-29T00:00:00Z",
          }),
        ),
        "microsoft",
      ),
    ).toBe("failed");
  });
});

const passing = {
  status: "passing",
  message: null,
  checked_at: "2026-10-29T00:00:00Z",
} as const;
const failing = { ...passing, status: "failing" } as const;
const microsoft = {
  scanner: { passed: true },
  app_registration: { check: passing },
};
const signedIn = { app_registration: { passed: true } };

it.each<[ScreenId, Record<string, Partial<StepState>>, Standing]>([
  ["address", {}, "you"],
  ["address", { address: { check: failing } }, "failed"],
  ["address", { address: { passed: true, check: failing } }, "done"],
  ["microsoft", {}, "to_do"],
  ["microsoft", { address: { passed: true } }, "you"],
  ["microsoft", microsoft, "done"],
  [
    "microsoft",
    {
      scanner: { passed: true },
      app_registration: { check: failing, action: "sign_in" },
    },
    "done",
  ],
  [
    "microsoft",
    {
      scanner: { passed: true },
      app_registration: { check: failing, action: "connect" },
    },
    "done",
  ],
  ["microsoft", { app_registration: { check: failing } }, "failed"],
  ["microsoft", { scanner: { check: failing } }, "failed"],
  [
    "microsoft",
    {
      scanner: { pending: true, check: failing },
      app_registration: { check: failing },
    },
    "waiting",
  ],
  [
    "microsoft",
    { ...microsoft, scanner: { passed: true, pending: true } },
    "done",
  ],
  ["sign-in", {}, "to_do"],
  ["sign-in", microsoft, "you"],
  ["sign-in", signedIn, "done"],
  ["sync", {}, "to_do"],
  ["sync", signedIn, "you"],
  ["sync", { what_to_sync: { check: failing } }, "failed"],
  ["sync", { first_sync: { check: failing } }, "failed"],
  [
    "sync",
    { what_to_sync: { pending: true }, first_sync: { check: failing } },
    "waiting",
  ],
  ["sync", { first_sync: { pending: true, check: failing } }, "waiting"],
  ["sync", { first_sync: { passed: true, pending: true } }, "done"],
  [
    "sync",
    { what_to_sync: { passed: true }, first_sync: { check: passing } },
    "done",
  ],
  ["sync", { ...signedIn, first_sync: { check: passing } }, "you"],
  ["people", {}, "to_do"],
  ["people", { first_sync: { pending: true } }, "you"],
  [
    "people",
    { what_to_sync: { passed: true }, first_sync: { check: passing } },
    "you",
  ],
  ["agent", { first_sync: { pending: true } }, "you"],
  ["agent", { first_sync: { passed: true } }, "you"],
  ["done", {}, "to_do"],
])("%s with %j is %s", (screen, changes, expected) => {
  expect(standing(setup(changes), screen)).toBe(expected);
});

it("marks Done only from the completion stamp", () => {
  expect(
    standing({ ...setup(), completed_at: "2026-10-29T00:00:00Z" }, "done"),
  ).toBe("done");
});

it("chooses the first unfinished screen in order, including Done", () => {
  const state = setup();
  for (const screen of SCREENS.filter(({ id }) => !isWhileItSyncs(id))) {
    expect(currentScreen(state)).toBe(screen.id);
    if (screen.id === "sync") {
      state.holder = "setup_link";
      expect(currentScreen(state)).toBe("sign-in");
      state.holder = "admin";
    }
    for (const id of screen.steps) {
      const step = state.steps.find((step) => step.id === id);
      if (step === undefined) throw new Error(`Missing test step ${id}`);
      step.passed = screen.id !== "microsoft" || id !== "app_registration";
      step.check = step.passed ? passing : failing;
      step.action = step.passed ? null : "sign_in";
    }
  }
  state.completed_at = "2026-10-29T00:00:00Z";
  expect(currentScreen(state)).toBe("done");
  state.holder = "setup_link";
  expect(currentScreen(state)).toBe("sign-in");
  state.completed_at = null;
  expect(currentScreen(state)).toBe("sign-in");
});

it("goes on to who gets in while the first sync runs, and stays on What to sync if it failed", () => {
  const before = {
    address: { passed: true },
    scanner: { passed: true },
    app_registration: { passed: true, check: passing },
    what_to_sync: { passed: true },
  };
  expect(
    currentScreen(setup({ ...before, first_sync: { pending: true } })),
  ).toBe("people");
  expect(
    currentScreen(setup({ ...before, first_sync: { check: failing } })),
  ).toBe("sync");
});

it("goes on to Done for a sync that ended with nobody watching", () => {
  expect(
    currentScreen(
      setup({
        address: { passed: true },
        scanner: { passed: true },
        app_registration: { passed: true, check: passing },
        what_to_sync: { passed: true },
        first_sync: { check: passing },
      }),
    ),
  ).toBe("done");
});

it.each(SCREENS)("caps a setup session's $id screen at sign-in", ({ id }) => {
  const state = setup({ first_sync: { pending: true } });
  expect(capScreen(state, id)).toBe(id);
  state.holder = "setup_link";
  expect(capScreen(state, id)).toBe(
    ["sync", "people", "agent", "done"].includes(id) ? "sign-in" : id,
  );
});

it.each(["people", "agent", "done"] as const)(
  "opens %s only once the first sync has started",
  (id) => {
    expect(capScreen(setup(), id)).toBe("sync");
    expect(capScreen(setup({ first_sync: { pending: true } }), id)).toBe(id);
    expect(capScreen(setup({ first_sync: { passed: true } }), id)).toBe(id);
    expect(capScreen(setup({ first_sync: { check: failing } }), id)).toBe(id);
  },
);

it("stays on What to sync when a sync started before anyone chose the workspaces", () => {
  expect(
    currentScreen(
      setup({
        address: { passed: true },
        scanner: { passed: true },
        app_registration: { passed: true, check: passing },
        first_sync: { pending: true },
      }),
    ),
  ).toBe("sync");
});
