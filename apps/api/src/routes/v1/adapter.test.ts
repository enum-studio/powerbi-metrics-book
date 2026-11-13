import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import { documented, stamp } from "./adapter.js";

const Thing = z.object({ id: z.string(), at: stamp });
const made = documented("A thing", Thing);

describe("documented().answer", () => {
  it("sends only the fields the schema declares, with a date as its ISO string", async () => {
    const at = new Date("2026-10-26T09:00:00Z");
    const app = new Hono<AppEnv>();
    app.get("/thing", (c) =>
      made.answer(c, { id: "a", at, secret: "never sent" } as z.input<
        typeof Thing
      >),
    );
    const answer = await app.request("/thing");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/json");
    expect(await answer.json()).toEqual({ id: "a", at: at.toISOString() });
  });
});
