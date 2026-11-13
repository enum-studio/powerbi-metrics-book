import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools } from "../../test/deps.js";
import { warningApp } from "../../test/forwarded-for-support.js";

/*
 * The warning about X-Forwarded-For from outside TRUSTED_PROXY is how an
 * operator learns that the proxy's address changed. Whoever sends the header
 * chooses its value, so no line may hold it, and a neighbour that floods the
 * api with the header must not push the proxy's own line out of the log.
 */

afterAll(closeTestPools);

const PROXY = "10.0.1.25";

describe("forwardedForWarning", () => {
  it("never writes the header's value", async () => {
    const { send, lines, advance } = warningApp({ TRUSTED_PROXY: PROXY });
    const values = [
      "198.51.100.77",
      "198.51.100.78, 203.0.113.79",
      "[2001:db8::80]:51234",
      "pbmb_sk_chosen-by-the-sender",
      '","level":"error","msg":"forged',
    ];
    for (const value of values) {
      await send("10.0.1.30", { "x-forwarded-for": value });
      await send("10.0.1.31", { "x-forwarded-for": value });
      advance(60_000);
    }
    expect(lines.length).toBeGreaterThanOrEqual(values.length);
    for (const line of lines) {
      expect(Object.keys(JSON.parse(line) as object).toSorted()).toEqual([
        "level",
        "msg",
        "peer",
        "requests",
        "time",
        "trusted_proxy",
      ]);
      for (const value of values) expect(line).not.toContain(value);
      for (const part of ["198.51.100.", "203.0.113.", "2001:db8", "pbmb_sk"])
        expect(line).not.toContain(part);
    }
  });

  it("names the proxy's new address however many requests a neighbour sends", async () => {
    const { send, warnings, advance } = warningApp({ TRUSTED_PROXY: PROXY });
    const forwarded = { "x-forwarded-for": "203.0.113.9" };
    await send("10.0.1.31", forwarded);
    for (let sent = 0; sent < 200; sent += 1)
      await send("10.0.1.31", forwarded);
    await send("10.0.1.30", forwarded);
    advance(60_000);
    await send("10.0.1.31", forwarded);
    expect(warnings().slice(1)).toMatchObject([
      { peer: "10.0.1.31", requests: 201 },
      { peer: "10.0.1.30", requests: 1 },
    ]);
  });
});
