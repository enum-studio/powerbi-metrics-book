import { expect, it, vi } from "vitest";
import { runServer } from "./server.js";
import { seedSample } from "./services/sample/seed.js";

vi.mock("./services/sample/seed.js", () => ({ seedSample: vi.fn() }));

it("lists sample-seed in help without building deps", async () => {
  const print = vi.fn();
  await runServer(["--help"], {}, print);
  expect(print).toHaveBeenCalledWith(expect.stringContaining("sample-seed"));
});

it("lets sample-seed build its own api deps", async () => {
  const env = { DATABASE_URL: "postgres://api_rw@localhost/sample" };
  const print = vi.fn();
  await runServer(["sample-seed"], env, print);
  expect(seedSample).toHaveBeenCalledWith(env, print);
});

it("refuses sample-seed in the worker", async () => {
  await expect(
    runServer(
      ["sample-seed"],
      { DATABASE_URL: "postgres://worker_rw@localhost/sample" },
      vi.fn(),
    ),
  ).rejects.toThrow("Run sample-seed in the api");
});

it("refuses extra arguments", async () => {
  await expect(
    runServer(["sample-seed", "extra"], {}, vi.fn()),
  ).rejects.toThrow("usage: server");
});
