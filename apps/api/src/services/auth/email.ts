import { z } from "zod";
import type { AppDeps } from "../../context.js";
import { ServiceError } from "../../errors.js";
import { brandOf } from "../admin/branding.js";

export async function requireEmail(deps: AppDeps) {
  const key = await deps.secrets.read("resend_api_key");
  if (key === null)
    throw new ServiceError(
      "invalid",
      "Set resend_api_key before sending email or enabling password sign-in.",
    );
  const from = await deps.settings.get("email.from");
  if (from === null)
    throw new ServiceError(
      "invalid",
      "Set email.from before sending email or enabling password sign-in.",
    );
  return { key, from };
}

/**
 * Whether requireEmail would let an email go out: a Resend key from the
 * database or the environment, and a sender. Its refusal is the answer
 * false; any other failure is thrown.
 */
export async function emailReady(deps: AppDeps) {
  try {
    await requireEmail(deps);
    return true;
  } catch (error) {
    if (error instanceof ServiceError) return false;
    throw error;
  }
}

export async function sendEmail(
  deps: AppDeps,
  to: string,
  subject: string,
  text: string,
  html: string,
) {
  const { key, from } = await requireEmail(deps);
  const base = await deps.settings.get("email.base_url");
  const response = await deps.fetcher.fetchFixed(
    new URL(`${base.replace(/\/$/, "")}/emails`),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text, html }),
    },
  );
  if (!response.ok)
    throw new ServiceError(
      "upstream",
      "Resend refused the email; check the sender and key.",
    );
  z.object({ id: z.string() }).parse(await response.json());
}

const escaped = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** The brand's name, and its logo as HTML when one is set. */
async function brandHtml(deps: AppDeps) {
  const brand = await brandOf(deps);
  const logo =
    brand.logo_url === null
      ? ""
      : `<img src="${escaped(brand.logo_url)}" alt="${escaped(brand.name)}">`;
  return { name: brand.name, logo };
}

export async function sendPasswordLink(
  deps: AppDeps,
  email: string,
  token: string,
) {
  const link = new URL("/set-password", deps.config.public_base_url);
  link.searchParams.set("kind", "reset");
  link.hash = new URLSearchParams({ token }).toString();
  const brand = await brandHtml(deps);
  const subject = "Reset your password";
  const message = `Reset your password for ${brand.name}. This link works for 1 hour.`;
  await sendEmail(
    deps,
    email,
    subject,
    `${message}\n${link.href}`,
    `${brand.logo}<p>${escaped(message)}</p><a href="${escaped(link.href)}">${subject}</a>`,
  );
}

/** The invite, its link on the plain text's last line. */
export async function sendInviteEmail(
  deps: AppDeps,
  invite: {
    to: string;
    inviter_name: string;
    role_label: string;
    link: string;
    expires_at: Date;
  },
) {
  const brand = await brandHtml(deps);
  const { inviter_name: inviter, role_label: role } = invite;
  const article = /^[aeiou]/i.test(role) ? "an" : "a";
  const date = invite.expires_at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const intro = `${inviter} invited you to ${brand.name} as ${article} ${role}. ${brand.name} lets your AI agent look up what your Power BI numbers mean and query them with your own Power BI rights.`;
  const expiry = `This invite expires on ${date}.`;
  const ignore = "If you did not expect it, you can ignore this email.";
  await sendEmail(
    deps,
    invite.to,
    `${inviter} invited you to ${brand.name}`,
    `${intro}\n\n${expiry}\n${ignore}\n\nAccept invite:\n${invite.link}`,
    `${brand.logo}<p>${escaped(intro)}</p><p><a href="${escaped(invite.link)}">Accept invite</a></p><p>${escaped(expiry)}</p><p>${escaped(ignore)}</p>`,
  );
}
