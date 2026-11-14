import { NO_SUCH_DATASET } from "../../errors.js";
import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  asPerson,
  fileUnder,
  id,
  metricIn,
  reaching,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { user } from "../../db/schema/auth.js";
import { metricVariant, term } from "../../db/schema/book.js";
import { piiRule } from "../../db/schema/pii.js";
import { event, type EventKind } from "../../db/schema/events.js";
import { thread, type ThreadElement } from "../../db/schema/threads.js";
import type { Principal } from "../../principal.js";
import { getMetric } from "../book/metrics.js";
import { createTerm, getTerm } from "../book/terms.js";
import { getDataset } from "../mirror/read.js";
import {
  acceptReply,
  archiveThread,
  getThread,
  listThreads,
  postThread,
  reply,
  setUpvote,
} from "./threads.js";

useMirror();

const person = (
  name: string,
  role: "viewer" | "curator" = "viewer",
  lists: Principal["attributes"] = { powerbi_app_ids: [id.sales_app] },
): Principal => ({ ...reaching(lists, role), id: `test-${name}` });
const asker = person("asker");
const other = person("other");
const curator = person("curator", "curator");
const leader = person("leader", "viewer", {
  powerbi_app_ids: [id.leadership_app],
});
const outsider = person("outsider", "viewer", {});

/** One clock for the whole test, a second apart, so replies and views have an order. */
function session(tx: Db) {
  let at = Date.parse("2026-10-26T10:00:00Z");
  const clock = () => {
    at += 1000;
    return new Date(at);
  };
  return (principal: Principal) => ({
    ...asPerson(principal, { db: tx }),
    clock,
  });
}
type As = ReturnType<typeof session>;

const salesDataset: ThreadElement = { kind: "dataset", id: id.sales };
const ask = (
  context: ReturnType<As>,
  title = "Is net sales before returns?",
  element: ThreadElement = salesDataset,
) =>
  postThread(context, {
    kind: "question",
    element,
    title,
    body: "I need it for the board pack.",
  });

const failure = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error,
  );
const eventsOf = (tx: Db, kind: EventKind) =>
  tx
    .select({ element: event.element_id, data: event.data })
    .from(event)
    .where(eq(event.kind, kind))
    .orderBy(asc(event.id));

