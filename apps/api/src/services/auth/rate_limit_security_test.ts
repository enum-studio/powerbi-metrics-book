import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestPools, TEST_PUBLIC_BASE_URL } from "../../../test/deps.js";
import {
  freshPeer,
  type SignInFixture,
  startSignIn,
} from "../../../test/sign-in-support.js";
import { rateLimit } from "../../db/schema/auth.js";
import { clientAddress } from "./client-address.js";

/*
 * Better Auth counts sign-in starts per client address in Postgres, 60 a
 * minute, since a start only redirects to the provider. The
 * address comes from X-Forwarded-For only when the connection is from
 * TRUSTED_PROXY, so nobody picks the address their attempts count against.
 */

const PROXY = "10.20.30.0/24";

let f: SignInFixture;

beforeAll(async () => {
  f = await startSignIn({ env: { TRUSTED_PROXY: PROXY } });
});

afterAll(async () => {
  await f.close();
  await closeTestPools();
});

function startSignInFrom(peer: string, forwardedFor?: string) {
  return f.request(
    "/api/auth/sign-in/social",
    {
      method: "POST",
      headers: {
        origin: TEST_PUBLIC_BASE_URL,
        "content-type": "application/json",
        ...(forwardedFor === undefined
          ? {}
          : { "x-forwarded-for": forwardedFor }),
      },
      body: JSON.stringify({ provider: "microsoft", callbackURL: "/" }),
    },
    peer,
  );
}

async function countedFor(addresses: string[]): Promise<string[]> {
  const rows = await f.deps.db
    .select({ key: rateLimit.key })
    .from(rateLimit)
    .where(
      inArray(
        rateLimit.key,
        addresses.map((address) => `${address}|/sign-in/social`),
      ),
    );
  return rows.map((row) => row.key.split("|")[0] ?? "").toSorted();
}

describe("rate limits on starting a sign-in", () => {
  it("refuses the 61st start from one client within a minute, and counts it in Postgres", async () => {
    const client = freshPeer();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 61; attempt += 1)
      statuses.push((await startSignInFrom(client)).status);
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect((await startSignInFrom(freshPeer())).status).toBe(200);
    expect(await countedFor([client])).toEqual([client]);
  });

  it("counts against the address the trusted proxy saw, and against the connection otherwise", async () => {
    const [named, spoofed, direct, ignored] = [1, 2, 3, 4].map(() =>
      freshPeer(),
    ) as [string, string, string, string];
    // The proxy appends the address it saw; what came before it is the client's say.
    await startSignInFrom("10.20.30.7", `${spoofed}, ${named}`);
    await startSignInFrom(direct, ignored);
    expect(await countedFor([named, spoofed, direct, ignored])).toEqual(
      [named, direct].toSorted(),
    );
  });
});

