// @vitest-environment jsdom
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { runStep, type SetupState, type StepAnswer } from "./api";
import { Microsoft } from "./microsoft";
import { appPage } from "./links";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  runStep: vi.fn(),
}));
const postTenant = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(),
);
vi.mock("../api/client", async (original) => {
  const actual = await original<typeof import("../api/client")>();
  return { ...actual, api: { ...actual.api, POST: postTenant } };
});
const GUID = "3f2b8c1e-7d4a-4e0b-9c61-2a5d8e9f0b17";
const setup: SetupState = {
  holder: "setup_link",
  completed_at: null,
  failure_docs_path: "/docs/set-up/when-a-check-fails/",
  steps: ["app_registration", "scanner"].map((id) => ({
    id,
    title: id,
    docs_path: "/docs/set-up/app-registration/",
    passed: false,
    pending: false,
    action: null,
    check: null,
    fields: [
      ...(id === "app_registration"
        ? [{ kind: "setting" as const, key: "powerbi.tenant_id", value: GUID }]
        : []),
      {
        kind: "setting",
        key: `powerbi.${id === "scanner" ? "scanner" : "app"}_client_id`,
        value: "",
      },
      {
        kind: "secret",
        name: `powerbi_${id === "scanner" ? "scanner" : "app"}_client_secret`,
        set: true,
        expires_at: null,
      },
    ],
  })),
};
setup.steps.unshift({
  id: "address",
  title: "Address",
  docs_path: "/docs/set-up/address/",
  fields: [],
  passed: true,
  pending: false,
  action: null,
  check: {
    status: "passing",
    message: null,
    checked_at: "2026-10-29T00:00:00Z",
    details: {
      public_base_url: "https://canonical.sample.example",
      cookies_secure: true,
    },
  },
});

