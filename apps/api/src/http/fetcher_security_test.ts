import zlib from "node:zlib";
import { nativeFetch } from "../../test/native-fetch.js";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import type { LookupAddress } from "node:dns";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeEnv } from "../config.js";
import { ServiceError } from "../errors.js";
import {
  createGuardedFetcher,
  isInternalAddress,
  protectNativeFetch,
} from "./fetcher.js";

// B6 in the threat model: no request the api makes can be steered at its own
// network, the cloud metadata service, or a host outside the configured list.

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A local server that records every request and connection it sees. */
async function serve(
  listener: RequestListener = (_request, response) => response.end("reached"),
) {
  const seen = { requests: [] as string[], connections: 0 };
  const server = createServer((request, response) => {
    seen.requests.push(`${String(request.method)} ${String(request.url)}`);
    listener(request, response);
  });
  server.on("connection", () => seen.connections++);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { port: String((server.address() as AddressInfo).port), seen };
}

type Lookup = (hostname: string) => Promise<LookupAddress[]>;

function answering(...addresses: string[]) {
  return vi.fn<Lookup>(() =>
    Promise.resolve(
      addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    ),
  );
}

function fetcherWith(
  lookup: Lookup | undefined,
  nodeEnv: NodeEnv = "test",
  origins: string[] = [],
  demoMock = false,
) {
  return createGuardedFetcher({
    allowedOrigins: () => Promise.resolve(origins),
    nodeEnv,
    demoMock,
    lookup,
  });
}

const INTERNAL = [
  ["private", "10.1.2.3"],
  ["private", "172.16.0.1"],
  ["private", "192.168.1.1"],
  ["loopback", "127.0.0.1"],
  ["link-local", "169.254.10.10"],
  ["the metadata address", "169.254.169.254"],
  ["carrier-grade NAT", "100.64.0.1"],
  ["multicast", "224.0.0.1"],
  ["unspecified", "0.0.0.0"],
  ["IPv6 loopback", "::1"],
  ["IPv6 unspecified", "::"],
  ["IPv6 link-local", "fe80::1"],
  ["unique-local", "fc00::1"],
  ["the IPv6 metadata address", "fd00:ec2::254"],
  ["IPv6 multicast", "ff02::1"],
  ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
  ["NAT64 metadata address", "64:ff9b::169.254.169.254"],
];

const notPublic = (host: string, address: string) =>
  `Refused ${host}: it resolves to ${address}, which is not a public internet address.`;

