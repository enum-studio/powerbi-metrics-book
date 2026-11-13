import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools } from "../../test/deps.js";
import { warningApp } from "../../test/forwarded-for-support.js";

afterAll(closeTestPools);

const PROXY = "10.0.1.25";
const STALE_PROXY = "10.0.1.30";
const NEIGHBOUR = "10.0.1.31";
const FORWARDED = { "x-forwarded-for": "203.0.113.9" };

describe("forwardedForWarning", () => {
  it("warns when X-Forwarded-For comes from outside TRUSTED_PROXY, naming the connection", async () => {
    const { send, warnings } = warningApp({ TRUSTED_PROXY: PROXY });
    const answer = await send(STALE_PROXY, FORWARDED);
    expect(answer.status).toBe(200);
    expect(warnings()).toEqual([
      {
        time: expect.any(String) as unknown,
        level: "warn",
        msg: "X-Forwarded-For from a connection outside TRUSTED_PROXY",
        peer: STALE_PROXY,
        trusted_proxy: PROXY,
        requests: 1,
      },
    ]);
  });

  it("warns at most once a minute, with a line and a count for each connection", async () => {
    const { send, warnings, advance } = warningApp({ TRUSTED_PROXY: PROXY });
    await send(STALE_PROXY, FORWARDED);
    advance(30_000);
    await send(STALE_PROXY, FORWARDED);
    for (let sent = 0; sent < 3; sent += 1) await send(NEIGHBOUR, FORWARDED);
    advance(29_999);
    await send(STALE_PROXY, FORWARDED);
    expect(warnings()).toHaveLength(1);
    advance(1);
    await send(NEIGHBOUR, FORWARDED);
    expect(warnings()).toMatchObject([
      { peer: STALE_PROXY, requests: 1 },
      { peer: STALE_PROXY, requests: 2 },
      { peer: NEIGHBOUR, requests: 4 },
    ]);
  });

  it("counts only the requests it warns about", async () => {
    const { send, warnings, advance } = warningApp({ TRUSTED_PROXY: PROXY });
    await send(STALE_PROXY, FORWARDED);
    advance(10_000);
    for (let sent = 0; sent < 3; sent += 1) await send(PROXY, FORWARDED);
    await send(STALE_PROXY);
    await send(STALE_PROXY);
    advance(60_000);
    await send(STALE_PROXY, FORWARDED);
    expect(warnings()).toMatchObject([
      { peer: STALE_PROXY, requests: 1 },
      { peer: STALE_PROXY, requests: 1 },
    ]);
  });

  it("names 16 connections a round and counts the rest on one line without a peer", async () => {
    const { send, warnings, advance } = warningApp({ TRUSTED_PROXY: PROXY });
    await send(STALE_PROXY, FORWARDED);
    for (let host = 1; host <= 20; host += 1)
      await send(`10.0.2.${String(host)}`, FORWARDED);
    advance(60_000);
    await send("10.0.2.21", FORWARDED);
    const round = warnings().slice(1);
    expect(round).toHaveLength(17);
    expect(round.slice(0, 16)).toMatchObject(
      Array.from({ length: 16 }, (_, index) => ({
        peer: `10.0.2.${String(index + 1)}`,
        requests: 1,
      })),
    );
    expect(round[16]).toMatchObject({ peer: null, requests: 5 });
  });

  it("warns again when the clock is set back", async () => {
    const { send, warnings, advance } = warningApp({ TRUSTED_PROXY: PROXY });
    await send(STALE_PROXY, FORWARDED);
    advance(-3_600_000);
    await send(STALE_PROXY, FORWARDED);
    expect(warnings()).toHaveLength(2);
  });

  it("names an IPv4-mapped connection as IPv4, as TRUSTED_PROXY would take it", async () => {
    const { send, warnings } = warningApp({ TRUSTED_PROXY: "10.0.1.0/24" });
    await send("::ffff:10.0.2.7", FORWARDED);
    expect(warnings()).toMatchObject([{ peer: "10.0.2.7" }]);
  });

  it("stays quiet for the proxy, for a request without the header, without TRUSTED_PROXY, and under x-real-ip", async () => {
    const trusted = warningApp({ TRUSTED_PROXY: "10.0.1.0/24" });
    await trusted.send("10.0.1.25", FORWARDED);
    await trusted.send("::ffff:10.0.1.25", FORWARDED);
    await trusted.send("10.0.2.7");
    await trusted.send("10.0.2.7", { "x-real-ip": "203.0.113.9" });
    expect(trusted.warnings()).toEqual([]);

    const unset = warningApp({});
    await unset.send("10.0.2.7", FORWARDED);
    expect(unset.warnings()).toEqual([]);

    const realIp = warningApp({ CLIENT_ADDRESS_HEADER: "x-real-ip" });
    await realIp.send("10.0.2.7", FORWARDED);
    expect(realIp.warnings()).toEqual([]);
  });
});
