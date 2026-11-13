// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { follow, runStep } from "./api";
import { click, mount } from "./screen-test-support";
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  follow: vi.fn(),
  runStep: vi.fn(),
}));
beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(follow).mockReset().mockResolvedValue();
  vi.mocked(runStep)
    .mockReset()
    .mockResolvedValue({
      step: "app_registration",
      status: "failing",
      message: "The last connection failed.",
      action: "connect",
      next: { method: "GET", path: "/api/v1/powerbi/connect?next=/setup" },
    });
  sessionStorage.clear();
});
it.each([false, true])("requires pending=%s", async (pending) => {
  if (pending)
    sessionStorage.setItem("pbmb.setup.powerbi_connect_pending", "1");
  vi.mocked(follow).mockRejectedValueOnce(
    new Error("Microsoft did not answer."),
  );
  const view = await mount("sign-in");
  try {
    expect(follow).toHaveBeenCalledTimes(pending ? 1 : 0);
    expect(view.host.querySelectorAll("h1")).toHaveLength(1);
    expect(view.host.textContent.match(/Step 3 of 6/g)).toHaveLength(1);
    expect(view.host.textContent).toContain(
      pending ? "Microsoft did not answer." : "The last connection failed.",
    );
    vi.mocked(follow).mockResolvedValue();
    await click(view.host, "Connect Power BI");
    expect(follow).toHaveBeenCalledTimes(pending ? 2 : 1);
  } finally {
    view.close();
  }
});

it.each([false, true])("confirms with blocked=%s", async (blocked) => {
  vi.mocked(runStep).mockResolvedValueOnce({
    step: "app_registration",
    status: "failing",
    message: null,
    confirm: { email: "admin@sample.example", name: "Sample admin" },
    next: null,
  });
  const view = await mount("sign-in", "setup_link");
  try {
    expect(follow).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain(
      "Signed in as Sample admin, admin@sample.example",
    );
    if (blocked)
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("Blocked", "SecurityError");
      });
    await click(view.host, "Make me the admin");
    expect(runStep).toHaveBeenLastCalledWith("app_registration", {
      confirm_email: "admin@sample.example",
    });
    expect(follow).toHaveBeenCalledTimes(blocked ? 0 : 1);
    expect(
      sessionStorage.getItem("pbmb.setup.powerbi_connect_pending"),
    ).toBeNull();
  } finally {
    view.close();
  }
});
it("rechecks a successful Power BI return", async () => {
  vi.mocked(runStep).mockResolvedValue({
    step: "app_registration",
    status: "passing",
    message: null,
    next: null,
  });
  const view = await mount("sign-in");
  try {
    expect(view.router.state.location.search.step).toBe("sync");
  } finally {
    view.close();
  }
});
it.each(["return", "getItem", "setItem", "removeItem"] as const)(
  "keeps retries manual after %s",
  async (method) => {
    if (method === "return") {
      sessionStorage.setItem("pbmb.setup.powerbi_connect_pending", "1");
      const first = await mount("sign-in");
      first.close();
      vi.mocked(follow).mockClear();
    } else {
      if (method !== "setItem")
        sessionStorage.setItem("pbmb.setup.powerbi_connect_pending", "1");
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("Blocked", "SecurityError");
      });
    }
    const view = await mount("sign-in");
    try {
      expect(follow).not.toHaveBeenCalled();
      expect(view.host.textContent).toContain("The last connection failed.");
      await click(view.host, "Connect Power BI");
      expect(follow).toHaveBeenCalledTimes(1);
    } finally {
      view.close();
    }
  },
);

it("omits the normal sign-in readiness sentence", async () => {
  vi.mocked(runStep).mockResolvedValue({
    step: "app_registration",
    status: "failing",
    action: "sign_in",
    message:
      "The app registration works. Sign in with Microsoft now: you become the first admin.",
    next: null,
  });
  const view = await mount("sign-in", "setup_link");
  try {
    expect(view.host.textContent).not.toContain("The app registration works.");
  } finally {
    view.close();
  }
});

const OLD_REFUSAL =
  "The app registration holds App.Read.All, which this app does not use. Remove it under API permissions: the app needs only the delegated permissions this step lists.";
const checkedAs = (status: "passing" | "failing", message: string | null) => ({
  action: null,
  passed: false,
  check: { status, message, checked_at: "2026-10-29T00:00:00Z" },
});
const NOTE =
  "Not needed by this app, which never uses it: App.Read.All. The app can still do what it allows.";

it.each([
  ["refused by an earlier release's rule", checkedAs("failing", OLD_REFUSAL)],
  ["passed by the daily run, unmarked", checkedAs("passing", NOTE)],
])(
  "checks again by itself and goes on when the stored check was %s",
  async (_, app) => {
    vi.mocked(runStep).mockResolvedValue({
      step: "app_registration",
      status: "passing",
      message: NOTE,
      next: null,
    });
    const view = await mount("sign-in", "admin", false, app);
    try {
      expect(runStep).toHaveBeenCalledTimes(1);
      expect(runStep).toHaveBeenCalledWith("app_registration", {});
      expect(view.router.state.location.search).toEqual({ step: "sync" });
    } finally {
      view.close();
    }
  },
);

it("does not check again when the step is marked as passed", async () => {
  const view = await mount("sign-in", "admin", false, {
    ...checkedAs("passing", NOTE),
    passed: true,
  });
  try {
    expect(runStep).not.toHaveBeenCalled();
  } finally {
    view.close();
  }
});
