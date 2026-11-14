import { and, count, desc, eq, sql } from "drizzle-orm";
import { excerpt } from "../text.js";
import type { Db } from "../../context.js";
import {
  thread,
  threadReply,
  type ThreadElement,
  type THREAD_ACCEPTED_BY,
  type THREAD_ACCEPTED_VIA,
} from "../../db/schema/threads.js";

/*
 * What the get_* answers say about an element's threads, so an agent sees
 * what people already asked before it answers. This module reads nothing of
 * the caller's rights: the get_* service has already found the element
 * visible, and that is the only element it passes in. It is apart from
 * threads.ts because the mirror's read service uses it, and threads.ts uses
 * that one.
 */

/** An answer shown on an element is the start of the reply (get_thread has all of it), and only this many, newest first. */
const ANSWER_EXCERPT = 2000;
const ANSWERS_PER_ELEMENT = 10;

/**
 * How an accepted answer reads: who accepted it, as the asker, as the asker
 * on their own reply, or as a curator, and whether a person or a service
 * account did. An answer accepted before this was kept is `unknown`, never
 * a curator's. No name: the kind and role are all a reader needs.
 */
export function acceptedByOf(row: {
  accepted_reply_id: string | null;
  accepted_by_role: (typeof THREAD_ACCEPTED_BY)[number] | null;
  accepted_by_kind: "person" | "service_account" | null;
  accepted_by_via: (typeof THREAD_ACCEPTED_VIA)[number] | null;
}) {
  return {
    accepted_by_role:
      row.accepted_reply_id === null
        ? null
        : (row.accepted_by_role ?? ("unknown" as const)),
    accepted_by_kind: row.accepted_by_kind,
    accepted_by_via: row.accepted_by_via,
  };
}

/** The open questions on one element and its accepted answers. Archived threads count for nothing. */
export async function openQuestionsFor(db: Db, element: ThreadElement) {
  const here = and(
    eq(thread.element_kind, element.kind),
    eq(thread.element_id, element.id),
  );
  const [open] = await db
    .select({ n: count() })
    .from(thread)
    .where(and(here, eq(thread.kind, "question"), eq(thread.status, "open")));
  const answers = await db
    .select({
      thread_id: thread.id,
      accepted_reply_id: thread.accepted_reply_id,
      accepted_by_role: thread.accepted_by_role,
      accepted_by_kind: thread.accepted_by_kind,
      accepted_by_via: thread.accepted_by_via,
      question: thread.title,
      answer: sql<string>`left(${threadReply.body}, ${ANSWER_EXCERPT + 1})`,
      author_kind: threadReply.author_kind,
      author_id: threadReply.author_id,
    })
    .from(thread)
    .innerJoin(
      threadReply,
      and(
        eq(threadReply.id, thread.accepted_reply_id),
        eq(threadReply.thread_id, thread.id),
      ),
    )
    .where(and(here, eq(thread.status, "answered")))
    .orderBy(desc(thread.updated_at), desc(thread.id))
    .limit(ANSWERS_PER_ELEMENT);
  return {
    open_questions: open?.n ?? 0,
    accepted_answers: answers.map((row) => {
      const answer = excerpt(row.answer, ANSWER_EXCERPT);
      return {
        thread_id: row.thread_id,
        question: row.question,
        answer: answer.text,
        ...(answer.truncated && { excerpt_truncated: true as const }),
        answered_by: { kind: row.author_kind, id: row.author_id },
        ...acceptedByOf(row),
      };
    }),
  };
}
