# The first run, and what comes after it

## The last two screens record nothing

**Who gets in and Connect your agent use the first sync's wait, and neither
holds up the setup: `setup.completed_at` still comes from the five API steps
(`FIRST_RUN` in `apps/api/src/services/setup/steps.ts`).**

Why: the first sync took about 5 minutes on a real tenant (2026-11-04), and
the old done screen put its progress, the agent's values, the invitation and
the optional settings on one page with no single next action. Each screen now
has one job. The role is a setting and an agent is a grant, so both already say
whether they happened: the rail reads the grants to say **Skipped**, and a new
column would only repeat them. `currentScreen` skips both, so a person who left
comes back to the sync's own state and not to a question they passed by.
`capScreen` keeps them shut until a sync has started, which the setup state
answers from what is true now: no check for a sync nobody started, though the
daily job stores that as a failure, and the result of a sync that ended with
nobody watching, which nothing stored. A person who comes back to that one goes
to Done, whose look records it.

When it stops being right: if the first run must not finish until something
on these screens is done, such as a tenant that may not default to any role.
That step then belongs in `FIRST_RUN`. `apps/web/src/setup/screens.test.ts`
holds the order.

## `/` is What to do next, worked out from real state

**A signed-in person lands on a list of next steps at `/`, every line of it
derived from what the api already answers, with nothing stored about having
seen or finished it.**

Why: the catalog was the landing page, and it says nothing about connecting an
agent, which is how this product is used. A colleague who signs in on the first
day needs the same steps as the admin, without the admin's. The list reads
`me`, the person's grants and `GET /api/v1/book/summary`, and for an admin the
people list, the default role and `GET /api/v1/admin/status`. So a step is done
when it is true, for example when a second person exists, and comes back if it
stops being true. Ask your agent never ticks, since the api cannot tell whether
a person asked anything.

When it stops being right: if people ask to dismiss a line that stays open,
which would need a stored preference per person. `apps/web/src/home/home.test.tsx`
holds which role sees what.

## The prompts on What to do next name no metric

**The Copy prompts are fixed words, and `GET /api/v1/book/summary` answers
counts only, never a label.**

Why: a measure's name is Power BI's text, and a curator can set a label. In a
prompt a person pastes, that text arrives as the person's own instruction, with
their authority and whatever their agent holds, where the connector would have
framed it as data (`docs/security/agents.md`, rule 5). The security review of
2026-11-04 found that a measure named as an instruction could reach an admin's
agent this way. Fixed words lose nothing: the agent finds the metric through
the connector.

When it stops being right: if labels get a strict format enforced at every way
in, which would also need `docs/security/threat_model.md` B11 to say so.
`apps/api/src/services/book/summary_security_test.ts` holds what the counts may
include.

## Status reads the security checklist fresh, and an agent yet to connect is no failure

**`adminStatus` lists the checklist's failing items as it stands now, one line
each, and lists neither the stored `security` check nor `agents`.**

Why: the stored `security` line said only how many items fail, and it linked to
the status page, which did not list them. It also stayed until the daily job
ran, so an admin who entered an expiry date still read the warning. The items
are a few reads of the database and one `stat`, so a GET can afford them, and
no audit row is written for looking. A read-only caller reads the one name
`security` for all of them, because an item's name describes a weakness. The
`agents` check fails until an admin's
agent has called `whoami`, which is a next step and not a fault, and it put a
red band on every admin page of a healthy stack. It is still a check an admin
can run.

When it stops being right: if an item needs an outbound call, because the
status page must stay a cheap read. `apps/api/src/services/admin/secret-expiry.test.ts`
holds both.

## A failing check with no admin page links to the guide

**`FixLink` sends a failing check to the admin page that owns its name, and any other to the Security
section of "When a check fails".** `https` and `identity_volume_private` are fixed at the proxy and on a
volume, so no admin page can change them, and their lines had no link. `check-setup-sentences.mjs` fails
when the guide stops quoting a sentence, but it checks neither the `#security` anchor nor which section holds
the quote, so renaming or moving that section would break the link with no failure. `failing.test.tsx` holds
the link. Stops being right if a check outside the checklist fails with no
page, since `#security` would be the wrong section; every step's check has a page today.

## The security checklist has no screen of its own

**A person reads the failing items on What to do next and Admin > Status, and the full list from
`pbmb admin check security --json`.** Security left the first run, so the **Check the security checklist**
button in `guide.ts` shows nowhere, and the set-up page's "open Security" named a navigation item that does
not exist. Stops being right if an admin wants the passing items on a page, which is a screen to add and a
sentence to change in `set-up/security.md`.

## The CLI sends only a name the api knows

**`pbmb admin secrets set` and `expiry` refuse anything but a name `readersOf` accepts, and `SECRET_NAME`
repeats those names.** The name goes into the URL, so a value typed in its place would reach the request line
and the logs. Lower case letters, digits and underscores let through a value from `openssl rand -hex`, which
is how a review of this code found the gap on 2026-11-05. Asking `GET /admin/secrets` first would keep one
list, but it costs a request and lists a sign-in secret only once its provider is saved, so it is stricter
than the api. The cost of repeating them: an older CLI refuses a secret added after it, until it is upgraded.
`requests_security_test.py` holds the fixed names equal to `readers.ts`. Stops being right if secrets stop
being a short fixed list.