describe("listThreads and getThread", () => {
  it("keeps exactly 300 code points without a truncation flag", () =>
    rolledBack(async (tx) => {
      const context = session(tx)(asker);
      const body = "😀".repeat(300);
      const posted = await postThread(context, {
        kind: "question",
        element: salesDataset,
        title: "Which period?",
        body,
      });
      const listed = (await listThreads(context)).items.find(
        (item) => item.id === posted.id,
      );
      expect(listed?.excerpt).toBe(body);
      expect(listed).not.toHaveProperty("excerpt_truncated");
    }));

  it("cuts longer excerpts at a word end and flags them", () =>
    rolledBack(async (tx) => {
      const context = session(tx)(asker);
      const posted = await postThread(context, {
        kind: "question",
        element: salesDataset,
        title: "Which period?",
        body: "Sample question ".repeat(30),
      });
      const listed = (await listThreads(context)).items.find(
        (item) => item.id === posted.id,
      );
      expect(listed?.excerpt).toMatch(/Sample…$/u);
      expect(Array.from(listed?.excerpt ?? "").length).toBeLessThanOrEqual(300);
      expect(listed?.excerpt_truncated).toBe(true);
    }));

  it("count a reply by another person as unread until the asker views the thread", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await ask(as(asker));
      await reply(as(other), question.id, "After returns, I think.");
      const unread = async () =>
        (await listThreads(as(asker), { mine: true })).items.map(
          (item) => item.unread_replies,
        );
      expect(await unread()).toEqual([1]);
      // The asker's own reply is never new to the asker.
      await reply(as(asker), question.id, "Thanks, checking.");
      expect(await unread()).toEqual([1]);

      const read = await getThread(as(asker), question.id);
      expect(read.unread_replies).toBe(1);
      expect(read.replies.map((one) => one.body)).toEqual([
        "After returns, I think.",
        "Thanks, checking.",
      ]);
      expect(await unread()).toEqual([0]);
      // The other person has not viewed it, and sees the asker's reply as theirs to read.
      expect(
        (await listThreads(as(other), { text: "board" })).items[0],
      ).toMatchObject({ unread_replies: 1, reply_count: 2 });
    }));

  it("name each asker by the display name of their account, and a removed one as such", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      await tx.insert(user).values({
        id: asker.id,
        name: "Asker",
        email: "asker@sample.example",
      });
      await ask(as(asker), "Which currency?");
      await ask(as(other), "Which grain?");
      const names = (await listThreads(as(asker), {})).items.map(
        (item) => item.author_name,
      );
      expect(names).toEqual(["a removed person", "Asker"]);
    }));

  it("name the asker of a term's question to a caller whose only dataset is one the sync has seen go", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const season = await createTerm(as(curator), {
        name: "Season",
        definition: "a season.",
      });
      await postThread(as(asker), {
        kind: "question",
        element: { kind: "term", id: season.id },
        title: "Which season?",
        body: "Spring or autumn?",
      });
      // The fixture's Sales 2023 dataset has a removed_at.
      const sawGone = person("saw-gone", "viewer", {
        powerbi_dataset_ids: [id.old],
      });
      const [listed] = (await listThreads(as(sawGone), {})).items;
      expect(listed?.author_name).toBe("a removed person");
      const [blind] = (await listThreads(as(outsider), {})).items;
      expect(blind?.author_name).toBeNull();
    }));

  it("filter by element, kind, status, words and mine, and page newest first", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const first = await ask(as(asker), "Why is Orders slow?");
      const comment = await postThread(as(other), {
        kind: "comment",
        element: { kind: "column", id: id.channel },
        body: "Channel codes are in Danish.",
      });
      const last = await ask(as(other), "Which currency?");
      await archiveThread(as(curator), first.id);

      const titles = (page: { items: { title: string | null }[] }) =>
        page.items.map((item) => item.title);
      const listed = (filters: Parameters<typeof listThreads>[1]) =>
        listThreads(as(asker), filters);
      expect(titles(await listed({}))).toEqual(["Which currency?", null]);
      expect(titles(await listed({ status: "archived" }))).toEqual([
        "Why is Orders slow?",
      ]);
      expect(titles(await listed({ kind: "comment" }))).toEqual([null]);
      expect(
        titles(await listed({ element: { kind: "column", id: id.channel } })),
      ).toEqual([null]);
      expect(titles(await listed({ mine: true }))).toEqual([]);
      // The trigger indexes title and body; the words are not stemmed.
      expect(titles(await listed({ text: "currency" }))).toEqual([
        "Which currency?",
      ]);
      expect((await listed({ text: "danish" })).items[0]?.id).toBe(comment.id);
      expect((await listed({ text: "pounds" })).items).toEqual([]);

      const page = await listed({ limit: 1 });
      expect(page.items.map((item) => item.id)).toEqual([last.id]);
      const next = await listed({ limit: 1, cursor: page.next_cursor ?? "" });
      expect(next.items.map((item) => item.id)).toEqual([comment.id]);
      expect(next.next_cursor).toBeNull();
      await expect(listed({ cursor: "nonsense" })).rejects.toMatchObject({
        kind: "invalid",
      });
    }));
});

