import { describe, expect, it } from "vitest";
import { testConfig } from "../test/deps.js";

/*
 * Only a connection from TRUSTED_PROXY may name the client in
 * X-Forwarded-For, and that address decides sign-in limits, audit rows and
 * a service account's source_cidrs. A value that trusts more than it names
 * lets every connection in the extra range pick its own address, so start-up
 * refuses it. config.test.ts holds the values it takes.
 */

const load = (value: string) => testConfig("api", { TRUSTED_PROXY: value });

describe("TRUSTED_PROXY trusts no more than it names", () => {
  it.each(["0.0.0.0/0", "::/0"])(
    "refuses %s, which trusts every address",
    (value) => {
      expect(() => load(value)).toThrow(
        "TRUSTED_PROXY must be an IP address or a CIDR range other than /0",
      );
    },
  );

  // An IPv4 connection is matched against an IPv6 range that holds its
  // mapped form, so each of these trusts every IPv4 client, as /0 would.
  it.each(["::ffff:0:0/96", "::ffff:0.0.0.0/96", "::/80", "::/64", "::/1"])(
    "refuses %s, which holds every IPv4 address",
    (value) => {
      expect(() => load(value)).toThrow(
        `TRUSTED_PROXY ${value} holds all of ::ffff:0:0/96, the IPv6 form of every IPv4 address, so it would trust every client to name its own address, as /0 would. Set the proxy's own address or range.`,
      );
    },
  );

  // BlockList would trust the whole range, and `docker network inspect`
  // prints one container's address this way.
  it.each([
    ["10.0.1.25/24", "10.0.1.25", "10.0.1.0/24"],
    ["10.0.1.0/23", "10.0.1.0", "10.0.0.0/23"],
    ["10.0.1.25/31", "10.0.1.25", "10.0.1.24/31"],
    ["fd00::5/64", "fd00::5", "fd00::/64"],
    ["2001:db8::1:0:0:5/96", "2001:db8::1:0:0:5", "2001:db8:0:0:1::/96"],
    ["::ffff:10.0.1.25/120", "::ffff:10.0.1.25", "::ffff:10.0.1.0/120"],
  ])(
    "refuses %s, a range written by an address inside it",
    (value, address, range) => {
      expect(() => load(value)).toThrow(
        `TRUSTED_PROXY ${value} names a range by an address inside it, and would trust all of ${range}. To trust that one address, drop the suffix: ${address}. To trust the range, write it as ${range}.`,
      );
    },
  );
});
