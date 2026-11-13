import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClientName, clientLabel } from "./client-name";

type Client = Parameters<typeof ClientName>[0]["client"];
const client = (over: Partial<Client> = {}): Client => ({
  client_id: "client-1",
  client_name: "Sample client",
  via: "mcp",
  ...over,
});
const html = (over: Partial<Client> = {}) =>
  renderToStaticMarkup(createElement(ClientName, { client: client(over) }));

describe("clientLabel", () => {
  it("takes out the characters that reorder the text around a name", () => {
    const sneaky = "Claude‮ gnp.exe⁦‏؜";
    expect(clientLabel({ client_name: sneaky })).toBe("Claude gnp.exe");
  });

  it("cuts a long name to 80 characters and an ellipsis, by whole characters", () => {
    const label = clientLabel({ client_name: "a".repeat(81) });
    expect(label).toBe(`${"a".repeat(80)}…`);
    expect(clientLabel({ client_name: "a".repeat(80) })).toBe("a".repeat(80));
    const emoji = clientLabel({ client_name: "\u{1F600}".repeat(81) });
    expect(Array.from(emoji)).toHaveLength(81);
  });

  it("says so for a client with no name", () => {
    expect(clientLabel({ client_name: null })).toBe("An app with no name");
  });
});

describe("ClientName", () => {
  it("shows the cut name in a bdi, with the full name in its title", () => {
    const full = "b".repeat(100);
    const out = html({ client_name: full });
    expect(out).toContain("<bdi");
    expect(out).toContain(`title="${full}"`);
    expect(out).toContain(`${"b".repeat(80)}…`);
    expect(out).not.toContain(`>${full}<`);
  });

  it("shows an MCP client's id beside its name, so a copied name cannot hide which client it is", () => {
    expect(html({ via: "mcp" })).toContain("<code");
    expect(html({ via: "mcp" })).toContain("client-1");
  });

  it("shows the id of a client with no name, and nothing extra for a named CLI", () => {
    const unnamed = html({ via: "cli", client_name: null });
    expect(unnamed).toContain("An app with no name");
    expect(unnamed).toContain("client-1");
    expect(html({ via: "cli" })).not.toContain("client-1");
  });
});