describe("what a caller may not see", () => {
  it("answers a thread on a hidden element as it answers a missing one, in every function", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const profit: ThreadElement = { kind: "measure", id: id.profit };
      const hidden = await ask(as(leader), "What is in profit?", profit);
      const metricId = await metricIn(tx, "sample_data_margin");
      await fileUnder(tx, metricId, id.profit);
      const onMetric = await ask(as(leader), "Which margin?", {
        kind: "metric",
        id: metricId,
      });

      const refusals = async (threadId: string) => [
        await failure(getThread(as(asker), threadId)),
        await failure(reply(as(asker), threadId, "Hello")),
        await failure(acceptReply(as(asker), threadId, randomUUID())),
        await failure(setUpvote(as(asker), threadId, true)),
        await failure(archiveThread(as(curator), threadId)),
      ];
      const gone = await refusals(randomUUID());
      expect(gone[0]).toMatchObject({
        kind: "not_found",
        message: "No such thread.",
      });
      expect(await refusals(hidden.id)).toEqual(gone);
      expect(await refusals(onMetric.id)).toEqual(gone);

      expect(
        (await listThreads(as(asker))).items.map((item) => item.id),
      ).toEqual([]);
      expect(
        (await listThreads(as(leader))).items.map((item) => item.id),
      ).toEqual([onMetric.id, hidden.id]);
      expect(await failure(ask(as(outsider)))).toMatchObject({
        kind: "not_found",
        message: NO_SUCH_DATASET,
      });
      expect(await failure(ask(as(asker), "Q", profit))).toMatchObject({
        kind: "not_found",
        message: "No such measure.",
      });
    }));

  it("lists and searches nothing on a dataset the caller may no longer describe", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const profit: ThreadElement = { kind: "measure", id: id.profit };
      const withFinance = person("asker", "viewer", {
        powerbi_app_ids: [id.sales_app, id.leadership_app],
      });
      const posted = await ask(as(withFinance), "What is in profit?", profit);
      const found = async (principal: Principal) => [
        ...(await listThreads(as(principal), { text: "profit" })).items,
        ...(await listThreads(as(principal), { element: profit })).items,
      ];
      expect((await found(withFinance)).map((item) => item.id)).toEqual([
        posted.id,
        posted.id,
      ]);
      // The same person, now with the Sales app alone.
      expect(await found(asker)).toEqual([]);
    }));

  it("keeps a service account from acting as a person of the same id", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await ask(as(asker));
      const impostor: Principal = {
        ...asker,
        kind: "service_account",
        roles: ["viewer"],
      };
      expect(
        await failure(acceptReply(as(impostor), question.id, randomUUID())),
      ).toMatchObject({ kind: "refused" });
      expect((await listThreads(as(impostor), { mine: true })).items).toEqual(
        [],
      );
    }));
});

describe("principals of one id and two kinds", () => {
  const accountOf = (principal: Principal): Principal => ({
    ...principal,
    kind: "service_account",
    roles: ["viewer"],
  });

  it("keep their upvotes apart", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await ask(as(asker));
      const upvote = (principal: Principal, upvoted: boolean) =>
        setUpvote(as(principal), question.id, upvoted);
      await upvote(other, true);
      expect(await upvote(accountOf(other), true)).toMatchObject({
        upvote_count: 2,
      });
      expect(await upvote(accountOf(other), false)).toMatchObject({
        upvote_count: 1,
      });
      expect(await getThread(as(other), question.id)).toMatchObject({
        upvote_count: 1,
        upvoted: true,
      });
    }));

  it("keep their views apart", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await ask(as(asker));
      await reply(as(other), question.id, "After returns.");
      await getThread(as(accountOf(asker)), question.id);
      const unread = async () =>
        (await listThreads(as(asker), { mine: true })).items[0]?.unread_replies;
      expect(await unread()).toBe(1);
      await getThread(as(asker), question.id);
      expect(await unread()).toBe(0);
    }));
});

describe("postThread on PII elements", () => {
  const by = { set_by_kind: "person", set_by_id: "x", set_via: "api" };
  const markPii = (tx: Db) =>
    tx.insert(piiRule).values([
      {
        kind: "column",
        table_name: "Sales",
        name: "Channel",
        pii: true,
        ...by,
      },
      {
        kind: "measure",
        table_name: "Sales",
        name: "Net sales",
        pii: true,
        ...by,
      },
    ]);
  const onlyPii = async (tx: Db) => {
    const metricId = await metricIn(tx, "pii_only_thread_test");
    const [variant] = await fileUnder(tx, metricId, id.net_sales).returning({
      id: metricVariant.id,
    });
    return { metricId, variantId: variant?.id ?? "" };
  };
  const reader: Principal = { ...asker, roles: [...asker.roles, "pii_reader"] };

  it("answers not_found for a PII column, measure or metric, as for one that is not there", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      await markPii(tx);
      const { metricId, variantId } = await onlyPii(tx);
      const elements: ThreadElement[] = [
        { kind: "column", id: id.channel },
        { kind: "measure", id: id.net_sales },
        { kind: "variant", id: variantId },
        { kind: "metric", id: metricId },
      ];
      for (const element of elements) {
        await expect(ask(as(asker), "Is it?", element)).rejects.toMatchObject({
          kind: "not_found",
        });
        expect((await ask(as(reader), "Is it?", element)).element).toEqual(
          element,
        );
      }
      await expect(
        ask(as(asker), "Is it?", { kind: "column", id: id.order_date }),
      ).resolves.toMatchObject({ kind: "question" });
    }));
});

