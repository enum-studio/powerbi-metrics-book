import { Hono } from "hono";
import { readJsonObject } from "./entra/context.js";

export type Outbox = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}[];
export function resendRoutes(outbox: Outbox) {
  return new Hono().post("/emails", async (c) => {
    if (!/^Bearer \S+$/i.test(c.req.header("authorization") ?? ""))
      return c.json(
        { name: "validation_error", message: "Missing bearer key." },
        401,
      );
    const email = await readJsonObject(c);
    if (
      !email ||
      Object.keys(email).sort().join(",") !== "from,html,subject,text,to" ||
      typeof email.from !== "string" ||
      typeof email.to !== "string" ||
      typeof email.subject !== "string" ||
      typeof email.text !== "string" ||
      typeof email.html !== "string"
    )
      return c.json(
        { name: "validation_error", message: "Invalid email." },
        422,
      );
    outbox.push({
      from: email.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    return c.json({ id: crypto.randomUUID() });
  });
}
