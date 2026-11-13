import { describe, expect, it } from "vitest";
import { agentValues, GUIDES } from "./guide";

const ORIGIN = "https://book.example.com";

describe("agentValues", () => {
  it("gives the connector's address, the install line and a login the CLI accepts", () => {
    expect(agentValues(ORIGIN)).toEqual([
      { label: "MCP address", value: `${ORIGIN}/api/mcp` },
      {
        label: "Install the CLI",
        value: "uv tool install powerbi-metrics-book",
      },
      { label: "Sign the CLI in", value: `pbmb login --url ${ORIGIN}` },
    ]);
  });

  it("is what the Agents step shows", () => {
    expect(GUIDES.agents.copy(ORIGIN)).toEqual(agentValues(ORIGIN));
  });
});

describe("the app registration step", () => {
  it("names Microsoft's current label first, and the older one for an older portal", () => {
    const line = GUIDES.app_registration.todo.find((todo) =>
      todo.includes("New registration"),
    );
    expect(line).toContain("Single tenant only");
    expect(line).toContain("Accounts in this organizational directory only");
    expect(line?.indexOf("Single tenant only")).toBeLessThan(
      line?.indexOf("organizational directory") ?? 0,
    );
  });
});