it("links typed IDs, refuses the same scanner and retries tenant settings for fifteen minutes", async () => {
  vi.useFakeTimers();
  vi.mocked(runStep).mockImplementation((id, body) =>
    Promise.resolve({
      step: id,
      status: "failing",
      message: "Check the tenant settings.",
      next: null,
      ...(id === "app_registration"
        ? { action: "sign_in" }
        : body.start_check
          ? { details: { reason: "tenant_settings" } }
          : {}),
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  const button = (text: string) => {
    const found = [...host.querySelectorAll("button")].find((button) =>
      button.textContent.includes(text),
    );
    if (found === undefined) throw new Error(`Missing ${text}`);
    return found;
  };
  const type = async (value: string) => {
    const input = host.querySelector("input");
    if (input === null) throw new Error("Missing client ID field");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  const submit = async () => {
    await act(async () => {
      host
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Microsoft setup={setup} />
        </QueryClientProvider>,
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    for (const title of [
      "The scanner app",
      "The scanner's security group",
      "Three Power BI tenant settings",
    ])
      expect(button(title).textContent).toContain("To do");
    await type(GUID);
    for (const page of [
      "Overview",
      "Authentication",
      "Credentials",
      "CallAnAPI",
    ] as const) {
      const href = appPage(page, GUID);
      if (href === null) throw new Error(`Missing ${page} link`);
      const link = host.querySelector(`aside a[href="${href}"]`);
      expect(link, page).not.toBeNull();
      expect(link?.getAttribute("target")).toBe("_blank");
      expect(link?.getAttribute("rel")).toBe("noopener");
    }
    await submit();
    expect(runStep).toHaveBeenCalledWith(
      "app_registration",
      expect.objectContaining({
        settings: { "powerbi.tenant_id": GUID, "powerbi.app_client_id": GUID },
      }),
    );
    expect(button("The sign-in app").textContent).toContain("Checked");
    expect(button("The sign-in app").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(button("The scanner app").getAttribute("aria-expanded")).toBe(
      "true",
    );
    act(() => {
      button("The sign-in app").click();
    });
    expect(host.textContent).toContain(
      "Checked: this app signs in, with this secret, in your tenant.",
    );
    act(() => {
      button("Next: The scanner app").click();
    });
    await type(GUID.toUpperCase());
    expect(host.textContent).toContain(
      "These are the same app. The scanner needs its own registration.",
    );
    expect(button("Check the scanner app").disabled).toBe(true);
    await type("91c0d6a2-4b5e-4f13-8a7d-6e2f1c9b3a40");
    expect(button("Check the scanner app").disabled).toBe(false);
    await submit();
    act(() => {
      button("Three Power BI tenant settings").click();
    });
    await submit();
    expect(button("The scanner's security group").textContent).toContain(
      "Needs a fix",
    );
    expect(host.textContent).toContain(
      "Next try in 1:00; you can leave this page.",
    );
    const starts = () =>
      vi.mocked(runStep).mock.calls.filter(([, body]) => body.start_check)
        .length;
    const before = starts();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(starts()).toBe(before + 1);
    for (let minute = 0; minute < 15; minute++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    expect(host.textContent).not.toContain("Next try in");
    expect(starts()).toBe(before + 14);
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    client.clear();
    vi.useRealTimers();
  }
});

it("defaults to existing apps, completes the guide and retries a rate limited lookup", async () => {
  vi.useFakeTimers();
  const state = structuredClone(setup);
  for (const step of state.steps) {
    if (step.id === "address") continue;
    step.check = {
      status: "passing",
      message: "The scanner read a workspace.",
      checked_at: "2026-10-29T00:00:00Z",
    };
    for (const field of step.fields)
      if (field.kind === "setting" && field.key.endsWith("client_id"))
        field.value =
          step.id === "scanner" ? "91c0d6a2-4b5e-4f13-8a7d-6e2f1c9b3a40" : GUID;
  }
  vi.mocked(runStep).mockResolvedValue({
    step: "scanner",
    status: "passing",
    message: "The scanner read a workspace.",
    next: null,
  });
  postTenant.mockResolvedValue({
    data: { tenant_id: GUID, domain: "example.com" },
    response: new Response(),
  });
  const host = document.createElement("div"),
    root = createRoot(host),
    client = new QueryClient();
  document.body.append(host);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <Microsoft setup={state} />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  try {
    await act(async () => {
      await router.load();
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      host.querySelector('[role="radio"][aria-checked="true"]')?.textContent,
    ).toBe("Yes, I have the apps");
    expect(host.textContent).toContain("One check before you sign in");
    expect(host.textContent).toContain(
      "https://canonical.sample.example/api/auth/callback/microsoft",
    );
    expect(host.querySelector("aside")?.textContent).not.toContain(
      "as a viewer",
    );
    expect(host.textContent).toContain("Your tenant is connected");
    expect(host.querySelector("aside")?.textContent).toContain(
      "Select Continue. Microsoft asks you to sign in",
    );
    const authentication = host.querySelector("aside li:first-child a");
    expect(authentication?.getAttribute("href")).toBe(
      appPage("Authentication", GUID),
    );
    act(() => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent.startsWith("Your tenant"))
        ?.click();
    });
    const input = host.querySelector('input[type="email"]');
    if (!(input instanceof HTMLInputElement))
      throw new Error("Missing work email");
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "admin@example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(postTenant).toHaveBeenCalledExactlyOnceWith("/api/setup/tenant", {
      body: { email: "admin@example.com" },
    });
    expect(host.textContent).toContain(
      `Found: tenant ${GUID}, from example.com.`,
    );
    expect(host.querySelector("aside")?.textContent).not.toContain(
      "The scanner read a workspace.",
    );
    postTenant.mockResolvedValue({
      error: {
        error: "rate_limited",
        message: "Microsoft is limiting tenant lookups. Try again.",
      },
      response: new Response(null, { status: 429 }),
    });
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "admin@refused.example");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Microsoft is limiting tenant lookups. Try again.",
    );
    const attempts = postTenant.mock.calls.length;
    postTenant.mockResolvedValue({
      data: { tenant_id: GUID, domain: "refused.example" },
      response: new Response(),
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(postTenant).toHaveBeenCalledTimes(attempts + 1);
    expect(host.textContent).toContain(
      `Found: tenant ${GUID}, from refused.example.`,
    );
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    client.clear();
    vi.useRealTimers();
  }
});

it("marks the chosen way with the accent look and leaves the other on the quiet one", () => {
  const state = structuredClone(setup);
  for (const field of state.steps.flatMap((step) => step.fields))
    if (field.kind === "setting" && field.key === "powerbi.app_client_id")
      field.value = GUID;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  try {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <Microsoft setup={state} />
        </QueryClientProvider>,
      );
    });
    const classes = (selector: string) => {
      const found = host.querySelector(selector);
      if (found === null) throw new Error(`Missing ${selector}`);
      return found.className.split(" ");
    };
    for (const [group, role, selected] of [
      ["radiogroup", "radio", "aria-checked"],
      ["tablist", "tab", "aria-selected"],
    ] as const) {
      const chosen = classes(
        `[role="${group}"] [role="${role}"][${selected}="true"]`,
      );
      const other = classes(
        `[role="${group}"] [role="${role}"][${selected}="false"]`,
      );
      expect(chosen, group).toContain("bg-accent");
      expect(chosen, group).toContain("text-on-accent");
      expect(chosen, group).not.toContain("bg-surface");
      expect(chosen, group).not.toContain("text-ink");
      expect(other, group).toContain("bg-surface");
      expect(other, group).not.toContain("bg-accent");
    }
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    client.clear();
  }
});

const SCANNER_GUID = "91c0d6a2-4b5e-4f13-8a7d-6e2f1c9b3a40";
const TENANT = "Your tenant";
const SIGN_IN = "The sign-in app";
const SCANNER_APP = "The scanner app";
const GROUP = "The scanner's security group";

/** Both apps' IDs filled in, so the first section left to do is the sign-in app, or the scanner app once its check has passed. */
function withApps(signInChecked: boolean) {
  const state = structuredClone(setup);
  for (const step of state.steps) {
    if (step.id === "address") continue;
    for (const field of step.fields)
      if (field.kind === "setting" && field.key.endsWith("client_id"))
        field.value = step.id === "scanner" ? SCANNER_GUID : GUID;
    if (signInChecked && step.id === "app_registration") {
      step.passed = true;
      step.check = {
        status: "passing",
        message: null,
        checked_at: "2026-10-29T00:00:00Z",
      };
    }
  }
  return state;
}

async function mountSetup(
  state: SetupState,
  refetchSetup?: () => Promise<unknown>,
) {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  // The setup query the rail reads: a check's answer refetches it before the check is done.
  function Page() {
    useQuery({
      queryKey: ["setup"],
      queryFn: refetchSetup ?? (() => Promise.resolve(state)),
      enabled: refetchSetup !== undefined,
    });
    return <Microsoft setup={state} />;
  }
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <Page />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    await router.load();
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);
  });
  const header = (title: string) => {
    const found = [
      ...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
    ].find((button) => button.textContent.startsWith(title));
    if (found === undefined) throw new Error(`Missing section ${title}`);
    return found;
  };
  return {
    host,
    isOpen: (title: string) =>
      header(title).getAttribute("aria-expanded") === "true",
    openSections: () =>
      [...host.querySelectorAll('button[aria-expanded="true"]')].map(
        (button) => button.textContent,
      ),
    nextButton: () =>
      [...host.querySelectorAll("button")].find((button) =>
        button.textContent.startsWith("Next: "),
      ),
    open: (title: string) => {
      act(() => {
        header(title).click();
      });
    },
    submit: async () => {
      await act(async () => {
        host
          .querySelector("form")
          ?.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        await vi.advanceTimersByTimeAsync(0);
      });
    },
    wait: async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    },
    close: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
      client.clear();
      vi.useRealTimers();
    },
  };
}

