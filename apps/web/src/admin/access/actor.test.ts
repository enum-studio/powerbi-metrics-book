import { describe, expect, it } from "vitest";
import { actorName } from "./actor";

const PEOPLE = [{ id: "u1", email: "admin@sample.example" }];

describe("actorName", () => {
  it("names the setup link as the setup link, not as a person", () => {
    expect(actorName(PEOPLE, "person", "setup_link")).toBe("the setup link");
  });

  it("gives a known person's email, and anyone else's kind and id", () => {
    expect(actorName(PEOPLE, "person", "u1")).toBe("admin@sample.example");
    expect(actorName(PEOPLE, "service_account", "reader")).toBe(
      "service_account reader",
    );
  });
});
