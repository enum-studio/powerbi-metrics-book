import zlib, { gzipSync, zstdCompressSync } from "node:zlib";
import type { LookupAddress } from "node:dns";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import type * as Undici from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "../errors.js";
import { createGuardedFetcher } from "./fetcher.js";

// The public internet, played by this machine. An https connection still runs
// the fetcher's own lookup and address check, then reaches the local server on
// the URL's port over plain TCP, so fetchUntrusted's limits are tested without
// a certificate. http keeps undici's own connector.
vi.mock("undici", async (importOriginal) => {
  const undici = await importOriginal<typeof Undici>();
  const net = await import("node:net");
  class Agent extends undici.Agent {
    constructor(options: { connect: { lookup: LookupFunction } }) {
      const real = undici.buildConnector(options.connect);
      super({
        connect: (target, callback) => {
          if (target.protocol !== "https:") {
            real(target, callback);
            return;
          }
          options.connect.lookup(target.hostname, { all: true }, (error) => {
            if (error) {
              callback(error, null);
              return;
            }
            const socket = net.connect(Number(target.port), "127.0.0.1");
            const fail = (failure: Error) => {
              callback(failure, null);
            };
            socket.once("error", fail).once("connect", () => {
              socket.off("error", fail);
              callback(null, socket);
            });
          });
        },
      });
    }
  }
  return { ...undici, Agent };
});

const KIB = 1024;
const MIB = 1024 * KIB;

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function listen(listener: RequestListener) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${String(request.method)} ${String(request.url)}`);
    listener(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { port: String((server.address() as AddressInfo).port), requests };
}

/** A configured fixed host on loopback, as the mock is in test, with a fetcher allowed to reach it. */
async function fixedHost(listener: RequestListener) {
  const { port, requests } = await listen(listener);
  const origin = `http://127.0.0.1:${port}`;
  const fetcher = createGuardedFetcher({
    allowedOrigins: () => Promise.resolve([`${origin}/powerbi`]),
    nodeEnv: "test",
  });
  return { origin, requests, fetcher };
}

/** A host someone else chose, resolving to a public address; the undici mock above routes it here. */
async function publicHost(listener: RequestListener) {
  const { port, requests } = await listen(listener);
  const lookup = vi.fn<(hostname: string) => Promise<LookupAddress[]>>(() =>
    Promise.resolve([{ address: "203.0.113.9", family: 4 }]),
  );
  const fetcher = createGuardedFetcher({
    allowedOrigins: () => Promise.resolve([]),
    nodeEnv: "production",
    lookup,
  });
  return { origin: `https://public.test:${port}`, requests, fetcher, lookup };
}

describe("fetchUntrusted's own limits", () => {
  it("reads an answer up to 64 KiB and refuses one byte more", async () => {
    const { origin, fetcher, lookup } = await publicHost(
      (request, response) => {
        response.end(
          Buffer.alloc(request.url === "/over" ? 64 * KIB + 1 : 64 * KIB),
        );
      },
    );

    const response = await fetcher.fetchUntrusted(`${origin}/fits`);

    expect((await response.arrayBuffer()).byteLength).toBe(64 * KIB);
    expect(lookup).toHaveBeenCalledWith("public.test");
    await expect(fetcher.fetchUntrusted(`${origin}/over`)).rejects.toThrow(
      `The answer from ${origin} is larger than 65,536 bytes, so it was refused.`,
    );
  });

  // Fake timers do not reach AbortSignal.timeout, so the 5 seconds are read off
  // the call and a 50 ms signal stands in, which still cuts off a silent host.
  it("stops a host that has not answered within 5 seconds", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => realTimeout(50));
    const { origin, fetcher } = await publicHost(() => undefined);

    await expect(fetcher.fetchUntrusted(origin)).rejects.toThrow(
      `${origin} did not answer within 5 seconds, so the request was stopped.`,
    );
    expect(timeout).toHaveBeenCalledExactlyOnceWith(5_000);
  });

  it("refuses a redirect", async () => {
    const { origin, requests, fetcher } = await publicHost(
      (_request, response) => {
        response.writeHead(301, { location: "https://elsewhere.test/" }).end();
      },
    );

    await expect(fetcher.fetchUntrusted(`${origin}/start`)).rejects.toThrow(
      `Refused the answer from ${origin}: it redirects (301), and redirects are not followed.`,
    );
    expect(requests).toEqual(["GET /start"]);
  });
});

