import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const state = vi.hoisted(() => ({ cursors: [] as (string | undefined)[] }));

vi.mock("../api/client", () => ({
  api: {
    GET: (_path: string, options: { params: { query: { cursor?: string } } }) =>
      options,
  },
  read: (request: { params: { query: { cursor?: string } } }) => {
    const cursor = request.params.query.cursor;
    state.cursors.push(cursor);
    return Promise.resolve(
      cursor === undefined
        ? { items: [{ name: "First" }], next_cursor: "next-page" }
        : { items: [{ name: "Second" }], next_cursor: null },
    );
  },
}));

import { allPages, termsQuery } from "./queries";

describe("allPages", () => {
  it("follows each cursor and combines the pages in order", async () => {
    const cursors: (string | undefined)[] = [];
    const items = await allPages((cursor) => {
      cursors.push(cursor);
      return Promise.resolve(
        cursor === undefined
          ? { items: ["first", "second"], next_cursor: "next" }
          : { items: ["third"], next_cursor: null },
      );
    });
    expect(cursors).toEqual([undefined, "next"]);
    expect(items).toEqual(["first", "second", "third"]);
  });
});

describe("termsQuery", () => {
  it("loads every page using the returned cursor", async () => {
    state.cursors = [];
    const queryFn = termsQuery.queryFn;
    if (queryFn === undefined) throw new Error("termsQuery has no queryFn.");
    await expect(
      queryFn({
        client: new QueryClient(),
        queryKey: termsQuery.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
      }),
    ).resolves.toEqual([{ name: "First" }, { name: "Second" }]);
    expect(state.cursors).toEqual([undefined, "next-page"]);
  });
});