describe("fetchUntrusted", () => {
  it("refuses a host that resolves to the cloud metadata address before connecting", async () => {
    const lookup = answering("169.254.169.254");

    await expect(
      fetcherWith(lookup).fetchUntrusted("https://metadata.test/"),
    ).rejects.toThrow(
      new ServiceError(
        "upstream",
        notPublic("metadata.test", "169.254.169.254"),
      ),
    );
    expect(lookup).toHaveBeenCalledExactlyOnceWith("metadata.test");
  });

  it.each(INTERNAL)(
    "refuses a %s address (%s), resolved or written into the URL",
    async (_range, address) => {
      const resolved = fetcherWith(answering(address));
      await expect(
        resolved.fetchUntrusted("https://target.test/"),
      ).rejects.toThrow(notPublic("target.test", address));

      // The socket never looks up an address literal, so the fetcher checks it first.
      const lookup = answering("203.0.113.9");
      const host = address.includes(":") ? `[${address}]` : address;
      await expect(
        fetcherWith(lookup).fetchUntrusted(`https://${host}/`),
      ).rejects.toThrow(/which is not a public internet address/);
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("refuses a host when any one of its addresses is internal", async () => {
    const fetcher = fetcherWith(answering("203.0.113.9", "10.0.0.7"));

    await expect(fetcher.fetchUntrusted("https://mixed.test/")).rejects.toThrow(
      notPublic("mixed.test", "10.0.0.7"),
    );
  });

  it("refuses a resolved loopback address with no connection made", async () => {
    const { port, seen } = await serve();
    const lookup = answering("127.0.0.1");

    await expect(
      fetcherWith(lookup).fetchUntrusted(`https://rebind.test:${port}/`),
    ).rejects.toThrow(ServiceError);
    expect(lookup).toHaveBeenCalledOnce();
    expect(seen.connections).toBe(0);
  });

  it.each([
    "http://example.test/",
    "file:///etc/passwd",
    "ftp://example.test/",
  ])("refuses %s, which is not https", async (url) => {
    const lookup = answering("203.0.113.9");

    await expect(fetcherWith(lookup).fetchUntrusted(url)).rejects.toMatchObject(
      { kind: "upstream" },
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});

// Next to each range's edge, so a range written too wide fails here.
it.each(["8.8.8.8", "100.128.0.1", "172.32.0.1", "2001:4860:4860::8888"])(
  "lets the public address %s through the address check",
  (address) => {
    expect(isInternalAddress(address)).toBe(false);
  },
);

describe("fetchFixed", () => {
  it("connects to the address its own lookup returned, asking once", async () => {
    // .test never resolves in real DNS, so reaching the server proves the
    // socket used the checked answer rather than a lookup of its own.
    const { port, seen } = await serve();
    const lookup = answering("127.0.0.1");
    const origin = `http://powerbi-mock.test:${port}`;

    const response = await fetcherWith(lookup, "test", [origin]).fetchFixed(
      `${origin}/powerbi/v1.0/myorg/groups`,
    );

    expect(await response.text()).toBe("reached");
    expect(lookup).toHaveBeenCalledExactlyOnceWith("powerbi-mock.test");
    expect(seen.requests).toEqual(["GET /powerbi/v1.0/myorg/groups"]);
  });

  it.each(["development", "test"] as const)(
    "reaches the mock over http in %s",
    async (nodeEnv) => {
      const { port } = await serve();
      const origin = `http://powerbi-mock.localhost:${port}`;
      const fetcher = fetcherWith(answering("127.0.0.1"), nodeEnv, [origin]);

      expect((await fetcher.fetchFixed(`${origin}/powerbi`)).status).toBe(200);
    },
  );

  // The lock tested shut: production outside demo mode refuses http to the
  // mock, even when the mock's origin is configured and its server is listening.
  it.each(["127.0.0.1", "localhost", "powerbi-mock.localhost"])(
    "refuses http to %s in production",
    async (host) => {
      const { port, seen } = await serve();
      const origin = `http://${host}:${port}`;
      const lookup = answering("127.0.0.1");

      await expect(
        fetcherWith(lookup, "production", [origin]).fetchFixed(
          `${origin}/powerbi`,
        ),
      ).rejects.toThrow(
        new ServiceError(
          "upstream",
          `Refused ${origin}: in production the fixed hosts are reached over https only.`,
        ),
      );
      expect(lookup).not.toHaveBeenCalled();
      expect(seen.connections).toBe(0);
    },
  );

  describe("in demo mode, in production", () => {
    it("reaches a configured mock origin over http", async () => {
      const { port, seen } = await serve();
      const origin = `http://powerbi-mock.localhost:${port}`;
      const fetcher = fetcherWith(
        answering("127.0.0.1"),
        "production",
        [origin],
        true,
      );

      expect((await fetcher.fetchFixed(`${origin}/powerbi`)).status).toBe(200);
      expect(seen.requests).toEqual(["GET /powerbi"]);
    });

    it("refuses http to a configured origin off the mock", async () => {
      const lookup = answering("127.0.0.1");

      await expect(
        fetcherWith(
          lookup,
          "production",
          ["http://example.com"],
          true,
        ).fetchFixed("http://example.com/powerbi"),
      ).rejects.toThrow(
        new ServiceError(
          "upstream",
          "Refused http://example.com: in production the fixed hosts are reached over https only.",
        ),
      );
      expect(lookup).not.toHaveBeenCalled();
    });

    it("refuses http to a mock host that is not configured", async () => {
      const { port, seen } = await serve();
      const origin = `http://powerbi-mock.localhost:${port}`;
      const lookup = answering("127.0.0.1");

      await expect(
        fetcherWith(lookup, "production", [], true).fetchFixed(
          `${origin}/powerbi`,
        ),
      ).rejects.toThrow(
        new ServiceError(
          "upstream",
          `Refused ${origin}: it is not one of the configured hosts (Microsoft identity, Power BI, Graph, the embedding provider).`,
        ),
      );
      expect(lookup).not.toHaveBeenCalled();
      expect(seen.connections).toBe(0);
    });
  });

  // Private Link and private endpoints put the fixed hosts on internal
  // addresses, so production connects to them. The local server speaks plain
  // http, so the TLS handshake fails after the connection is made.
  it("connects to a configured https host on an internal address in production", async () => {
    const { port, seen } = await serve();
    const origins = [
      `https://api.powerbi.test:${port}`,
      `https://127.0.0.1:${port}`,
    ];
    const fetcher = fetcherWith(answering("127.0.0.1"), "production", origins);

    for (const origin of origins) {
      await expect(
        fetcher.fetchFixed(`${origin}/v1.0/myorg/groups`),
      ).rejects.toThrow(new RegExp(`^Could not reach ${origin}: `));
    }
    expect(seen.connections).toBe(2);
  });

  // https://api.powerbi.com@evil.test/ reads as the allowed host but connects
  // to evil.test, so a URL with a user name or password is refused whole.
  // Each answers with an internal address, so a missing check shows as a
  // different message and never as a connection to the internet.
  it.each([
    ["fetchFixed", "https://api.powerbi.com@evil.test/"],
    ["fetchFixed", "https://:secret@evil.test/"],
    ["fetchUntrusted", "https://api.powerbi.com@evil.test/"],
    ["fetchUntrusted", "https://:secret@evil.test/"],
  ] as const)("%s refuses %s", async (method, url) => {
    const lookup = answering("127.0.0.1");
    const fetcher = fetcherWith(lookup, "test", ["https://api.powerbi.com"]);

    await expect(fetcher[method](url)).rejects.toThrow(
      new ServiceError(
        "upstream",
        "Refused evil.test: the URL carries a user name or password.",
      ),
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.test/",
    "https://api.powerbi.com:8443/",
    "http://api.powerbi.com/",
  ])("refuses %s, outside the configured hosts", async (url) => {
    const lookup = answering("203.0.113.9");

    await expect(
      fetcherWith(lookup, "test", ["https://api.powerbi.com"]).fetchFixed(url),
    ).rejects.toThrow(
      new ServiceError(
        "upstream",
        `Refused ${new URL(url).origin}: it is not one of the configured hosts (Microsoft identity, Power BI, Graph, the embedding provider).`,
      ),
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  // fetchUntrusted answers through the same code, with its own address check.
  it.each([302, 307])(
    "refuses a %i, even to another configured host",
    async (status) => {
      const elsewhere = await serve();
      const elsewhereOrigin = `http://127.0.0.1:${elsewhere.port}`;
      const { port } = await serve((_request, response) => {
        response.writeHead(status, { location: `${elsewhereOrigin}/` }).end();
      });
      const origin = `http://127.0.0.1:${port}`;

      await expect(
        fetcherWith(undefined, "test", [origin, elsewhereOrigin]).fetchFixed(
          `${origin}/start`,
        ),
      ).rejects.toThrow(
        new ServiceError(
          "upstream",
          `Refused the answer from ${origin}: it redirects (${String(status)}), and redirects are not followed.`,
        ),
      );
      expect(elsewhere.seen.connections).toBe(0);
    },
  );

  describe('with redirect: "return"', () => {
    it("hands back a 302 with its Location, and sends nothing there", async () => {
      const elsewhere = await serve();
      const elsewhereOrigin = `http://127.0.0.1:${elsewhere.port}`;
      const { port } = await serve((_request, response) => {
        response.writeHead(302, { location: `${elsewhereOrigin}/next` }).end();
      });
      const origin = `http://127.0.0.1:${port}`;

      const response = await fetcherWith(undefined, "test", [
        origin,
        elsewhereOrigin,
      ]).fetchFixed(`${origin}/start`, { redirect: "return" });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`${elsewhereOrigin}/next`);
      expect(elsewhere.seen.connections).toBe(0);
    });

    it("still refuses a host outside the configured hosts", async () => {
      const { port, seen } = await serve();
      const origin = `http://127.0.0.1:${port}`;

      await expect(
        fetcherWith(undefined, "test", []).fetchFixed(`${origin}/start`, {
          redirect: "return",
        }),
      ).rejects.toThrow(
        new ServiceError(
          "upstream",
          `Refused ${origin}: it is not one of the configured hosts (Microsoft identity, Power BI, Graph, the embedding provider).`,
        ),
      );
      expect(seen.connections).toBe(0);
    });

    it("still refuses http in production outside demo mode", async () => {
      const { port, seen } = await serve();
      const origin = `http://powerbi-mock.localhost:${port}`;
      const lookup = answering("127.0.0.1");

      await expect(
        fetcherWith(lookup, "production", [origin]).fetchFixed(
          `${origin}/start`,
          { redirect: "return" },
        ),
      ).rejects.toThrow(
        new ServiceError(
          "upstream",
          `Refused http://powerbi-mock.localhost:${port}: in production the fixed hosts are reached over https only.`,
        ),
      );
      expect(lookup).not.toHaveBeenCalled();
      expect(seen.connections).toBe(0);
    });
  });
});

describe("native response decoder", () => {
  it("rejects duplicate encoding headers before constructing the zstd decoder", async () => {
    const decoder = vi.spyOn(zlib, "createZstdDecompress");
    const { port } = await serve((_request, response) => {
      response.writeHead(200, [
        "Content-Encoding",
        "gzip",
        "Content-Encoding",
        "zstd",
      ]);
      response.end(zlib.zstdCompressSync(Buffer.from("sample")));
    });
    const origin = `http://127.0.0.1:${port}`;
    await expect(
      fetcherWith(undefined, "test", [origin]).fetchFixed(origin),
    ).rejects.toMatchObject({
      kind: "upstream",
      message:
        "Refused a zstd-compressed response: this runtime's decoder is not safe to use.",
    });
    expect(decoder).not.toHaveBeenCalled();
  });
});

it("protects native fetch used by authentication libraries before decoding", async () => {
  const decoder = vi.spyOn(zlib, "createZstdDecompress");
  const { port } = await serve((request, response) => {
    const compressed = request.url === "/zstd";
    response.writeHead(200, {
      "content-encoding": compressed ? "zstd" : "gzip",
    });
    response.end(
      compressed
        ? zlib.zstdCompressSync(Buffer.from("sample"))
        : zlib.gzipSync(Buffer.from("sample")),
    );
  });
  const original = getGlobalDispatcher();
  try {
    protectNativeFetch();
    const protectedAgent = getGlobalDispatcher();
    protectNativeFetch();
    expect(getGlobalDispatcher()).toBe(protectedAgent);
    await expect(
      nativeFetch(`http://127.0.0.1:${port}/zstd`),
    ).rejects.toMatchObject({
      cause: {
        kind: "upstream",
        message:
          "Refused a zstd-compressed response: this runtime's decoder is not safe to use.",
      },
    });
    expect(decoder).not.toHaveBeenCalled();
    expect(
      await (await nativeFetch(`http://127.0.0.1:${port}/gzip`)).text(),
    ).toBe("sample");
  } finally {
    setGlobalDispatcher(original);
  }
});
