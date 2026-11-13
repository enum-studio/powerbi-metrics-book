// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { Field } from "./api";
import { inputOf, SecretField } from "./fields";

function render(set: boolean) {
  const field: Field & { kind: "secret" } = {
    kind: "secret",
    name: "powerbi_app_client_secret",
    set,
    expires_at: null,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <SecretField
        field={field}
        draft={undefined}
        disabled={false}
        onChange={() => undefined}
      />,
    );
  });
  const input = host.querySelector("input");
  if (input === null) throw new Error("Missing the secret input");
  return {
    input,
    host,
    close: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

it("shows five stars as the placeholder of a saved secret and keeps the value empty", () => {
  const { input, host, close } = render(true);
  try {
    expect(input.placeholder).toBe("*****");
    expect(input.value).toBe("");
    expect(input.required).toBe(false);
    expect(host.textContent).toContain(
      "A value is saved. Enter a new one only to replace it.",
    );
  } finally {
    close();
  }
});

it("shows no placeholder and requires a value when none is saved", () => {
  const { input, host, close } = render(false);
  try {
    expect(input.placeholder).toBe("");
    expect(input.value).toBe("");
    expect(input.required).toBe(true);
    expect(host.textContent).not.toContain("A value is saved");
  } finally {
    close();
  }
});

describe("inputOf", () => {
  const saved = (expires_at: string | null, set = true) => [
    {
      kind: "secret" as const,
      name: "powerbi_app_client_secret",
      set,
      expires_at,
    },
  ];
  const typed = (value: string, expires: string) => ({
    settings: {},
    secrets: { powerbi_app_client_secret: { value, expires } },
  });

  it("sends a date typed without a value, for a saved secret", () => {
    expect(inputOf(saved(null), typed("", "2027-06-30")).secrets).toEqual({
      powerbi_app_client_secret: { expires_at: "2027-06-30T23:59:59.000Z" },
    });
  });

  it("sends nothing when the date is the one already saved", () => {
    expect(
      inputOf(saved("2027-06-30T23:59:59.000Z"), typed("", "2027-06-30"))
        .secrets,
    ).toEqual({});
  });

  it("sends a value with its date", () => {
    expect(inputOf(saved(null), typed("new", "2027-06-30")).secrets).toEqual({
      powerbi_app_client_secret: {
        value: "new",
        expires_at: "2027-06-30T23:59:59.000Z",
      },
    });
  });

  it("sends no date for a secret with no value saved", () => {
    expect(
      inputOf(saved(null, false), typed("", "2027-06-30")).secrets,
    ).toEqual({});
  });
});

it("blanks a saved date when a new value is typed, and brings it back when the value is removed", () => {
  const field: Field & { kind: "secret" } = {
    kind: "secret",
    name: "powerbi_app_client_secret",
    set: true,
    expires_at: "2027-06-30T23:59:59.000Z",
  };
  const seen: { value: string; expires: string }[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const show = (draft: { value: string; expires: string } | undefined) => {
    act(() => {
      root.render(
        <SecretField
          field={field}
          draft={draft}
          disabled={false}
          onChange={(next) => {
            seen.push(next);
          }}
        />,
      );
    });
  };
  const type = (text: string) => {
    const input = host.querySelector<HTMLInputElement>("input");
    if (input === null) throw new Error("Missing the secret input");
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  try {
    show(undefined);
    expect(
      host.querySelector<HTMLInputElement>('input[type="date"]')?.value,
    ).toBe("2027-06-30");
    type("new");
    expect(seen.at(-1)).toEqual({ value: "new", expires: "" });
    show({ value: "new", expires: "" });
    type("");
    expect(seen.at(-1)).toEqual({ value: "", expires: "2027-06-30" });
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
  }
});
