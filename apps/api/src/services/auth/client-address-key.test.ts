import { describe, expect, it } from "vitest";
import { clientAddressKey } from "./client-address-key.js";

describe("clientAddressKey", () => {
  it("counts two addresses in one IPv6 /64 as one visitor", () => {
    expect(clientAddressKey("2001:db8:1:2::1")).toBe(
      "2001:0db8:0001:0002::/64",
    );
    expect(clientAddressKey("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe(
      "2001:0db8:0001:0002::/64",
    );
  });

  it("counts two IPv6 /64s as two visitors", () => {
    expect(clientAddressKey("2001:db8:1:3::1")).toBe(
      "2001:0db8:0001:0003::/64",
    );
  });

  it("expands :: wherever it stands", () => {
    expect(clientAddressKey("2001:db8::1:2:3:4")).toBe(
      "2001:0db8:0000:0000::/64",
    );
    expect(clientAddressKey("::1")).toBe("0000:0000:0000:0000::/64");
  });

  it("counts IPv4, mapped into IPv6 or not, as the IPv4 address", () => {
    expect(clientAddressKey("198.51.100.7")).toBe("198.51.100.7");
    expect(clientAddressKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(clientAddressKey("::ffff:c633:6407")).toBe("198.51.100.7");
  });

  it("ignores a zone id and the case of the address", () => {
    expect(clientAddressKey("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
    expect(clientAddressKey("FE80:0:0:0:1::2")).toBe(
      "fe80:0000:0000:0000::/64",
    );
  });

  it("leaves an input that is not an address as it is", () => {
    expect(clientAddressKey("not-an-address")).toBe("not-an-address");
  });
});
