// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { ApiError } from "../../api/client";
import {
  PERSON,
  buttons,
  mountAccess,
  press,
  type,
} from "./access-test-support";
import {
  deactivatePerson,
  deletePerson,
  setPersonPii,
  setPersonRole,
  signOutPerson,
} from "./api";
import { PeopleTable, WhoGetsIn } from "./people-table";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  setPersonRole: vi.fn(),
  setPersonPii: vi.fn(),
  deactivatePerson: vi.fn(),
  signOutPerson: vi.fn(),
  deletePerson: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(setPersonRole).mockReset();
  vi.mocked(setPersonPii).mockReset();
  vi.mocked(deactivatePerson).mockReset();
  vi.mocked(signOutPerson).mockReset();
  vi.mocked(deletePerson).mockReset();
});

const FINANCE = {
  id: "22222222-2222-4222-8222-222222222222",
  role: "viewer",
  subject_kind: "group" as const,
  subject: "Finance",
  provider: "microsoft",
  granted_by: "admin@sample.example",
  granted_at: "2030-03-04T12:00:00Z",
};

it.each(["direct", "inherited", "none"] as const)(
  "shows the %s PII state and changes only direct assignments",
  async (source) => {
    const view = await mountAccess(PeopleTable, {
      people: [{ ...PERSON, pii_reader: { source, assignments: [FINANCE] } }],
    });
    try {
      const box = view.host.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      );
      if (!box) throw new Error("Missing the PII checkbox");
      expect(box.checked).toBe(source !== "none");
      expect(box.disabled).toBe(source === "inherited");
      if (source === "inherited") {
        expect(view.host.textContent).toContain("From group Finance");
      }
      await act(async () => {
        box.click();
        await Promise.resolve();
      });
      if (source === "inherited") expect(setPersonPii).not.toHaveBeenCalled();
      else
        expect(setPersonPii).toHaveBeenCalledWith(PERSON.id, source === "none");
    } finally {
      view.close();
    }
  },
);

it("shows the API's refusal when changing one's own PII assignment", async () => {
  const sentence = "You cannot change your own PII assignment.";
  vi.mocked(setPersonPii).mockRejectedValue(
    new ApiError(409, "conflict", sentence),
  );
  const view = await mountAccess(PeopleTable, { people: [PERSON] });
  try {
    const box = view.host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!box) throw new Error("Missing the PII checkbox");
    await act(async () => {
      box.click();
      await Promise.resolve();
    });
    expect(view.host.textContent).toContain(sentence);
  } finally {
    view.close();
  }
});

it("shows a deactivated person's roles alongside their status", async () => {
  const view = await mountAccess(PeopleTable, {
    people: [
      {
        ...PERSON,
        status: "deactivated",
        roles: [{ role: "viewer", assignments: [FINANCE], by_default: false }],
      },
    ],
  });
  try {
    const row = view.host.querySelector("tbody tr");
    expect(row?.querySelector('[data-label="Role"]')?.textContent).toBe(
      "Viewer from group Finance",
    );
    expect(row?.querySelector('[data-label="Status"]')?.textContent).toBe(
      "Deactivated",
    );
  } finally {
    view.close();
  }
});

it("lists deactivated people apart from active people turned away at sign-in", async () => {
  const view = await mountAccess(WhoGetsIn, {
    people: [
      { ...PERSON, status: "deactivated", roles: [] },
      { ...PERSON, id: FINANCE.id, email: "grace@sample.example", roles: [] },
    ],
  });
  try {
    expect(view.host.textContent).toContain(
      "Turned away at sign-in: grace@sample.example.",
    );
    expect(view.host.textContent).toContain(`Deactivated: ${PERSON.email}.`);
  } finally {
    view.close();
  }
});

it("changes a direct role from its select, and shows an inherited role with where it comes from", async () => {
  const inherited = {
    ...PERSON,
    id: "33333333-3333-4333-8333-333333333333",
    email: "grace@sample.example",
    direct_role: null,
    roles: [{ role: "viewer", assignments: [FINANCE], by_default: false }],
  };
  const view = await mountAccess(PeopleTable, { people: [PERSON, inherited] });
  try {
    const select = view.host.querySelector<HTMLSelectElement>(
      `select[aria-label="Role for ${PERSON.email}"]`,
    );
    if (!select) throw new Error("Missing the role select");
    type(select, "curator");
    expect(setPersonRole).toHaveBeenCalledWith(PERSON.id, "curator");
    expect(
      view.host.querySelector(
        `select[aria-label="Role for ${inherited.email}"]`,
      ),
    ).toBeNull();
    const row = view.host.querySelectorAll("tbody tr")[1];
    expect(row?.querySelector('[data-label="Role"]')?.textContent).toBe(
      "Viewer from group Finance",
    );
  } finally {
    view.close();
  }
});

it("asks by name before it deactivates a person", async () => {
  const view = await mountAccess(PeopleTable, { people: [PERSON] });
  try {
    expect(buttons(view.host, "Delete")).toEqual([]);
    await press(view.host, "Deactivate");
    expect(view.host.textContent).toContain(
      "Deactivate Ada Sample? This ends their sessions and disconnects Power BI, MCP and CLI.",
    );
    expect(deactivatePerson).not.toHaveBeenCalled();
    await press(view.host, "Deactivate");
    expect(deactivatePerson).toHaveBeenCalledWith(PERSON.id);
  } finally {
    view.close();
  }
});

it("asks by name before it signs a person out, and offers it only while they are active", async () => {
  const view = await mountAccess(PeopleTable, { people: [PERSON] });
  try {
    await press(view.host, "Sign out");
    expect(view.host.textContent).toContain(
      "Sign out Ada Sample everywhere? This ends their sessions and their MCP and CLI access. Their roles and Power BI connection stay.",
    );
    expect(signOutPerson).not.toHaveBeenCalled();
    await press(view.host, "Sign out");
    expect(signOutPerson).toHaveBeenCalledWith(PERSON.id);
  } finally {
    view.close();
  }
  const deactivated = await mountAccess(PeopleTable, {
    people: [{ ...PERSON, status: "deactivated" }],
  });
  try {
    expect(buttons(deactivated.host, "Sign out")).toEqual([]);
  } finally {
    deactivated.close();
  }
});

it("deletes a deactivated person once their email is typed, in any case", async () => {
  const view = await mountAccess(PeopleTable, {
    people: [
      {
        ...PERSON,
        status: "deactivated",
        deactivated_at: "2030-03-04T12:00:00Z",
      },
    ],
  });
  try {
    expect(buttons(view.host, "Reactivate")).toHaveLength(1);
    await press(view.host, "Delete");
    const dialog = view.host.querySelector(
      'dialog[aria-label="Delete Ada Sample"]',
    );
    const confirm = dialog?.querySelector("input");
    if (!dialog || !confirm) throw new Error("Missing the delete confirm");
    const remove = buttons(dialog, "Delete")[0];
    expect(remove?.disabled).toBe(true);
    type(confirm, "Ada@Sample.Example");
    expect(remove?.disabled).toBe(false);
    await press(dialog, "Delete");
    expect(deletePerson).toHaveBeenCalledWith(PERSON.id);
  } finally {
    view.close();
  }
});
