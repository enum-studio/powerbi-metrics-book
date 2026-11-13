import { promises as dns, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch } from "undici";
import type { GuardedFetcher } from "../context.js";
import { ServiceError } from "../errors.js";

/*
 * The only module of the api that reaches the network (semgrep refuses fetch
 * anywhere else under src/). Node's own fetch resolves a host itself, so it
 * cannot connect to the address that was checked; undici's Agent takes the
 * socket's lookup, and fetchUntrusted's address check runs inside it.
 */

type Lookup = (hostname: string) => Promise<LookupAddress[]>;
type Limits = { timeout_ms: number; max_bytes: number };
type Redirect = "refuse" | "return";

const KIB = 1024;
const MIB = 1024 * KIB;
const UNTRUSTED_LIMITS: Limits = { timeout_ms: 5_000, max_bytes: 64 * KIB };
const FIXED_DEFAULTS: Limits = { timeout_ms: 30_000, max_bytes: 16 * MIB };
const FIXED_CEILINGS: Limits = { timeout_ms: 300_000, max_bytes: 32 * MIB };

const INTERNAL_IPV4: [string, number][] = [
  ["0.0.0.0", 8], // unspecified
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, holding the metadata address 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.168.0.0", 16], // private
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
];
const INTERNAL_IPV6: [string, number][] = [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible form
  ["fc00::", 7], // unique-local, holding the metadata address fd00:ec2::254
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
];

// BlockList matches an IPv4-mapped address (::ffff:127.0.0.1) against the IPv4
// rules itself. NAT64 (64:ff9b::/96) carries an IPv4 address that the
// gateway reaches on our behalf, so each IPv4 range is blocked there too.
const internal = new BlockList();
for (const [network, prefix] of INTERNAL_IPV4) {
  internal.addSubnet(network, prefix, "ipv4");
  internal.addSubnet(`64:ff9b::${network}`, 96 + prefix, "ipv6");
}
for (const [network, prefix] of INTERNAL_IPV6) {
  internal.addSubnet(network, prefix, "ipv6");
}

/** True for any address that is not on the public internet. */
export function isInternalAddress(address: string): boolean {
  return internal.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

/**
 * A URL hostname the mock answers from: localhost, a name ending in
 * .localhost, or exactly 127.0.0.1 or [::1]. onTheMock and the demo's http
 * exception in fetchFixed both read it.
 */
export function isMockHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/** Every refusal: a sentence naming what was refused and why, never the answer's body. */
function upstream(message: string) {
  return new ServiceError("upstream", message);
}

function internalAddressRefusal(hostname: string, address: string) {
  return upstream(
    `Refused ${hostname}: it resolves to ${address}, which is not a public internet address.`,
  );
}

/**
 * The socket's own lookup: the host is resolved once, every address is
 * checked, and the socket connects to the addresses checked here, so a second
 * DNS answer (rebinding) never reaches the connection.
 */
function checkedLookup(resolve: Lookup, publicOnly: boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const refused = publicOnly
          ? addresses.find(({ address }) => isInternalAddress(address))
          : undefined;
        const first = addresses[0];
        if (refused) {
          callback(internalAddressRefusal(hostname, refused.address), "");
        } else if (!first) {
          callback(upstream(`Refused ${hostname}: it has no address.`), "");
        } else if (options.all) {
          callback(null, addresses);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), "");
      },
    );
  };
}

function agent(resolve: Lookup, publicOnly: boolean): Agent {
  return new Agent({ connect: { lookup: checkedLookup(resolve, publicOnly) } });
}

function parse(url: string | URL): URL {
  const parsed = URL.parse(String(url));
  if (!parsed) throw upstream(`Refused ${String(url)}: it is not a URL.`);
  if (parsed.username || parsed.password) {
    throw upstream(
      `Refused ${parsed.host}: the URL carries a user name or password.`,
    );
  }
  return parsed;
}

function withinCeiling(name: keyof Limits, value: number) {
  if (!Number.isInteger(value) || value <= 0 || value > FIXED_CEILINGS[name]) {
    throw new RangeError(
      `${name} must be a whole number from 1 to ${String(FIXED_CEILINGS[name])}, not ${String(value)}.`,
    );
  }
}

function tooLarge(origin: string, max_bytes: number) {
  return new ServiceError(
    "upstream",
    `The answer from ${origin} is larger than ${max_bytes.toLocaleString("en")} bytes, so it was refused.`,
    { too_large: true },
  );
}