it("opens the next section by itself when a check the person ran passes", async () => {
  vi.mocked(runStep).mockImplementation((id) =>
    Promise.resolve(
      id === "app_registration"
        ? { step: id, status: "passing", message: null, next: null }
        : { step: id, status: "failing", message: "Not yet.", next: null },
    ),
  );
  const view = await mountSetup(withApps(false));
  try {
    expect(view.openSections()).toHaveLength(1);
    expect(view.isOpen(SIGN_IN)).toBe(true);
    await view.submit();
    expect(view.isOpen(SCANNER_APP)).toBe(true);
    expect(view.openSections()).toHaveLength(1);
    expect(view.nextButton()).toBeUndefined();
    expect(
      [...view.host.querySelectorAll("button")].find((button) =>
        button.textContent.startsWith(SIGN_IN),
      )?.textContent,
    ).toContain("Checked");
  } finally {
    view.close();
  }
});

it("stays on the section with its message when the check fails", async () => {
  vi.mocked(runStep).mockImplementation((id) =>
    Promise.resolve({
      step: id,
      status: "failing",
      message: "The secret is wrong.",
      next: null,
    }),
  );
  const view = await mountSetup(withApps(false));
  try {
    await view.submit();
    await view.wait(5000);
    expect(view.isOpen(SIGN_IN)).toBe(true);
    expect(view.openSections()).toHaveLength(1);
    expect(view.host.textContent).toContain("The secret is wrong.");
    expect(view.nextButton()).toBeUndefined();
  } finally {
    view.close();
  }
});

it("stays on a finished section someone reopened and offers Next from it", async () => {
  vi.mocked(runStep).mockImplementation((id) =>
    Promise.resolve({ step: id, status: "failing", message: "x", next: null }),
  );
  const view = await mountSetup(withApps(true));
  try {
    expect(view.isOpen(SCANNER_APP)).toBe(true);
    view.open(SIGN_IN);
    await view.wait(5000);
    expect(view.isOpen(SIGN_IN)).toBe(true);
    expect(view.openSections()).toHaveLength(1);
    expect(view.nextButton()?.textContent).toBe(`Next: ${SCANNER_APP}`);
    act(() => {
      view.nextButton()?.click();
    });
    expect(view.isOpen(SCANNER_APP)).toBe(true);
    expect(view.openSections()).toHaveLength(1);
  } finally {
    view.close();
  }
});

/** The sign-in check waits until `release` is called; every other check fails at once. */
function holdSignInCheck() {
  let release: () => void = () => undefined;
  vi.mocked(runStep).mockImplementation(
    (id, body) =>
      new Promise((resolve) => {
        const answer = (status: "passing" | "failing") => {
          resolve({ step: id, status, message: null, next: null });
        };
        if (id === "app_registration" && body.settings !== undefined)
          release = () => {
            answer("passing");
          };
        else answer("failing");
      }),
  );
  return async () => {
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
  };
}

