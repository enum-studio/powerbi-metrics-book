// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { putSecret, putSecretExpiry, type Secret } from "./api";
import { checkOfSecret, expiry, SecretRow } from "./secret-row";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  putSecret: vi.fn(),
  putSecretExpiry: vi.fn(),
}));

const NOW = Date.parse("2026-10-26T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const in_ = (days: number) => new Date(NOW + days * DAY).toISOString();

describe("expiry", () => {
  it("says nothing urgent for a secret with more than 30 days", () => {
    expect(expiry(in_(31), NOW)).toEqual({
      text: "expires on 2026-11-26",
      tone: "text-ink-2",
    });
  });

  it("marks a secret within 30 days, and again within 7", () => {
    const month = expiry(in_(30), NOW);
    expect(month.text).toBe(
      "expires in 30 days, on 2026-11-25: within 30 days",
    );
    expect(month.tone).toContain("font-semibold");
    const week = expiry(in_(7), NOW);
    expect(week.text).toBe(
      "expires in 7 days, on 2026-11-02: enter a new one now",
    );
    expect(week.tone).toContain("text-out");
    expect(expiry(in_(8), NOW).text).toContain("within 30 days");
  });

  it("says a secret has expired from the moment it has", () => {
    expect(expiry(in_(-1), NOW).text).toBe("expired on 2026-10-25");
    expect(expiry(new Date(NOW).toISOString(), NOW).text).toContain("expired");
  });
});

describe("checkOfSecret", () => {
  it("names the check that reads each secret", () => {
    expect(checkOfSecret("powerbi_scanner_client_secret")).toBe("scanner");
    expect(checkOfSecret("sign_in_okta_client_secret")).toBe("sign_in");
    expect(checkOfSecret("gemini_api_key")).toBe("search");
    expect(checkOfSecret("result_link_key")).toBeNull();
  });
});

const SAVED: Secret = {
  name: "powerbi_app_client_secret",
  readers: ["api"],
  set: true,
  needs_reentry_for: [],
  hint: "cret",
  set_by: "admin@sample.example",
  set_at: "2026-10-26T10:00:00Z",
  expires_at: null,
  checked_at: null,
  check_status: null,
  check_message: null,
};

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  vi.mocked(putSecret).mockReset();
  vi.mocked(putSecretExpiry).mockReset();
  document.body.replaceChildren();
});

async function type(host: HTMLElement, selector: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(selector);
  if (field === null) throw new Error(`No field ${selector}.`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function openDateForm(secret: Secret) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <SecretRow secret={secret} />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  const button = (name: string) => {
    const found = [...host.querySelectorAll("button")].find(
      (each) => each.textContent === name,
    );
    if (found === undefined) throw new Error(`No button called ${name}.`);
    return found;
  };
  const press = (name: string) =>
    act(async () => {
      button(name).click();
      await Promise.resolve();
    });
  await press("Expiry date");
  return { host, press };
}

describe("saving a secret's expiry date", () => {
  it("says a date is needed, and sends nothing, when no date is entered and none is saved", async () => {
    const { host, press } = await openDateForm(SAVED);

    await press("Save date");

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Enter a date first. Nothing was saved.",
    );
    expect(putSecretExpiry).not.toHaveBeenCalled();
    expect(host.querySelector('input[type="date"]')).not.toBeNull();
  });

  it("says the date is removed when the field is emptied over a saved date", async () => {
    const { host, press } = await openDateForm({
      ...SAVED,
      expires_at: "2027-06-30T23:59:59Z",
    });
    expect(
      host.querySelector<HTMLInputElement>('input[type="date"]')?.value,
    ).toBe("2027-06-30");
    await type(host, 'input[type="date"]', "");

    await press("Save date");

    expect(putSecretExpiry).toHaveBeenCalledWith(
      "powerbi_app_client_secret",
      null,
    );
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "The expiry date is removed. The status page no longer warns before it expires.",
    );
    expect(host.querySelector('input[type="date"]')).toBeNull();
  });

  it("drops the sentence about a saved date once the value is replaced", async () => {
    const { host, press } = await openDateForm(SAVED);
    await type(host, 'input[type="date"]', "2027-06-30");
    await press("Save date");
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "The expiry date is saved: 2027-06-30.",
    );

    await press("Replace");
    await type(host, 'input[type="password"]', "a-new-value");
    await press("Save secret");

    expect(putSecret).toHaveBeenCalledWith(SAVED.name, "a-new-value", null);
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});
