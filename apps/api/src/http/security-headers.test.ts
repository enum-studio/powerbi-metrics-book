import { Hono } from "hono";
import { expect, it } from "vitest";
import {
  bodySizeLimit,
  conventionsBodySizeLimit,
  MAX_BODY_BYTES,
} from "./security-headers.js";

for (const streamed of [false, true]) {
  it.each([
    ["PUT", "/api/v1/conventions"],
    ["POST", "/api/v1/conventions/diff"],
    ["POST", "/api/v1/conventions/apply"],
  ])(
    `defers conventions bodies to route authorization (streamed: ${String(streamed)}) on %s %s`,
    async (method, path) => {
      const app = new Hono();
      app.use(bodySizeLimit);
      app.on(method, path, (c) => c.text("refused", 403));
      let reads = 0;
      const size = 9 * MAX_BODY_BYTES;
      const response = await app.request(path, {
        method,
        headers: streamed ? {} : { "content-length": String(size) },
        body: streamed
          ? new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  reads += 1;
                  controller.enqueue(new Uint8Array(size));
                  controller.close();
                },
              },
              { highWaterMark: 0 },
            )
          : "x".repeat(size),
        duplex: "half",
      });
      expect(response.status).toBe(403);
      expect(reads).toBe(0);
    },
  );
}

for (const streamed of [false, true]) {
  it.each([
    ["POST", "/api/v1/metrics", 2],
    ["PUT", "/api/v1/conventions", 9],
    ["POST", "/api/v1/conventions/diff", 9],
    ["POST", "/api/v1/conventions/apply", 9],
  ])(
    `limits authorized bodies (streamed: ${String(streamed)}) on %s %s`,
    async (method, path, mib) => {
      const app = new Hono();
      app.use(bodySizeLimit);
      app.on(method, path, conventionsBodySizeLimit, (c) => c.text("read"));
      const size = mib * MAX_BODY_BYTES;
      const response = await app.request(path, {
        method,
        headers: streamed ? {} : { "content-length": String(size) },
        body: streamed
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(size));
                controller.close();
              },
            })
          : "x".repeat(size),
        duplex: "half",
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        message: `The request body is larger than ${mib === 2 ? "1" : "8"} MiB.`,
      });
    },
  );
}