it("does not jump when the person leaves for a finished section before the check passes", async () => {
  const release = holdSignInCheck();
  const view = await mountSetup(withApps(false));
  try {
    await view.submit();
    view.open(TENANT);
    await release();
    expect(view.isOpen(TENANT)).toBe(true);
    expect(view.openSections()).toHaveLength(1);
  } finally {
    view.close();
  }
});

it("does not jump when the person returns to a section whose check passes later", async () => {
  const release = holdSignInCheck();
  const view = await mountSetup(withApps(false));
  try {
    await view.submit();
    view.open(TENANT);
    view.open(SIGN_IN);
    await release();
    expect(view.isOpen(SIGN_IN)).toBe(true);
    expect(view.openSections()).toHaveLength(1);
    expect(view.nextButton()?.textContent).toBe(`Next: ${SCANNER_APP}`);
  } finally {
    view.close();
  }
});

it("does not jump when the person leaves for a finished section while a worker check is under way", async () => {
  vi.mocked(runStep).mockImplementation((id, body) =>
    Promise.resolve(
      id === "scanner" && body.settings !== undefined
        ? {
            step: id,
            status: "failing",
            message: "Checking.",
            next: null,
            pending: true,
          }
        : { step: id, status: "failing", message: "Not yet.", next: null },
    ),
  );
  const view = await mountSetup(withApps(true));
  try {
    expect(view.isOpen(SCANNER_APP)).toBe(true);
    await view.submit();
    view.open(TENANT);
    await view.wait(0);
    expect(view.isOpen(TENANT)).toBe(true);
    expect(view.openSections()).toHaveLength(1);
  } finally {
    view.close();
  }
});

