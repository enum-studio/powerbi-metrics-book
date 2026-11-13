import { useQuery } from "@tanstack/react-query";
import { CodePanel } from "./code-panel";
import { formatTime } from "../shell/time";
import { useDemo } from "../shell/demo";
import { questionsQuery } from "./queries";

/** The questions section of a metric page. The demo serves no threads, so it draws nothing there and sends no request. */
export function QuestionsSection({ metricId }: { metricId: string }) {
  if (useDemo()) return null;
  return (
    <section
      aria-labelledby="questions-heading"
      className="flex flex-col gap-3"
    >
      <h2
        id="questions-heading"
        className="text-heading font-semibold text-ink"
      >
        Open questions
      </h2>
      <Questions metricId={metricId} />
    </section>
  );
}

/** The metric's open questions, each with its text, who asked and when, and the command that replies to it: there is no thread screen in v1. */
export function Questions({ metricId }: { metricId: string }) {
  const { data, error, isPending } = useQuery(questionsQuery(metricId));
  if (isPending)
    return <p className="text-ui text-ink-3">Loading the questions</p>;
  if (error !== null)
    return (
      <p role="alert" className="text-ui text-ink-2">
        The questions could not be loaded: {error.message}
      </p>
    );
  if (data.length === 0)
    return (
      <p className="text-ui text-ink-2">Nobody has an open question here.</p>
    );
  return (
    <ul className="flex flex-col divide-y divide-line">
      {data.map((question) => (
        <li
          key={question.id}
          className="flex flex-col gap-2 py-6 first:pt-0 last:pb-0"
        >
          <p className="text-ui font-medium text-ink">{question.title}</p>
          <p className="text-ui whitespace-pre-line text-ink-2">
            {question.excerpt}
          </p>
          <p className="text-meta text-ink-3">
            {question.author_name ?? "Someone"} asked on{" "}
            <time dateTime={question.created_at}>
              {formatTime(question.created_at)}
            </time>
            . Status: {question.status}. {question.reply_count}{" "}
            {question.reply_count === 1 ? "reply" : "replies"}.
          </p>
          <CodePanel
            heading="Reply"
            label="the command that replies to this question"
            code={`pbmb questions reply ${question.id} --body "Your answer"`}
          />
        </li>
      ))}
    </ul>
  );
}
