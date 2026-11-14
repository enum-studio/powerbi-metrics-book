import { Hono } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AppDeps } from "../../context.js";
import {
  THREAD_ELEMENT_KINDS,
  THREAD_KINDS,
  THREAD_STATUSES,
} from "../../db/schema/threads.js";
import * as threads from "../../services/threads/threads.js";
import {
  credential,
  documented,
  guid,
  refuse,
  serviceContext,
  text,
} from "./adapter.js";
import { Reply, Thread } from "./schemas.js";

const TITLE_MAX = 300;
const BODY_MAX = 20_000;
const id = z.object({ id: guid });
const kind = z.enum(THREAD_ELEMENT_KINDS);
const body = z.string().min(1).max(BODY_MAX);
const NewThread = z.strictObject({
  kind: z.enum(THREAD_KINDS),
  element: z.strictObject({ kind, id: guid }),
  title: z.string().max(TITLE_MAX).nullable().optional(),
  body,
});
const Filters = z.strictObject({
  element_kind: kind.optional(),
  element_id: guid.optional(),
  kind: z.enum(THREAD_KINDS).optional(),
  status: z.enum(THREAD_STATUSES).optional(),
  mine: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  text: text.optional(),
  cursor: text.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const Opened = Thread.extend({
  replies: z.array(Reply.extend({ accepted: z.boolean() })),
});
const Summary = Thread.omit({ body: true }).extend({
  excerpt: z.string(),
  excerpt_truncated: z.literal(true).optional(),
  author_name: z
    .string()
    .nullable()
    .describe(
      "The asker's display name, null for a caller who can see no dataset. Never an email.",
    ),
});

/** Questions and comments on any element: asking, answering, accepting, upvoting, archiving. */
export function threadsRoutes(deps: AppDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const as = serviceContext(deps);

  const ask = documented("Ask a question or comment", Thread, {
    status: 201,
    errors: [400, 404],
  });
  routes.post(
    "/threads",
    ask.doc,
    credential,
    validator("json", NewThread, refuse),
    async (c) =>
      ask.answer(c, await threads.postThread(as(c), c.req.valid("json"))),
  );

  const list = documented(
    "Threads the caller may see",
    z.object({ items: z.array(Summary), next_cursor: z.string().nullable() }),
    { errors: [400] },
  );
  routes.get(
    "/threads",
    list.doc,
    credential,
    validator("query", Filters, refuse),
    async (c) => {
      const { element_kind, element_id, ...filters } = c.req.valid("query");
      const element =
        element_kind === undefined || element_id === undefined
          ? undefined
          : { kind: element_kind, id: element_id };
      return list.answer(
        c,
        await threads.listThreads(as(c), { ...filters, element }),
      );
    },
  );

  const open = documented("A thread with its replies", Opened, {
    errors: [400, 404],
  });
  routes.get(
    "/threads/:id",
    open.doc,
    credential,
    validator("param", id, refuse),
    async (c) =>
      open.answer(c, await threads.getThread(as(c), c.req.valid("param").id)),
  );

  const answer = documented("Reply to a thread", Reply, {
    status: 201,
    errors: [400, 404, 409],
  });
  routes.post(
    "/threads/:id/replies",
    answer.doc,
    credential,
    validator("param", id, refuse),
    validator("json", z.strictObject({ body }), refuse),
    async (c) =>
      answer.answer(
        c,
        await threads.reply(
          as(c),
          c.req.valid("param").id,
          c.req.valid("json").body,
        ),
      ),
  );

  for (const upvoted of [true, false]) {
    const vote = documented(
      upvoted ? "Upvote a question" : "Take back an upvote",
      z.object({
        thread_id: z.string(),
        upvoted: z.boolean(),
        upvote_count: z.number(),
      }),
      { errors: [400, 404, 409] },
    );
    routes[upvoted ? "put" : "delete"](
      "/threads/:id/upvote",
      vote.doc,
      credential,
      validator("param", id, refuse),
      async (c) =>
        vote.answer(
          c,
          await threads.setUpvote(as(c), c.req.valid("param").id, upvoted),
        ),
    );
  }

  const accept = documented("Accept a reply as the answer", Thread, {
    errors: [400, 404, 409],
  });
  routes.post(
    "/threads/:id/accept",
    accept.doc,
    credential,
    validator("param", id, refuse),
    validator("json", z.strictObject({ reply_id: guid }), refuse),
    async (c) =>
      accept.answer(
        c,
        await threads.acceptReply(
          as(c),
          c.req.valid("param").id,
          c.req.valid("json").reply_id,
        ),
      ),
  );

  const archive = documented("Archive a thread", Thread, {
    errors: [400, 404, 409],
  });
  routes.post(
    "/threads/:id/archive",
    archive.doc,
    credential,
    validator("param", id, refuse),
    async (c) =>
      archive.answer(
        c,
        await threads.archiveThread(as(c), c.req.valid("param").id),
      ),
  );

  return routes;
}