describe("clientAddress", () => {
  const forwarded = (
    peer: string | null,
    forwardedFor: string,
    trusted_proxy: string | null,
  ) =>
    clientAddress(peer, new Headers({ "x-forwarded-for": forwardedFor }), {
      trusted_proxy,
      client_address_header: "x-forwarded-for",
    });
  const realIp = (peer: string | null, headers: Record<string, string>) =>
    clientAddress(peer, new Headers(headers), {
      trusted_proxy: null,
      client_address_header: "x-real-ip",
    });

  it("takes the one X-Real-IP value in x-real-ip mode, whoever connected, and ignores X-Forwarded-For", () => {
    expect(realIp("10.0.0.2", { "x-real-ip": "203.0.113.9" })).toBe(
      "203.0.113.9",
    );
    expect(realIp("10.0.0.2", { "x-real-ip": "2001:DB8::1" })).toBe(
      "2001:db8::1",
    );
    expect(
      realIp("10.0.0.2", {
        "x-real-ip": "203.0.113.9",
        "x-forwarded-for": "198.51.100.1",
      }),
    ).toBe("203.0.113.9");
    expect(realIp("10.0.0.2", { "x-forwarded-for": "198.51.100.1" })).toBe(
      "10.0.0.2",
    );
    expect(realIp(null, { "x-real-ip": "203.0.113.9" })).toBeNull();
  });

  it("falls back to the connection for an X-Real-IP that is not one address", () => {
    for (const value of [
      "not an address",
      "203.0.113.9, 198.51.100.1",
      "203.0.113.9:51234",
      "",
    ])
      expect(realIp("10.0.0.2", { "x-real-ip": value })).toBe("10.0.0.2");
  });

  it("ignores X-Real-IP in the default mode", () => {
    expect(
      clientAddress("10.0.0.2", new Headers({ "x-real-ip": "203.0.113.9" }), {
        trusted_proxy: "10.0.0.2",
        client_address_header: "x-forwarded-for",
      }),
    ).toBe("10.0.0.2");
  });

  it("reads X-Forwarded-For only from a connection inside TRUSTED_PROXY", () => {
    expect(forwarded("10.0.0.2", "203.0.113.9", "10.0.0.2")).toBe(
      "203.0.113.9",
    );
    expect(forwarded("::ffff:10.0.0.9", "a, 203.0.113.9", "10.0.0.0/24")).toBe(
      "203.0.113.9",
    );
    expect(forwarded("fd00::5", "2001:db8::1", "fd00::/8")).toBe("2001:db8::1");
    expect(forwarded("10.0.1.2", "203.0.113.9", "10.0.0.0/24")).toBe(
      "10.0.1.2",
    );
    expect(forwarded("10.0.0.2", "203.0.113.9", null)).toBe("10.0.0.2");
    expect(forwarded("10.0.0.2", "not an address", "10.0.0.2")).toBe(
      "10.0.0.2",
    );
    expect(forwarded(null, "203.0.113.9", "10.0.0.2")).toBeNull();
  });

  it("reads an entry the proxy wrote with the client's port", () => {
    expect(forwarded("10.0.0.2", "203.0.113.9:51234", "10.0.0.2")).toBe(
      "203.0.113.9",
    );
    expect(forwarded("10.0.0.2", "[2001:db8::1]:51234", "10.0.0.2")).toBe(
      "2001:db8::1",
    );
    expect(forwarded("10.0.0.2", "[2001:db8::1]", "10.0.0.2")).toBe(
      "2001:db8::1",
    );
    expect(forwarded("10.0.0.2", "[not an address]:1", "10.0.0.2")).toBe(
      "10.0.0.2",
    );
  });
});

describe("rate limits behind an edge that sets X-Real-IP", () => {
  let edge: SignInFixture;
  beforeAll(async () => {
    edge = await startSignIn({ env: { CLIENT_ADDRESS_HEADER: "x-real-ip" } });
  });
  afterAll(async () => {
    await edge.close();
  });

  const startFrom = (headers: Record<string, string>) =>
    edge.request(
      "/api/auth/sign-in/social",
      {
        method: "POST",
        headers: {
          origin: TEST_PUBLIC_BASE_URL,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ provider: "microsoft", callbackURL: "/" }),
      },
      "10.20.30.7",
    );

  it("counts each X-Real-IP apart, ignores a spoofed X-Forwarded-For, and counts a bad X-Real-IP as the connection", async () => {
    const [first, second, spoofed] = [1, 2, 3].map(() => freshPeer()) as [
      string,
      string,
      string,
    ];
    await startFrom({ "x-real-ip": first, "x-forwarded-for": spoofed });
    await startFrom({ "x-real-ip": second });
    await startFrom({ "x-real-ip": "not an address" });
    const addresses = [first, second, spoofed, "10.20.30.7"];
    const rows = await edge.deps.db
      .select({ key: rateLimit.key })
      .from(rateLimit)
      .where(
        inArray(
          rateLimit.key,
          addresses.map((address) => `${address}|/sign-in/social`),
        ),
      );
    expect(rows.map((row) => row.key.split("|")[0]).toSorted()).toEqual(
      [first, second, "10.20.30.7"].toSorted(),
    );
  });
});