describe("postThread", () => {
  it("stores the body as written, returns the anchor and announces it", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const body = "  <script>alert(1)</script>\n\n**bold**  ";
      const created = await postThread(as(asker), {
        kind: "question",
        element: salesDataset,
        title: "  Padded title ",
        body,
      });
      expect(created).toMatchObject({
        kind: "question",
        element: salesDataset,
        title: "Padded title",
        body,
        author: { kind: "person", id: asker.id },
        status: "open",
        accepted_reply_id: null,
        reply_count: 0,
        unread_replies: 0,
        upvote_count: 0,
      });
      expect(await eventsOf(tx, "thread.created")).toEqual([
        {
          element: created.id,
          data: { thread_kind: "question", element: salesDataset },
        },
      ]);
    }));

  it("refuses a question without a title, a comment with one, and a body that cannot be kept", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const post = (input: {
        kind: "question" | "comment";
        title?: string;
        body: string;
      }) => failure(postThread(as(asker), { element: salesDataset, ...input }));
      expect(await post({ kind: "question", body: "x" })).toMatchObject({
        kind: "invalid",
        message: "A question needs a title.",
      });
      expect(
        await post({ kind: "comment", title: "T", body: "x" }),
      ).toMatchObject({ kind: "invalid", message: "A comment has no title." });
      expect(await post({ kind: "comment", body: "   " })).toMatchObject({
        message: "The body is empty.",
      });
      expect(await post({ kind: "comment", body: "a\0b" })).toMatchObject({
        kind: "invalid",
      });
      expect(
        await post({ kind: "comment", body: "x".repeat(20_001) }),
      ).toMatchObject({
        message: "The body is longer than 20000 characters.",
      });
      expect(
        await failure(ask(as(asker), "Q", { kind: "query", id: randomUUID() })),
      ).toMatchObject({
        kind: "not_found",
      });
    }));
});

describe("reply, accept, archive and upvote", () => {
  it("lets the asker or a curator accept one reply of the thread, and nobody else", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await ask(as(asker));
      const elsewhere = await ask(as(asker), "Another question");
      const answer = await reply(as(other), question.id, "Before returns.");
      const foreign = await reply(as(other), elsewhere.id, "Unrelated.");
      expect(answer).toMatchObject({
        thread_id: question.id,
        author: { kind: "person", id: other.id },
        edited_at: null,
      });

      expect(
        await failure(acceptReply(as(other), question.id, answer.id)),
      ).toMatchObject({ kind: "refused" });
      expect(
        await failure(acceptReply(as(asker), question.id, foreign.id)),
      ).toMatchObject({ kind: "not_found" });
      const accepted = await acceptReply(as(asker), question.id, answer.id);
      expect(accepted).toMatchObject({
        status: "answered",
        accepted_reply_id: answer.id,
        reply_count: 1,
      });
      const second = await reply(as(other), question.id, "Or after discounts.");
      const switched = await acceptReply(as(curator), question.id, second.id);
      expect(switched.accepted_reply_id).toBe(second.id);
      // Accepting what is already accepted announces nothing more.
      await acceptReply(as(curator), question.id, second.id);
      const answered = (reply_id: string) => ({
        element: question.id,
        data: { thread_kind: "question", element: salesDataset, reply_id },
      });
      expect(await eventsOf(tx, "thread.answered")).toEqual([
        answered(answer.id),
        answered(second.id),
      ]);
      expect(
        (await getThread(as(asker), question.id)).replies.map(
          (one) => one.accepted,
        ),
      ).toEqual([false, true]);
    }));

  it("lets only a curator archive, keeps the thread, and closes it to replies", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await ask(as(asker));
      expect(
        await failure(archiveThread(as(asker), question.id)),
      ).toMatchObject({
        kind: "refused",
      });
      expect(await archiveThread(as(curator), question.id)).toMatchObject({
        status: "archived",
      });
      await archiveThread(as(curator), question.id);
      expect(await eventsOf(tx, "thread.archived")).toHaveLength(1);
      expect((await getThread(as(asker), question.id)).status).toBe("archived");
      expect(
        await failure(reply(as(other), question.id, "Late")),
      ).toMatchObject({ kind: "conflict" });
      expect(
        await failure(setUpvote(as(other), question.id, true)),
      ).toMatchObject({ kind: "conflict" });
    }));

  it("counts one upvote per principal on a question and none on a comment", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await ask(as(asker));
      const counted = async (p: Principal, upvoted: boolean) =>
        (await setUpvote(as(p), question.id, upvoted)).upvote_count;
      expect(await counted(other, true)).toBe(1);
      expect(await counted(other, true)).toBe(1);
      expect(await counted(asker, true)).toBe(2);
      expect(await counted(other, false)).toBe(1);
      expect(await counted(other, false)).toBe(1);
      expect(await getThread(as(other), question.id)).toMatchObject({
        upvote_count: 1,
        upvoted: false,
      });
      const comment = await postThread(as(asker), {
        kind: "comment",
        element: salesDataset,
        body: "Noted.",
      });
      expect(
        await failure(setUpvote(as(other), comment.id, true)),
      ).toMatchObject({
        kind: "invalid",
      });
    }));
});