async function readCapped(
  response: Awaited<ReturnType<typeof fetch>>,
  origin: string,
  max_bytes: number,
  stop: AbortController,
): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > max_bytes) {
    stop.abort();
    throw tooLarge(origin, max_bytes);
  }
  // Counted after decompression, so a small compressed answer cannot expand past the limit.
  const stream: ReadableStream<Uint8Array> | null = response.body;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream ?? []) {
    size += chunk.byteLength;
    if (size > max_bytes) {
      stop.abort();
      throw tooLarge(origin, max_bytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Turns a failed request into the sentence a caller reads. */
function explain(
  error: unknown,
  target: URL,
  timeout: AbortSignal,
  timeout_ms: number,
): unknown {
  if (error instanceof ServiceError) return error;
  if (timeout.aborted) {
    return upstream(
      `${target.origin} did not answer within ${String(timeout_ms / 1000)} seconds, so the request was stopped.`,
    );
  }
  // undici reports a network failure as TypeError("fetch failed") with the socket's error as its cause.
  const cause = error instanceof TypeError ? error.cause : undefined;
  if (cause instanceof ServiceError) return cause;
  const code =
    cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  // Never a message: Node's header check quotes the header's whole value, a key included.
  return upstream(
    code === undefined
      ? `Could not send the request to ${target.origin}.`
      : `Could not reach ${target.origin}: ${code}.`,
  );
}

async function send(
  target: URL,
  init: RequestInit,
  dispatcher: Agent,
  limits: Limits,
  redirect: Redirect = "refuse",
) {
  const timeout = AbortSignal.timeout(limits.timeout_ms);
  const stop = new AbortController();
  try {
    // Node's own Request encodes the caller's body, so undici receives bytes: undici's
    // fetch would send Node's global FormData as the text "[object FormData]".
    const request = new Request(target, init);
    const payload = request.body ? await request.arrayBuffer() : null;
    const signal = AbortSignal.any([timeout, stop.signal, request.signal]);
    const response = await fetch(target, {
      method: request.method,
      headers: [...request.headers],
      body: payload,
      redirect: "manual",
      signal,
      dispatcher,
    });
    if (response.status >= 300 && response.status < 400) {
      stop.abort();
      // Its body is never read, and no request goes to its Location.
      if (redirect === "return")
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers([...response.headers]),
        });
      throw upstream(
        `Refused the answer from ${target.origin}: it redirects (${String(response.status)}), and redirects are not followed.`,
      );
    }
    const body = await readCapped(
      response,
      target.origin,
      limits.max_bytes,
      stop,
    );
    const nullBody = response.status === 204 || response.status === 205;
    return new Response(nullBody ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers([...response.headers]),
    });
  } catch (error) {
    throw explain(error, target, timeout, limits.timeout_ms);
  }
}

export function createGuardedFetcher(options: {
  /** The fixed hosts' base URLs, read from settings by the caller; only their origins count. */
  allowedOrigins: () => Promise<string[]>;
  nodeEnv: "development" | "test" | "production";
  /** Demo mode: in production, http is allowed to a configured origin on the mock's host (isMockHost). Off when left out. */
  demoMock?: boolean;
  /** Resolves a host name to every address it has. Tests pass a stub; the default is the system resolver. */
  lookup?: Lookup;
}): GuardedFetcher {
  const resolve =
    options.lookup ??
    ((hostname) => dns.lookup(hostname, { all: true, order: "verbatim" }));
  const production = options.nodeEnv === "production";
  const untrusted = agent(resolve, true);
  // No address check for the fixed hosts, in any environment: a tenant on Power
  // BI Private Link, or with Azure OpenAI or Entra behind private endpoints,
  // resolves them to private addresses. The origin list guards them instead.
  const fixed = agent(resolve, false);

  return {
    async fetchFixed(url, init = {}) {
      const {
        timeout_ms = FIXED_DEFAULTS.timeout_ms,
        max_bytes = FIXED_DEFAULTS.max_bytes,
        redirect = "refuse",
        ...rest
      } = init;
      withinCeiling("timeout_ms", timeout_ms);
      withinCeiling("max_bytes", max_bytes);
      const target = parse(url);
      const http =
        target.protocol === "http:" &&
        (!production ||
          (options.demoMock === true && isMockHost(target.hostname)));
      if (target.protocol !== "https:" && !http) {
        throw upstream(
          production
            ? `Refused ${target.protocol}//${target.host}: in production the fixed hosts are reached over https only.`
            : `Refused ${target.protocol}//${target.host}: the fixed hosts are reached over https, or http in development and test.`,
        );
      }
      const allowed = (await options.allowedOrigins()).map(
        (entry) => new URL(entry).origin,
      );
      if (!allowed.includes(target.origin)) {
        throw upstream(
          `Refused ${target.origin}: it is not one of the configured hosts (Microsoft identity, Power BI, Graph, the embedding provider).`,
        );
      }
      return send(target, rest, fixed, { timeout_ms, max_bytes }, redirect);
    },

    async fetchUntrusted(url, init = {}) {
      const target = parse(url);
      if (target.protocol !== "https:") {
        throw upstream(
          `Refused ${target.protocol}//${target.host}: a URL chosen outside this server must use https.`,
        );
      }
      // The socket's lookup never runs for an address written into the URL, so it is checked here.
      const literal = target.hostname.replace(/^\[(.*)\]$/, "$1");
      if (isIP(literal) && isInternalAddress(literal)) {
        throw internalAddressRefusal(target.hostname, literal);
      }
      return send(target, init, untrusted, UNTRUSTED_LIMITS);
    },
  };
}