describe("fetchFixed", () => {
  it("reaches a configured host with the caller's method, headers and body", async () => {
    const { origin, fetcher } = await fixedHost((request, response) => {
      response.writeHead(201, {
        "x-method": request.method,
        "x-authorization": request.headers.authorization,
      });
      request.pipe(response);
    });

    const response = await fetcher.fetchFixed(
      `${origin}/powerbi/v1.0/myorg/groups`,
      {
        method: "POST",
        headers: { authorization: "Bearer sample-token" },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("x-method")).toBe("POST");
    expect(response.headers.get("x-authorization")).toBe("Bearer sample-token");
    expect(await response.text()).toBe("grant_type=client_credentials");
  });

  it("refuses a header it cannot send with a fixed sentence that quotes none of it, and sends nothing", async () => {
    const { origin, requests, fetcher } = await fixedHost(
      (_request, response) => response.end(),
    );
    for (const value of ["Bearer sk-not-real\nX-Injected: 1", "Bearer sk- "]) {
      const error = await fetcher
        .fetchFixed(`${origin}/powerbi/v1.0/myorg/groups`, {
          headers: { authorization: value },
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as Error).message).toBe(
        `Could not send the request to ${origin}.`,
      );
    }
    expect(requests).toEqual([]);
  });

  it("sends a FormData body as multipart", async () => {
    const { origin, fetcher } = await fixedHost((request, response) =>
      response.end(request.headers["content-type"]),
    );
    const form = new FormData();
    form.append("model", "sample");

    const response = await fetcher.fetchFixed(origin, {
      method: "POST",
      body: form,
    });

    expect(await response.text()).toMatch(/^multipart\/form-data; boundary=/);
  });

  it("refuses an answer past max_bytes, whether it declares its length or streams", async () => {
    const { origin, fetcher } = await fixedHost((request, response) => {
      if (request.url === "/declared")
        response.setHeader("content-length", 1200);
      response.write(Buffer.alloc(600));
      response.end(Buffer.alloc(600));
    });

    for (const path of ["/declared", "/streamed"]) {
      await expect(
        fetcher.fetchFixed(`${origin}${path}`, { max_bytes: 1024 }),
      ).rejects.toMatchObject({
        kind: "upstream",
        message: `The answer from ${origin} is larger than 1,024 bytes, so it was refused.`,
      });
    }
  });

  it("holds an answer to 16 MiB unless the call raises the limit, up to 32 MiB", async () => {
    const { origin, fetcher } = await fixedHost((_request, response) =>
      response.end(Buffer.alloc(16 * MIB + 1)),
    );

    await expect(fetcher.fetchFixed(origin)).rejects.toThrow(
      "larger than 16,777,216 bytes",
    );
    const raised = await fetcher.fetchFixed(origin, { max_bytes: 32 * MIB });
    expect((await raised.arrayBuffer()).byteLength).toBe(16 * MIB + 1);
  });

  it("stops a host that has not finished answering within timeout_ms", async () => {
    const { origin, fetcher } = await fixedHost((request, response) => {
      if (request.url === "/body") response.writeHead(200).write("the start");
    });

    for (const path of ["/silent", "/body"]) {
      await expect(
        fetcher.fetchFixed(`${origin}${path}`, { timeout_ms: 200 }),
      ).rejects.toMatchObject({
        kind: "upstream",
        message: `${origin} did not answer within 0.2 seconds, so the request was stopped.`,
      });
    }
  });

  it("gives a host 30 seconds to answer unless the call raises the limit", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { origin, fetcher } = await fixedHost((_request, response) =>
      response.end(),
    );

    await fetcher.fetchFixed(origin);
    await fetcher.fetchFixed(origin, { timeout_ms: 300_000 });

    expect(timeout.mock.calls).toEqual([[30_000], [300_000]]);
  });

  it("refuses a limit above its ceiling without sending the request", async () => {
    const { origin, requests, fetcher } = await fixedHost(
      (_request, response) => response.end(),
    );

    await expect(
      fetcher.fetchFixed(origin, { timeout_ms: 300_001 }),
    ).rejects.toThrow(RangeError);
    await expect(
      fetcher.fetchFixed(origin, { max_bytes: 32 * MIB + 1 }),
    ).rejects.toThrow(RangeError);
    expect(requests).toEqual([]);
  });

  it("does not follow a redirect", async () => {
    const { origin, requests, fetcher } = await fixedHost(
      (_request, response) => {
        response.writeHead(302, { location: "/elsewhere" }).end();
      },
    );

    await expect(fetcher.fetchFixed(`${origin}/start`)).rejects.toMatchObject({
      kind: "upstream",
      message: `Refused the answer from ${origin}: it redirects (302), and redirects are not followed.`,
    });
    expect(requests).toEqual(["GET /start"]);
  });
});

describe("response compression", () => {
  it.each(["zstd", "ZsTd", "gzip, zstd", "zstd, br"])(
    "refuses %s before decoding even when unsolicited",
    async (encoding) => {
      const decoder = vi.spyOn(zlib, "createZstdDecompress");
      const body = zstdCompressSync(Buffer.from("benign compressed sample"));
      const { origin, fetcher } = await publicHost((request, response) => {
        expect(request.headers["accept-encoding"]).toBe("gzip, deflate, br");
        response.writeHead(200, { "content-encoding": encoding });
        response.end(body);
      });
      await expect(
        fetcher.fetchUntrusted(origin, {
          headers: { "Accept-Encoding": "zstd" },
        }),
      ).rejects.toMatchObject({
        kind: "upstream",
        message:
          "Refused a zstd-compressed response: this runtime's decoder is not safe to use.",
      });
      expect(decoder).not.toHaveBeenCalled();
    },
  );

  it("refuses zstd from configured hosts too and still decodes gzip", async () => {
    const { origin, fetcher } = await fixedHost((request, response) => {
      const zstd = request.url === "/zstd";
      response.writeHead(200, { "content-encoding": zstd ? "zstd" : "gzip" });
      response.end(
        zstd
          ? zstdCompressSync(Buffer.from("sample"))
          : gzipSync(Buffer.from("sample")),
      );
    });
    await expect(fetcher.fetchFixed(`${origin}/zstd`)).rejects.toMatchObject({
      kind: "upstream",
      message:
        "Refused a zstd-compressed response: this runtime's decoder is not safe to use.",
    });
    expect(await (await fetcher.fetchFixed(`${origin}/gzip`)).text()).toBe(
      "sample",
    );
  });
});