it("opens the next section when a worker check passes while the setup refetch is slow", async () => {
  let queued = false;
  let slow = false;
  let finishRefetch: () => void = () => undefined;
  vi.mocked(runStep).mockImplementation((id, body) => {
    if (id !== "scanner")
      return Promise.resolve({
        step: id,
        status: "passing",
        message: null,
        next: null,
      });
    if (body.settings !== undefined) {
      queued = true;
      return Promise.resolve({
        step: id,
        status: "failing",
        message: "Checking.",
        next: null,
        pending: true,
      });
    }
    return Promise.resolve(
      queued
        ? { step: id, status: "passing", message: "Read.", next: null }
        : { step: id, status: "failing", message: "Not yet.", next: null },
    );
  });
  const view = await mountSetup(withApps(true), () => {
    if (!slow) return Promise.resolve(null);
    return new Promise((resolve) => {
      finishRefetch = () => {
        slow = false;
        resolve(null);
      };
    });
  });
  try {
    expect(view.isOpen(SCANNER_APP)).toBe(true);
    slow = true;
    await view.submit();
    await view.wait(3500);
    expect(view.isOpen(SCANNER_APP)).toBe(true);
    await act(async () => {
      finishRefetch();
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(view.isOpen(GROUP)).toBe(true);
    expect(view.openSections()).toHaveLength(1);
  } finally {
    view.close();
  }
});

it("opens the next section when a worker check passes after polling", async () => {
  let polls = 0;
  let queued = false;
  const answer = (
    id: "app_registration" | "scanner",
    status: "passing" | "failing",
    extra: { pending?: true; message?: string } = {},
  ) =>
    Promise.resolve({
      step: id,
      status,
      message: extra.message ?? null,
      next: null,
      pending: extra.pending,
    });
  vi.mocked(runStep).mockImplementation((id, body) => {
    if (id !== "scanner") return answer("app_registration", "passing");
    // Opening the section looks first and sends nothing, as a poll does; the button queues the worker.
    if (body.settings !== undefined) {
      queued = true;
      return answer(id, "failing", { pending: true, message: "Checking." });
    }
    if (!queued) return answer(id, "failing", { message: "Not scanned yet." });
    polls += 1;
    return polls < 2
      ? answer(id, "failing", { pending: true, message: "Checking." })
      : answer(id, "passing", { message: "The scanner read a workspace." });
  });
  const view = await mountSetup(withApps(true));
  try {
    expect(view.isOpen(SCANNER_APP)).toBe(true);
    await view.submit();
    expect(view.isOpen(SCANNER_APP)).toBe(true);
    await view.wait(3000);
    expect(polls).toBe(1);
    expect(view.isOpen(SCANNER_APP)).toBe(true);
    await view.wait(3000);
    expect(polls).toBe(2);
    expect(view.isOpen(GROUP)).toBe(true);
    expect(view.openSections()).toHaveLength(1);
  } finally {
    view.close();
  }
});

describe("what the sign-in app holds beyond the minimum", () => {
  const OLD_REFUSAL =
    "The app registration holds App.Read.All, which this app does not use. Remove it under API permissions: the app needs only the delegated permissions this step lists.";
  const NOTE =
    "Not needed by this app, which never uses it: App.Read.All. The app can still do what it allows.";
  const withAppCheck = (status: "passing" | "failing", message: string) => {
    const state = withApps(false);
    const step = state.steps.find((each) => each.id === "app_registration");
    if (step === undefined) throw new Error("Missing app_registration");
    step.check = { status, message, checked_at: "2026-10-29T00:00:00Z" };
    return state;
  };
  const answers = (message: string | null) => {
    vi.mocked(runStep)
      .mockClear()
      .mockImplementation((id) =>
        Promise.resolve({
          step: id,
          status: id === "app_registration" ? "passing" : "failing",
          message,
          next: null,
        }),
      );
  };

  it("checks a stored refusal again by itself, and replaces it with the note", async () => {
    answers(NOTE);
    const view = await mountSetup(withAppCheck("failing", OLD_REFUSAL));
    try {
      expect(runStep).toHaveBeenCalledWith("app_registration", {});
      expect(
        vi
          .mocked(runStep)
          .mock.calls.filter(([id]) => id === "app_registration"),
      ).toHaveLength(1);
      expect(view.isOpen(SIGN_IN)).toBe(true);
      expect(view.host.textContent).not.toContain(OLD_REFUSAL);
      expect(view.host.querySelector('[role="alert"]')).toBeNull();
      expect(view.host.querySelector('[role="note"]')?.textContent).toBe(NOTE);
      expect(view.nextButton()).toBeDefined();
    } finally {
      view.close();
    }
  });

  it.each([
    ["holds more", NOTE],
    ["says nothing", null],
  ])(
    "promises nothing the app registration could undo when the check %s",
    async (_label, message) => {
      answers(message);
      const view = await mountSetup(withAppCheck("failing", OLD_REFUSAL));
      try {
        expect(view.host.textContent).not.toContain("It can never:");
        expect(view.host.textContent).not.toContain("write to Power BI at all");
        expect(view.host.textContent).toContain(
          "Whatever else the app registration holds, the app can still do.",
        );
        expect(view.host.querySelector('[role="note"]') !== null).toBe(
          message !== null,
        );
      } finally {
        view.close();
      }
    },
  );

  it("does not check again a check that passed and was marked, or one that points at signing in", async () => {
    answers(null);
    const passed = withAppCheck("passing", NOTE);
    for (const step of passed.steps)
      if (step.id === "app_registration") step.passed = true;
    const signIn = withAppCheck("failing", "Sign in.");
    for (const step of signIn.steps)
      if (step.id === "app_registration") step.action = "sign_in";
    for (const state of [passed, signIn]) {
      const view = await mountSetup(state);
      try {
        expect(
          vi
            .mocked(runStep)
            .mock.calls.filter(([id]) => id === "app_registration"),
        ).toHaveLength(0);
      } finally {
        view.close();
      }
    }
  });
});

/** Answers the credentials check and the full check apart, as the api does on the scanner's one route. */
function scannerAnswers(
  credentials: () => StepAnswer,
  full: () => StepAnswer = () => answerOf("failing", "Not scanned yet."),
) {
  vi.mocked(runStep).mockImplementation((id, body) =>
    Promise.resolve(
      id !== "scanner"
        ? answerOf("passing", null, id)
        : body.credentials_only === true
          ? credentials()
          : full(),
    ),
  );
}
function answerOf(
  status: "passing" | "failing",
  message: string | null,
  step = "scanner",
  more: Partial<StepAnswer> = {},
): StepAnswer {
  return { step, status, message, next: null, ...more };
}
const SETTINGS = "Three Power BI tenant settings";
const rowOf = (host: HTMLElement, title: string) =>
  [...host.querySelectorAll("button[aria-expanded]")].find((button) =>
    button.textContent.startsWith(title),
  )?.textContent;

it("checks only the credentials on the scanner app's button, and moves on to the group", async () => {
  scannerAnswers(() => answerOf("passing", "A token."));
  const view = await mountSetup(withApps(true));
  try {
    expect(view.isOpen(SCANNER_APP)).toBe(true);
    await view.submit();
    expect(runStep).toHaveBeenCalledWith(
      "scanner",
      expect.objectContaining({
        credentials_only: true,
        start_check: true,
        settings: { "powerbi.scanner_client_id": SCANNER_GUID },
      }),
    );
    expect(view.isOpen(GROUP)).toBe(true);
    expect(rowOf(view.host, SCANNER_APP)).toContain("Checked");
    expect(rowOf(view.host, GROUP)).toContain("To do");
    expect(rowOf(view.host, SETTINGS)).toContain("To do");
    expect(view.host.textContent).not.toContain("Your tenant is connected");
  } finally {
    view.close();
  }
});

it("runs the full check from the tenant settings, without credentials_only, and passing it finishes the group and the settings", async () => {
  scannerAnswers(
    () => answerOf("passing", "A token."),
    () => answerOf("passing", "The scanner read 3 of the 3."),
  );
  const view = await mountSetup(withApps(true));
  try {
    await view.submit();
    view.open(SETTINGS);
    vi.mocked(runStep).mockClear();
    await view.submit();
    expect(runStep).toHaveBeenCalledExactlyOnceWith("scanner", {
      start_check: true,
    });
    expect(rowOf(view.host, GROUP)).toContain("Checked");
    expect(rowOf(view.host, SETTINGS)).toContain("Checked");
    expect(rowOf(view.host, SCANNER_APP)).toContain("Checked");
    expect(view.host.textContent).toContain("Your tenant is connected");
  } finally {
    view.close();
  }
});

it("counts the scanner app as done when only the full check passed, as before the two were split", async () => {
  scannerAnswers(
    () => answerOf("failing", "This check has not run yet."),
    () => answerOf("passing", "The scanner read 3 of the 3."),
  );
  const view = await mountSetup(withApps(true));
  try {
    expect(rowOf(view.host, SCANNER_APP)).toContain("Checked");
    expect(rowOf(view.host, GROUP)).toContain("Checked");
    expect(rowOf(view.host, SETTINGS)).toContain("Checked");
    expect(view.host.textContent).toContain("Your tenant is connected");
    expect(view.host.textContent).toContain("Continue: sign in with Microsoft");
  } finally {
    view.close();
  }
});

it("leaves the scanner app undone when neither check passed", async () => {
  scannerAnswers(
    () => answerOf("failing", "This check has not run yet."),
    () => answerOf("failing", "Not scanned yet."),
  );
  const view = await mountSetup(withApps(true));
  try {
    expect(rowOf(view.host, SCANNER_APP)).toContain("To do");
    expect(view.host.textContent).not.toContain("Your tenant is connected");
  } finally {
    view.close();
  }
});

it("reads the stored credentials result from the state until the look comes back", async () => {
  const state = withApps(true);
  const scanner = state.steps.find((step) => step.id === "scanner");
  if (scanner === undefined) throw new Error("No scanner step");
  scanner.credentials = {
    pending: false,
    check: {
      status: "passing",
      message: "A token.",
      checked_at: "2026-10-29T00:00:00Z",
    },
  };
  vi.mocked(runStep).mockImplementation(() => new Promise(() => undefined));
  const view = await mountSetup(state);
  try {
    expect(rowOf(view.host, SCANNER_APP)).toContain("Checked");
    expect(rowOf(view.host, GROUP)).toContain("To do");
  } finally {
    view.close();
  }
});

it("asks for the full check again after new credentials, so its old pass no longer counts", async () => {
  let full = answerOf("passing", "The scanner read 3 of the 3.");
  scannerAnswers(
    () => answerOf("passing", "A token."),
    () => full,
  );
  const view = await mountSetup(withApps(true));
  try {
    expect(rowOf(view.host, GROUP)).toContain("Checked");
    view.open(SCANNER_APP);
    const input = view.host.querySelector("input");
    if (input === null) throw new Error("Missing the scanner's client ID");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "91c0d6a2-4b5e-4f13-8a7d-6e2f1c9b3a41");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rowOf(view.host, GROUP)).toContain("To do");
    full = answerOf("failing", "This check has not run yet.");
    await view.submit();
    expect(rowOf(view.host, SCANNER_APP)).toContain("Checked");
    expect(rowOf(view.host, GROUP)).toContain("To do");
    expect(rowOf(view.host, SETTINGS)).toContain("To do");
  } finally {
    view.close();
  }
});

