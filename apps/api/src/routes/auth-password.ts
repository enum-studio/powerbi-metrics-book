import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { INVITE_TOKEN } from "../services/auth/invites.js";

const password = z.string().min(12).max(128);
const bodies = {
  "/api/auth/sign-in/email": z.object({
    email: z.email(),
    password: z.string(),
  }),
  "/api/auth/invites/accept": z.object({
    token: z.string().regex(INVITE_TOKEN),
    password,
  }),
  "/api/auth/email/forgot-password": z.object({ email: z.email() }),
  "/api/auth/reset-password": z.object({
    token: z.string(),
    newPassword: password,
  }),
  "/api/auth/change-password": z.object({
    currentPassword: z.string(),
    newPassword: password,
  }),
};
export const passwordDocumentation = Object.entries(bodies).map(
  ([path, body]) => ({
    path,
    document: describeRoute({
      summary: path.split("/").at(-1),
      security: path.endsWith("change-password")
        ? [{ session_cookie: [] }]
        : [],
      requestBody: {
        required: true,
        content: { "application/json": { schema: resolver(body) } },
      },
      responses: {
        200: {
          description:
            "The password request succeeded; sign-in and invite acceptance set a session cookie.",
        },
        400: { description: "The input or link is invalid." },
        401: { description: "The credential is invalid." },
        403: {
          description: "Password sign-in is off or the person has no role.",
        },
        429: { description: "Too many attempts." },
      },
    }),
  }),
);