describe("who accepted an answer", () => {
  const by = async (as: As, accepter: Principal, author: Principal) => {
    const question = await ask(as(asker));
    const answer = await reply(as(author), question.id, "Before returns.");
    await acceptReply(as(accepter), question.id, answer.id);
    return question.id;
  };

  it("reads as a curator's, the asker's, or the asker's on their own reply", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const read = async (id: string) =>
        (await getThread(as(asker), id)) as Record<string, unknown>;
      expect(await read(await by(as, curator, other))).toMatchObject({
        accepted_by_role: "curator",
        accepted_by_kind: "person",
      });
      expect(await read(await by(as, asker, other))).toMatchObject({
        accepted_by_role: "asker",
      });
      expect(await read(await by(as, asker, asker))).toMatchObject({
        accepted_by_role: "asker_own_reply",
      });
    }));

  it("labels a service account that accepts as one", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const agent: Principal = {
        ...curator,
        kind: "service_account",
        id: "test-agent",
      };
      const question = await ask(as(asker));
      const answer = await reply(as(other), question.id, "Before returns.");
      expect(
        await acceptReply(as(agent), question.id, answer.id),
      ).toMatchObject({
        accepted_by_role: "curator",
        accepted_by_kind: "service_account",
      });
    }));

  it("reads a curator who is the asker as the asker, never a curator", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await ask(as(curator));
      const theirs = await reply(as(other), question.id, "Before returns.");
      const own = await reply(as(curator), question.id, "I think so.");
      expect(
        await acceptReply(as(curator), question.id, theirs.id),
      ).toMatchObject({ accepted_by_role: "asker" });
      expect(await acceptReply(as(curator), question.id, own.id)).toMatchObject(
        { accepted_by_role: "asker_own_reply" },
      );
    }));

  it("reads a role a policy lets accept, other than a curator, as other", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const admin: Principal = {
        ...curator,
        id: "test-admin",
        roles: ["admin"],
      };
      const question = await ask(as(asker));
      const answer = await reply(as(other), question.id, "Before returns.");
      expect(
        await acceptReply(as(admin), question.id, answer.id),
      ).toMatchObject({ accepted_by_role: "other" });
    }));

  it("records where it was accepted from, so an agent on a person's token shows", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await ask(as(asker));
      const answer = await reply(as(other), question.id, "Before returns.");
      expect(
        await acceptReply(as({ ...asker, via: "mcp" }), question.id, answer.id),
      ).toMatchObject({ accepted_by_kind: "person", accepted_by_via: "mcp" });
    }));

  it("lets a curator's acceptance replace the asker's or an unknown one, and nothing else", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await ask(as(asker));
      const answer = await reply(as(other), question.id, "Before returns.");
      await acceptReply(as(asker), question.id, answer.id);
      const agent = { ...curator, via: "mcp" as const };
      expect(
        await acceptReply(as(agent), question.id, answer.id),
      ).toMatchObject({
        accepted_by_role: "curator",
        accepted_by_via: "mcp",
      });
      // The asker accepting again does not take it back.
      expect(
        await acceptReply(as(asker), question.id, answer.id),
      ).toMatchObject({ accepted_by_role: "curator" });
      await tx
        .update(thread)
        .set({
          accepted_by_role: null,
          accepted_by_kind: null,
          accepted_by_via: null,
        })
        .where(eq(thread.id, question.id));
      expect(
        await acceptReply(as(curator), question.id, answer.id),
      ).toMatchObject({
        accepted_by_role: "curator",
        accepted_by_via: "browser",
      });
    }));

  it("reads an answer accepted before it was kept as unknown, never a curator's", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await by(as, curator, other).then(async (qid) => {
        await tx
          .update(thread)
          .set({
            accepted_by_role: null,
            accepted_by_kind: null,
            accepted_by_via: null,
          })
          .where(eq(thread.id, qid));
        return qid;
      });
      expect(await getThread(as(asker), question)).toMatchObject({
        accepted_by_role: "unknown",
        accepted_by_kind: null,
      });
      expect(
        (await getDataset(as(asker), id.sales)).accepted_answers,
      ).toMatchObject([{ thread_id: question, accepted_by_role: "unknown" }]);
    }));
});