it("says Checking with the worker's sentence while a check waits, and Needs a fix only once it ran and failed", async () => {
  const SYNCING =
    "The worker is finishing a sync. This check starts right after it.";
  let answer = answerOf("failing", SYNCING, "scanner", { pending: true });
  scannerAnswers(() => ({ ...answer }));
  const view = await mountSetup(withApps(true));
  try {
    await view.submit();
    expect(rowOf(view.host, SCANNER_APP)).toContain("Checking");
    expect(rowOf(view.host, SCANNER_APP)).not.toContain("Needs a fix");
    expect(view.host.querySelector("form [role='status']")?.textContent).toBe(
      SYNCING,
    );
    await view.wait(3000);
    expect(rowOf(view.host, SCANNER_APP)).toContain("Checking");

    answer = answerOf("failing", "Microsoft refused.");
    await view.wait(3000);
    expect(rowOf(view.host, SCANNER_APP)).toContain("Needs a fix");
    expect(view.isOpen(SCANNER_APP)).toBe(true);
  } finally {
    view.close();
  }
});

it("shows Needs a fix on opening for a check that ran and failed before, and not for one that waits", async () => {
  const stored = {
    status: "failing",
    message: "Microsoft refused.",
    checked_at: "2026-10-29T00:00:00Z",
  } as const;
  const state = withApps(true);
  const scanner = state.steps.find((step) => step.id === "scanner");
  if (scanner === undefined) throw new Error("No scanner step");
  scanner.credentials = { pending: false, check: stored };
  scanner.check = stored;
  scannerAnswers(
    () => answerOf("failing", "Microsoft refused."),
    () => answerOf("failing", "Microsoft refused."),
  );
  const failed = await mountSetup(state);
  try {
    expect(rowOf(failed.host, SCANNER_APP)).toContain("Needs a fix");
    expect(rowOf(failed.host, GROUP)).toContain("Needs a fix");
  } finally {
    failed.close();
  }
  scanner.pending = true;
  const waiting = await mountSetup(state);
  try {
    expect(rowOf(waiting.host, SCANNER_APP)).toContain("Needs a fix");
    expect(rowOf(waiting.host, GROUP)).not.toContain("Needs a fix");
  } finally {
    waiting.close();
  }
});

