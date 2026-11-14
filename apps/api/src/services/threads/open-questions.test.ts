import { describe, expect, it } from "vitest";
import {
  asPerson,
  id,
  reaching,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { openQuestionsFor } from "./open-questions.js";
import { acceptReply, postThread, reply } from "./threads.js";

useMirror();

const element = { kind: "dataset" as const, id: id.sales };

async function acceptedAnswer(tx: Db, body: string) {
  const context = asPerson(reaching({ powerbi_app_ids: [id.sales_app] }), {
    db: tx,
  });
  await context.settings.set("questions.enabled", true, context.principal);
  const question = await postThread(context, {
    kind: "question",
    element,
    title: "Which period?",
    body: "A sample question.",
  });
  const answer = await reply(context, question.id, body);
  await acceptReply(context, question.id, answer.id);
  return (await openQuestionsFor(context, element))?.accepted_answers[0];
}

describe("accepted answer excerpts", () => {
  it("keeps exactly 2000 code points without a truncation flag", () =>
    rolledBack(async (tx) => {
      const body = "😀".repeat(2000);
      const answer = await acceptedAnswer(tx, body);
      expect(answer?.answer).toBe(body);
      expect(answer).not.toHaveProperty("excerpt_truncated");
    }));

  it("cuts a longer accepted answer at a word end and flags it", () =>
    rolledBack(async (tx) => {
      const answer = await acceptedAnswer(tx, "Sample answer ".repeat(200));
      expect(answer).toMatchObject({ excerpt_truncated: true });
      expect(answer?.answer).toMatch(/Sample…$/u);
      expect(Array.from(answer?.answer ?? "").length).toBeLessThanOrEqual(2000);
    }));
});