describe("open questions on an element", () => {
  it("are counted, with accepted answers, in getMetric, getTerm and getDataset", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const metricId = await metricIn(tx, "sample_data_net_sales");
      await fileUnder(tx, metricId, id.net_sales);
      const [row] = await tx
        .insert(term)
        .values({ name: "Sample data season" })
        .returning({ id: term.id });
      const termId = row?.id ?? "";
      const targets = [
        {
          element: { kind: "metric", id: metricId },
          get: () => getMetric(as(asker), metricId),
        },
        {
          element: { kind: "term", id: termId },
          get: () => getTerm(as(asker), termId),
        },
        { element: salesDataset, get: () => getDataset(as(asker), id.sales) },
      ] as const;
      for (const { element, get } of targets) {
        expect(await get()).toMatchObject({
          open_questions: 0,
          accepted_answers: [],
        });
        const open = await ask(as(asker), "Still open?", element);
        const answered = await ask(as(asker), "Answered?", element);
        await ask(as(asker), "Archived?", element).then((one) =>
          archiveThread(as(curator), one.id),
        );
        const text = await reply(as(other), answered.id, "Yes. ".repeat(1000));
        await acceptReply(as(asker), answered.id, text.id);
        const seen = await get();
        expect(seen.open_questions).toBe(1);
        expect(seen.accepted_answers).toEqual([
          {
            thread_id: answered.id,
            question: "Answered?",
            answer: "Yes. ".repeat(399) + "Yes.…",
            excerpt_truncated: true,
            answered_by: { kind: "person", id: other.id },
            accepted_by_role: "asker",
            accepted_by_kind: "person",
            accepted_by_via: "browser",
          },
        ]);
        expect(open.status).toBe("open");
      }
    }));
});

describe("the tables", () => {
  const insertThread = (tx: Db, values: Record<string, unknown>) =>
    tx.execute(
      sql`insert into thread (kind, element_kind, element_id, title, body, author_kind, author_id)
          values (${values.kind}, 'term', ${randomUUID()}, ${values.title ?? null}, 'Body', 'person', 'test-asker')`,
    );

  it("hold a question to its title, and a comment to none", async () => {
    for (const values of [
      { kind: "question" },
      { kind: "question", title: "" },
      { kind: "comment", title: "Title" },
    ]) {
      await rolledBack(async (tx) => {
        await expect(insertThread(tx, values)).rejects.toMatchObject({
          cause: { constraint: "thread_title_check" },
        });
      });
    }
  });

  it("accept only a reply of the same thread as its answer", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await ask(as(asker));
      const elsewhere = await ask(as(asker), "Another");
      const foreign = await reply(as(other), elsewhere.id, "Elsewhere.");
      await expect(
        tx.execute(
          sql`update thread set status = 'answered', accepted_reply_id = ${foreign.id} where id = ${question.id}`,
        ),
      ).rejects.toMatchObject({
        cause: { constraint: "thread_accepted_reply_fkey" },
      });
    }));

  it("leave a thread's words and author unchanged for the api's role", () =>
    rolledBack(async (tx) => {
      const as = session(tx);
      const question = await ask(as(asker));
      await expect(
        tx.execute(
          sql`update thread set body = 'Edited' where id = ${question.id}`,
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    }));
});
