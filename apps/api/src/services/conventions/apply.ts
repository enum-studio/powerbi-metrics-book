import { isDeepStrictEqual } from "node:util";
import type { AppDeps } from "../../context.js";
import { ServiceError } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { failuresInBook } from "../book/whole-book-checks.js";
import { withEvents } from "../events/feed.js";
import { isRuleOff, RULES, valueAt } from "./rules.js";
import { type Conventions, exceptionKey, exceptionReason } from "./schema.js";
import {
  checkSave,
  conventionsInForce,
  isCompanyPart,
  lockConventions,
  resolve,
  saveVersion,
} from "./store.js";

export type ApplyInput = {
  conventions: unknown;
  dry_run: boolean;
  baseline_reason?: string | undefined;
};

const exceptionsTo = (conventions: Conventions, rule: string): string[] =>
  conventions.exceptions
    .filter((item) => item.rule === rule)
    .map((item) => JSON.stringify([exceptionKey(item), item.reason]))
    .sort();

/** The ids of the rules whose value, the values it reads, off state or exceptions differ, sorted. */
export function changedRules(
  before: Conventions,
  after: Conventions,
): string[] {
  return RULES.filter((rule) => {
    const paths = [
      ...(rule.path === null ? [] : [rule.path]),
      ...rule.reads.map((id) => id.split(".")),
    ];
    return (
      paths.some(
        (path) =>
          !isDeepStrictEqual(valueAt(before, path), valueAt(after, path)),
      ) ||
      isRuleOff(rule, before) !== isRuleOff(rule, after) ||
      !isDeepStrictEqual(
        exceptionsTo(before, rule.id),
        exceptionsTo(after, rule.id),
      )
    );
  })
    .map((rule) => rule.id)
    .sort();
}

/**
 * Applies a company part: what it changes against the version in force, how
 * many metrics and terms then fail each changed rule, and, unless it is a dry
 * run, the save. A baseline reason first writes one exception for each of
 * those failures, so what exists is listed once and every new name is held to
 * the rule. It saves even when names now fail: the checks are the gate.
 */
export async function applyConventions(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  { conventions: document, dry_run, baseline_reason }: ApplyInput,
) {
  const proposed = resolve(document);
  if (!isCompanyPart(document))
    throw new ServiceError(
      "invalid",
      "Apply takes the company's part: format: 1 and the keys the company sets.",
    );
  const reason =
    baseline_reason === undefined
      ? undefined
      : exceptionReason.safeParse(baseline_reason);
  if (reason?.success === false)
    throw new ServiceError(
      "invalid",
      "A baseline reason is one line of 1 to 200 characters.",
    );
  return withEvents(deps.db, async (tx, emit) => {
    const current = dry_run
      ? await conventionsInForce(tx)
      : await lockConventions(tx);
    // Refused before the whole book is read, when it would be refused anyway.
    checkSave(principal, current, document);
    const changed = changedRules(current.conventions, proposed);
    const failures = await failuresInBook(
      { db: tx },
      proposed,
      new Set(changed),
    );
    const now_failing = Object.fromEntries(changed.map((id) => [id, 0]));
    for (const { rule } of failures)
      now_failing[rule] = (now_failing[rule] ?? 0) + 1;
    const added =
      reason?.data === undefined
        ? []
        : failures.map(({ rule, target }) => ({
            rule,
            ...target,
            reason: reason.data,
          }));
    const saved =
      added.length === 0
        ? document
        : { ...document, exceptions: [...proposed.exceptions, ...added] };
    const answer = {
      changed_rules: changed,
      now_failing,
      exceptions_added: added.length,
    };
    if (dry_run) {
      checkSave(principal, current, saved);
      return { ...answer, version: null };
    }
    const { version } = await saveVersion(tx, emit, principal, current, saved);
    return { ...answer, version };
  });
}
