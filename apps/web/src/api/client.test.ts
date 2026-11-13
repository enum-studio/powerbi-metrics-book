import { describe, expect, it } from "vitest";
import { ApiError, createApi, read } from "./client";

const ME = { id: "a0000000-0000-4000-8000-000000000001", sample_data: true };

/** A client whose every request gets this answer, recording what it sent. */
function answering(answer: () => Promise<Response>) {
  const sent: Request[] = [];
  const api = createApi({
    baseUrl: "http://pbmb.test",
    fetch: (request: Request) => {
      sent.push(request);
      return answer();
    },
  });
  return { api, sent };
}

const json = (status: number, body: unknown, type = "application/json") =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": type },
    }),
  );

describe("the API client", () => {
  it("sends the session cookie to the api's own origin and answers the data", async () => {
    const { api, sent } = answering(() => json(200, ME));
    expect(await read(api.GET("/api/v1/me"))).toEqual(ME);
    expect(sent[0]?.url).toBe("http://pbmb.test/api/v1/me");
    expect(sent[0]?.credentials).toBe("include");
  });

  it("throws the api's own sentence with its status and kind", async () => {
    const { api } = answering(() =>
      json(404, {
        error: "not_found",
        message: "No metric is named sample_x.",
      }),
    );
    const error = await read(api.GET("/api/v1/me")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      kind: "not_found",
      message: "No metric is named sample_x.",
    });
  });

  it("exposes a refusal that may be saved anyway, and no other error does", async () => {
    const refusal = {
      error: "invalid",
      message:
        "x failed its check: Nope. Save it with save_failing to keep it anyway.",
      save_failing_allowed: true,
      check: { name: "x", message: "Nope." },
    };
    const { api } = answering(() => json(400, refusal));
    expect(
      await read(api.GET("/api/v1/me")).catch((e: unknown) => e),
    ).toMatchObject({ saveAnyway: { check: "x", message: "Nope." } });
    const plain = answering(() =>
      json(400, { error: "invalid", message: "x is not valid." }),
    );
    expect(
      await read(plain.api.GET("/api/v1/me")).catch((e: unknown) => e),
    ).toMatchObject({ saveAnyway: null });
  });

  it("says what happened when the answer is not the api's error", async () => {
    const { api } = answering(() =>
      Promise.resolve(
        new Response("<html>Bad gateway</html>", { status: 502 }),
      ),
    );
    await expect(read(api.GET("/api/v1/me"))).rejects.toMatchObject({
      status: 502,
      kind: "unknown",
      message:
        "The server answered 502 without saying why. Reload the page; if it happens again, the api's log has the reason.",
    });
  });

  it("says the server could not be reached when the request never got an answer", async () => {
    const { api } = answering(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    await expect(read(api.GET("/api/v1/me"))).rejects.toMatchObject({
      status: 0,
      kind: "unreachable",
      message:
        "Power BI Metrics Book could not be reached. Check your connection, then reload the page.",
    });
  });
});
