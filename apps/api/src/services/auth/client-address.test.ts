import { describe, expect, it } from "vitest";
import {
  type ClientAddressConfig,
  clientAddress,
  untrustedForwarder,
} from "./client-address.js";

const NAMED = "203.0.113.9";

describe("untrustedForwarder", () => {
  const forwarded = new Headers({ "x-forwarded-for": NAMED });
  const config = (trusted_proxy: string | null): ClientAddressConfig => ({
    trusted_proxy,
    client_address_header: "x-forwarded-for",
  });

  it("names a connection outside TRUSTED_PROXY that sent X-Forwarded-For, which clientAddress then counts instead", () => {
    for (const [peer, proxy, expected] of [
      ["10.0.1.30", "10.0.1.25", "10.0.1.30"],
      ["10.0.2.7", "10.0.1.0/24", "10.0.2.7"],
      ["::ffff:10.0.2.7", "10.0.1.0/24", "10.0.2.7"],
      ["FD01::5", "fd00::/16", "fd01::5"],
    ] as const) {
      expect(untrustedForwarder(peer, forwarded, config(proxy))).toBe(expected);
      expect(clientAddress(peer, forwarded, config(proxy))).toBe(expected);
    }
  });

  it("is null when clientAddress reads the header, or had no header to read", () => {
    expect(
      untrustedForwarder("10.0.1.25", forwarded, config("10.0.1.25")),
    ).toBeNull();
    expect(clientAddress("10.0.1.25", forwarded, config("10.0.1.25"))).toBe(
      NAMED,
    );
    expect(
      untrustedForwarder("10.0.1.9", forwarded, config("10.0.1.0/24")),
    ).toBeNull();
    expect(
      untrustedForwarder("10.0.1.30", new Headers(), config("10.0.1.25")),
    ).toBeNull();
    expect(untrustedForwarder("10.0.1.30", forwarded, config(null))).toBeNull();
    expect(untrustedForwarder(null, forwarded, config("10.0.1.25"))).toBeNull();
    expect(
      untrustedForwarder("10.0.1.30", forwarded, {
        trusted_proxy: null,
        client_address_header: "x-real-ip",
      }),
    ).toBeNull();
  });
});