it("does not say Needs a fix for a check never run", async () => {
  scannerAnswers(() =>
    answerOf("failing", "This check has not run yet. Run it on this step."),
  );
  const view = await mountSetup(withApps(true));
  try {
    expect(rowOf(view.host, SCANNER_APP)).toContain("To do");
    expect(rowOf(view.host, GROUP)).toContain("To do");
    expect(view.host.querySelector("[role='alert']")).toBeNull();
  } finally {
    view.close();
  }
});

const alerts = (host: HTMLElement) =>
  [...host.querySelectorAll("[role='alert']")].map((box) => box.textContent);

it("shows a failed check's sentence in an error box by the button, and not in the quiet line", async () => {
  scannerAnswers(() => answerOf("failing", "Microsoft refused."));
  const view = await mountSetup(withApps(true));
  try {
    await view.submit();
    expect(alerts(view.host)).toEqual(["Microsoft refused."]);
    const box = view.host.querySelector("[role='alert']");
    expect(box?.className).toContain("text-out");
    expect(box?.className).toContain("border-out");
    const button = [...view.host.querySelectorAll("button")].find(
      (each) => each.textContent === "Check the scanner app",
    );
    expect(button?.nextElementSibling).toBe(box);
    expect(view.host.querySelector("form [role='status']")).toBeNull();
  } finally {
    view.close();
  }
});

it("shows the full check's failure on both of its sections", async () => {
  scannerAnswers(
    () => answerOf("passing", "A token."),
    () =>
      answerOf("failing", "Power BI refused admin APIs.", "scanner", {
        details: { reason: "tenant_settings" },
      }),
  );
  const view = await mountSetup(withApps(true));
  try {
    await view.submit();
    view.open(SETTINGS);
    await view.submit();
    expect(alerts(view.host)).toEqual(["Power BI refused admin APIs."]);
    view.open(GROUP);
    expect(alerts(view.host)).toEqual(["Power BI refused admin APIs."]);
    view.open(SCANNER_APP);
    expect(alerts(view.host)).toEqual([]);
  } finally {
    view.close();
  }
});

it("keeps waiting and passing lines quiet, with no error box", async () => {
  let answer = answerOf(
    "failing",
    "The worker is finishing a sync.",
    "scanner",
    {
      pending: true,
    },
  );
  scannerAnswers(() => ({ ...answer }));
  const view = await mountSetup(withApps(true));
  try {
    await view.submit();
    expect(alerts(view.host)).toEqual([]);
    expect(view.host.querySelector("form [role='status']")?.textContent).toBe(
      "The worker is finishing a sync.",
    );
    answer = answerOf("passing", "A token.");
    await view.wait(3000);
    view.open(SCANNER_APP);
    expect(alerts(view.host)).toEqual([]);
    expect(view.host.querySelector("form [role='status']")?.textContent).toBe(
      "Checked: the scanner signs in with its own registration.",
    );
  } finally {
    view.close();
  }
});

it("shows a never run check's sentence quietly, as no failure", async () => {
  scannerAnswers(() =>
    answerOf("failing", "This check has not run yet. Run it on this step."),
  );
  const view = await mountSetup(withApps(true));
  try {
    expect(alerts(view.host)).toEqual([]);
    expect(view.host.querySelector("form [role='status']")?.textContent).toBe(
      "This check has not run yet. Run it on this step.",
    );
  } finally {
    view.close();
  }
});

const submitButton = (host: HTMLElement) => {
  const found = host.querySelector<HTMLButtonElement>(
    "form button[type='submit']",
  );
  if (found === null) throw new Error("Missing the section's check button");
  return found;
};

