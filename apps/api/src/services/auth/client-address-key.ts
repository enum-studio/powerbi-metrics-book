import { isIPv6 } from "node:net";
import { ipv6Groups, normalised } from "./client-address.js";

/**
 * The key a client is counted under in a per-address limit. An IPv6 client usually holds a
 * whole /64 and could rotate through it, so an IPv6 address counts as its
 * /64. IPv4, and IPv6 that maps an IPv4 address, count as the IPv4 address.
 */
export function clientAddressKey(address: string): string {
  const plain = normalised(address);
  if (!isIPv6(plain)) return plain;
  return `${ipv6Groups(plain).slice(0, 4).join(":")}::/64`;
}
