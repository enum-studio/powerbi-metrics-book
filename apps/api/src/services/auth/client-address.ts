import { BlockList, isIP } from "node:net";

/** The two settings that decide how a request names its client. */
export type ClientAddressConfig = {
  trusted_proxy: string | null;
  client_address_header: "x-forwarded-for" | "x-real-ip";
};

/**
 * The address a request came from, for rate limits, audit rows and Better
 * Auth. By default X-Forwarded-For is a header anyone can send, so it names
 * the client only when the connection itself comes from TRUSTED_PROXY; the
 * proxy appends the address it saw last. With CLIENT_ADDRESS_HEADER=x-real-ip
 * the one value of X-Real-IP is the client and X-Forwarded-For is never
 * read; that is safe only if every request comes through an edge that
 * replaces a client-sent X-Real-IP, which an operator must check against
 * GET /api/v1/me (see config.ts). Either way, a value that is not an address
 * leaves the connection's own address. Null when there is no connection to
 * read (a request made in process).
 */
export function clientAddress(
  peer: string | null,
  headers: Pick<Headers, "get">,
  config: ClientAddressConfig,
): string | null {
  if (peer === null) return null;
  const connection = normalised(peer);
  if (config.client_address_header === "x-real-ip") {
    const named = headers.get("x-real-ip")?.trim() ?? "";
    return isIP(named) === 0 ? connection : normalised(named);
  }
  const forwardedFor = headers.get("x-forwarded-for");
  if (config.trusted_proxy === null || forwardedFor === null) return connection;
  if (!trusts(config.trusted_proxy, connection)) return connection;
  const named = withoutPort(forwardedFor.split(",").at(-1)?.trim() ?? "");
  return isIP(named) === 0 ? connection : normalised(named);
}

/**
 * The connection's address when it sent X-Forwarded-For from outside
 * TRUSTED_PROXY, so clientAddress counted the connection and not the header;
 * null otherwise. A client may send the header itself. Behind a proxy whose
 * address changed, every request lands here, which is what the api's warning
 * is for (http/forwarded-for-warning.ts).
 */
export function untrustedForwarder(
  peer: string | null,
  headers: Pick<Headers, "get">,
  config: ClientAddressConfig,
): string | null {
  if (
    peer === null ||
    config.client_address_header !== "x-forwarded-for" ||
    config.trusted_proxy === null ||
    headers.get("x-forwarded-for") === null
  )
    return null;
  const connection = normalised(peer);
  return trusts(config.trusted_proxy, connection) ? null : connection;
}

/**
 * An IPv6 address as its eight groups of four lowercase hex digits. A dotted
 * IPv4 tail fills the last two groups.
 */
export function ipv6Groups(address: string): string[] {
  const [left = "", right] = (address.split("%")[0] ?? "")
    .toLowerCase()
    .split("::");
  const side = (part: string) =>
    part === ""
      ? []
      : part.split(":").flatMap((group) => {
          if (!group.includes(".")) return [group];
          const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map(Number);
          return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
        });
  const front = side(left);
  const back = right === undefined ? [] : side(right);
  const zeros =
    right === undefined
      ? []
      : Array<string>(8 - front.length - back.length).fill("0");
  return [...front, ...zeros, ...back].map((group) => group.padStart(4, "0"));
}

/**
 * One spelling per client: IPv6 in lowercase, and an IPv4-mapped IPv6
 * address (::ffff:198.51.100.7 or ::ffff:c633:6407) as plain IPv4.
 */
export function normalised(address: string): string {
  if (isIP(address) !== 6) return address;
  const groups = ipv6Groups(address);
  const mapped =
    groups.slice(0, 5).every((group) => group === "0000") &&
    groups[5] === "ffff";
  if (!mapped) return address.toLowerCase();
  const high = Number.parseInt(groups[6] ?? "0", 16);
  const low = Number.parseInt(groups[7] ?? "0", 16);
  return `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`;
}

/** Some proxies (Azure Application Gateway) append the client's port: 203.0.113.9:51234 or [2001:db8::1]:51234. */
function withoutPort(entry: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
  if (bracketed?.[1] !== undefined) return bracketed[1];
  const v4 = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(entry);
  return v4?.[1] ?? entry;
}

function family(address: string): "ipv4" | "ipv6" {
  return isIP(address) === 6 ? "ipv6" : "ipv4";
}

/** Whether TRUSTED_PROXY, one address or a range, holds the address. */
function trusts(trustedProxy: string, address: string): boolean {
  const list = new BlockList();
  const [proxy = "", prefix] = trustedProxy.split("/");
  if (prefix === undefined) list.addAddress(proxy, family(proxy));
  else list.addSubnet(proxy, Number(prefix), family(proxy));
  return list.check(address, family(address));
}
