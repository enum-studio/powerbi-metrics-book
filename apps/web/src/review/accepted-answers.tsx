export type AcceptedAnswer = {
  thread_id: string;
  question: string | null;
  answer: string;
  accepted_by_role:
    "asker" | "asker_own_reply" | "curator" | "other" | "unknown" | null;
  accepted_by_kind: "person" | "service_account" | null;
  accepted_by_via: "browser" | "mcp" | "api" | "cli" | null;
};

const WHO = {
  asker: "Accepted by the asker",
  asker_own_reply: "The asker accepted their own reply",
  curator: "Accepted by a curator",
  other: "Accepted by someone else",
  unknown: "Acceptor unknown",
};

/** Who accepted an answer, in one phrase; an agent is one on a service account or on a person's token through the connector. */
export function acceptedBy(answer: AcceptedAnswer): string {
  const text = WHO[answer.accepted_by_role ?? "unknown"];
  const agent =
    answer.accepted_by_kind === "service_account" ||
    answer.accepted_by_via === "mcp";
  return agent ? `${text}, an agent` : text;
}

/** The questions answered on an element, each with its accepted answer and who accepted it. Nothing when there are none. */
export function AcceptedAnswers({ answers }: { answers: AcceptedAnswer[] }) {
  if (answers.length === 0) return null;
  return (
    <section
      aria-labelledby="accepted-answers-heading"
      className="flex flex-col gap-3"
    >
      <h2
        id="accepted-answers-heading"
        className="text-heading font-semibold text-ink"
      >
        Answered questions
      </h2>
      <ul className="flex flex-col divide-y divide-line">
        {answers.map((answer) => (
          <li
            key={answer.thread_id}
            className="flex flex-col gap-2 py-6 first:pt-0 last:pb-0"
          >
            <p className="text-ui font-medium break-words text-ink">
              {answer.question}
            </p>
            <p className="text-ui break-words whitespace-pre-line text-ink-2">
              {answer.answer}
            </p>
            <p className="text-meta text-ink-3">{acceptedBy(answer)}.</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
