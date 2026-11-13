// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AcceptedAnswers, type AcceptedAnswer } from "./accepted-answers";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const answer = (
  id: string,
  rest: Partial<AcceptedAnswer> = {},
): AcceptedAnswer => ({
  thread_id: id,
  question: `Question ${id}?`,
  answer: `Answer ${id}`,
  accepted_by_role: "asker",
  accepted_by_kind: "person",
  accepted_by_via: "browser",
  ...rest,
});

function mount(answers: AcceptedAnswer[]) {
  const host = document.createElement("div");
  act(() => {
    createRoot(host).render(<AcceptedAnswers answers={answers} />);
  });
  return [...host.querySelectorAll("li")].map(
    (li) => li.querySelector(".text-ink-3")?.textContent,
  );
}

it("says who accepted each answer, and when an agent did", () => {
  expect(
    mount([
      answer("1"),
      answer("2", { accepted_by_role: "asker_own_reply" }),
      answer("3", {
        accepted_by_role: "curator",
        accepted_by_kind: "service_account",
      }),
      answer("4", { accepted_by_via: "mcp" }),
      answer("5", { accepted_by_role: "other" }),
      answer("6", {
        accepted_by_role: "unknown",
        accepted_by_kind: null,
        accepted_by_via: null,
      }),
    ]),
  ).toEqual([
    "Accepted by the asker.",
    "The asker accepted their own reply.",
    "Accepted by a curator, an agent.",
    "Accepted by the asker, an agent.",
    "Accepted by someone else.",
    "Acceptor unknown.",
  ]);
});

it("shows nothing when no question is answered", () => {
  expect(mount([])).toEqual([]);
});