it.each([
  ["The sign-in app", "Check the sign-in app", false],
  ["The scanner app", "Check the scanner app", true],
  ["Three Power BI tenant settings", "Check the scanner", true],
])(
  "reads Checking... and stays disabled while %s's check is under way, then returns",
  async (section, label, signedIn) => {
    const waiting = answerOf("failing", "Waiting.", "any", { pending: true });
    let polled = answerOf("failing", "Not yet.");
    vi.mocked(runStep).mockImplementation((_id, body) =>
      Promise.resolve(
        body.start_check === true || body.settings !== undefined
          ? { ...waiting }
          : { ...polled },
      ),
    );
    const view = await mountSetup(withApps(signedIn));
    try {
      view.open(section);
      await view.wait(0);
      expect(submitButton(view.host).textContent).toBe(label);
      expect(submitButton(view.host).disabled).toBe(false);

      polled = waiting;
      await view.submit();
      expect(submitButton(view.host).textContent).toBe("Checking...");
      expect(submitButton(view.host).disabled).toBe(true);
      await view.wait(3000);
      expect(submitButton(view.host).textContent).toBe("Checking...");
      expect(submitButton(view.host).disabled).toBe(true);

      polled = answerOf("failing", "Failed.");
      await view.wait(3000);
      expect(submitButton(view.host).textContent).toBe(label);
      expect(submitButton(view.host).disabled).toBe(false);
    } finally {
      view.close();
    }
  },
);

it.each([
  ["The sign-in app", "Check the sign-in app", false, "app_registration"],
  ["The scanner app", "Check the scanner app", true, "scanner"],
  ["Three Power BI tenant settings", "Check the scanner", true, "scanner"],
])(
  "ends Checking... and shows the error when a poll of %s's check fails",
  async (section, label, signedIn, id) => {
    const waiting = answerOf("failing", "Waiting.", id, { pending: true });
    let polling = false;
    vi.mocked(runStep).mockImplementation((_id, body) => {
      if (body.start_check === true || body.settings !== undefined) {
        polling = true;
        return Promise.resolve({ ...waiting });
      }
      return polling
        ? Promise.reject(new ApiError(500, "internal", "The api failed."))
        : Promise.resolve(answerOf("failing", "Not yet.", id));
    });
    const view = await mountSetup(withApps(signedIn));
    try {
      view.open(section);
      await view.wait(0);
      await view.submit();
      expect(submitButton(view.host).textContent).toBe("Checking...");
      await view.wait(3000);
      await view.wait(1);
      expect(submitButton(view.host).textContent).toBe(label);
      expect(submitButton(view.host).disabled).toBe(false);
      expect(view.host.textContent).toContain("The api failed.");
      expect(view.host.textContent).not.toContain("Waiting.");
      const asked = vi.mocked(runStep).mock.calls.length;
      await view.wait(30_000);
      expect(vi.mocked(runStep).mock.calls.length).toBe(asked);
    } finally {
      view.close();
    }
  },
);

it("keeps Checking... through a rate limit on a poll, and asks again", async () => {
  const waiting = answerOf("failing", "Waiting.", "any", { pending: true });
  let polls = 0;
  vi.mocked(runStep).mockImplementation((_id, body) => {
    if (body.start_check === true) return Promise.resolve({ ...waiting });
    polls += 1;
    return polls === 2
      ? Promise.reject(new ApiError(429, "rate_limited", "Slow down."))
      : Promise.resolve({ ...waiting });
  });
  const view = await mountSetup(withApps(true));
  try {
    view.open(SETTINGS);
    await view.wait(0);
    await view.submit();
    await view.wait(3000);
    await view.wait(3000);
    expect(submitButton(view.host).textContent).toBe("Checking...");
    expect(view.host.textContent).not.toContain("Slow down.");
    const asked = polls;
    await view.wait(10_000);
    expect(polls).toBeGreaterThan(asked);
  } finally {
    view.close();
  }
});

it("reads Checking... while the request itself is out, before any answer", async () => {
  let release: (answer: StepAnswer) => void = () => undefined;
  vi.mocked(runStep).mockImplementation(
    (id, body) =>
      new Promise((resolve) => {
        if (id === "app_registration" && body.settings !== undefined)
          release = resolve;
        else resolve(answerOf("failing", "Not yet."));
      }),
  );
  const view = await mountSetup(withApps(false));
  try {
    expect(submitButton(view.host).textContent).toBe("Check the sign-in app");
    await view.submit();
    expect(submitButton(view.host).textContent).toBe("Checking...");
    expect(submitButton(view.host).disabled).toBe(true);
    await act(async () => {
      release(answerOf("failing", "Refused.", "app_registration"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(submitButton(view.host).textContent).toBe("Check the sign-in app");
    expect(submitButton(view.host).disabled).toBe(false);
  } finally {
    view.close();
  }
});

it("holds the scanner's other check while one runs, as both read the same credentials", async () => {
  scannerAnswers(
    () => answerOf("passing", "A token."),
    () => answerOf("failing", "Scanning.", "scanner", { pending: true }),
  );
  const view = await mountSetup(withApps(true));
  try {
    view.open(SETTINGS);
    await view.wait(0);
    expect(submitButton(view.host).textContent).toBe("Checking...");
    view.open(SCANNER_APP);
    expect(submitButton(view.host).textContent).toBe("Checking...");
    expect(submitButton(view.host).disabled).toBe(true);
  } finally {
    view.close();
  }
});
