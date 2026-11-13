# Decisions

One file per part of the product (`architecture.md`, `powerbi.md`,
`queries.md`, `access.md`, `security.md`, ...), holding the decisions about
that part that the spec does not already make. A decision is written down
when someone would otherwise have to find it out again: a probe, a measured
limit, a library that behaves differently from its docs, a choice between
two designs that both work.

## How a decision is written

Each decision answers three things, in this order:

1. **The decision**, first and in bold, as one sentence a reader can act
   on: "**Relationships are read with the first connected person's token.**"
2. **Why**: the evidence. What was tried, on which versions, with which
   result, and where the proof lives (a test, a recorded answer, a script
   someone can run again). Numbers, names and dates, not impressions.
3. **When it stops being right**: the version bump, the measurement or the
   change in Power BI, Microsoft identity or a dependency that would make
   it wrong, and the test that would notice. "Holds until the next bump of
   `better-auth`; the refresh-reuse security test checks it on every run."

A decision that is still open says so: "**Open.**", what is not decided,
and what deciding it needs. It is never written as if it were settled.

## The shape of a file

- The title names the part and the subject ("The Power BI client's
  refresh lock"), not "Decision 7".
- Each section opens with its decision in bold, then the reasons, then
  when it stops being right.
- Dates are absolute (2026-10-25), versions exact (`better-auth` 1.7.12).
- Evidence too long for the file sits in a folder named after it
  (`docs/decisions/<part>/`), and the file links it.

## Rules

- A decision changes in the same pull request as the code it describes.
  When it stops being right, the file says what replaced it; it is not
  deleted, so the reason is still there for the next person.
- A decision that moves a trust boundary also changes
  `docs/security/threat_model.md`.
- The spec says what the product does. A decision says why one way was
  chosen where the spec left room, or where building it showed the spec
  was wrong; in the second case the spec is corrected too.
