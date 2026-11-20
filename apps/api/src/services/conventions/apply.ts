import { isDeepStrictEqual } from "node:util";
import type { ServiceContext } from "../../context.js";
import { ServiceError } from "../../errors.js";
import { type Failure, failuresInBook } from "../book/whole-book-checks.js";
import { withEvents } from "../events/feed.js";
import { isRuleOff, RULES, valueAt } from "./rules.js";
import { visibleExceptions } from "./service.js";
import {
  type Conventions,
  type ConventionsException,
  exceptionKey,
  exceptionReason,
} from "./schema.js";
import {
  checkSave,
  conventionsInForce,
  isCompanyPart,
  lockConventions,
  saveVersion,
} from "./store.js";

export type ApplyInput = {
  conventions: unknown;
  dry_run: boolean;
  baseline_reason?: string | undefined;
};

/** Each exception as its key and reason, sorted, so the order a file lists them in is no change. */
const exceptionLines = (exceptions: readonly ConventionsException[]) =>
  exceptions
    .map((item) => JSON.stringify([exceptionKey(item), item.reason]))
    .sort();

const exceptionsTo = (conventions: Conventions, rule: string): string[] =>
  exceptionLines(conventions.exceptions.filter((item) => item.rule === rule));

/** Plain character order of the keys, the order any other tool sorts the same strings in. */
const byKey = (
  a: Parameters<typeof exceptionKey>[0],
  b: Parameters<typeof exceptionKey>[0],
) => {
  const [first, second] = [exceptionKey(a), exceptionKey(b)];
  return Number(first > second) - Number(first < second);
};

/** Whether a rule's value, a value it reads or its off state differ: what decides which elements pass it. */
function ruleDiffers(
  rule: (typeof RULES)[number],
  before: Conventions,
  after: Conventions,
): boolean {
  const paths = [
    ...(rule.path === null ? [] : [rule.path]),
    ...rule.reads.map((id) => id.split(".")),
  ];
  return (
    paths.some(
      (path) => !isDeepStrictEqual(valueAt(before, path), valueAt(after, path)),
    ) || isRuleOff(rule, before) !== isRuleOff(rule, after)
  );
}

/** The ids of the rules whose value, the values it reads, off state or exceptions differ, sorted. */
export function changedRules(
  before: Conventions,
  after: Conventions,
): string[] {
  return RULES.filter(
    (rule) =>
      ruleDiffers(rule, before, after) ||
      !isDeepStrictEqual(
        exceptionsTo(before, rule.id),
        exceptionsTo(after, rule.id),
      ),
  )
    .map((rule) => rule.id)
    .sort();
}

/**
 * A baseline's exceptions, sorted: one for each target that fails a rule whose
 * value, read values or off state the part changes, and passed that rule
 * under the version in force, where a rule that is off passes. A failure the
 * change did not cause keeps failing, so a part that only adds an exception
 * excepts nothing more. The failures are the whole book's, and only those on
 * targets the caller may see are excepted: one it cannot see is never named
 * to it, and keeps failing.
 */
async function baselineExceptions(
  context: ServiceContext,
  before: Conventions,
  after: Conventions,
  failures: readonly Failure[],
  reason: string,
) {
  const rules = new Set(
    RULES.filter((rule) => ruleDiffers(rule, before, after)).map(
      ({ id }) => id,
    ),
  );
  if (rules.size === 0) return [];
  const key = ({ rule, target }: Failure) => exceptionKey({ rule, ...target });
  const failedBefore = new Set(
    (await failuresInBook(context, before, rules)).map(key),
  );
  const caused = failures
    .filter(
      (failure) => rules.has(failure.rule) && !failedBefore.has(key(failure)),
    )
    .map(({ rule, target }) => ({ rule, ...target, reason }));
  return (await visibleExceptions(context, caused)).sort(byKey);
}

/**
 * Applies a company part: what it changes against the version in force, how
 * many metrics and terms then fail each changed rule, and, unless it is a dry
 * run, the save. A baseline reason first adds one exception for each failure
 * the change causes (baselineExceptions), so what exists is listed once and
 * every new name is held to the rule; the answer lists them, sorted, for the
 * file to hold. It saves even when names now fail: the checks are the gate.
 * A part equal to the one in force saves nothing, so applying a file again
 * is free.
 */
export async function applyConventions(
  context: ServiceContext,
  { conventions: document, dry_run, baseline_reason }: ApplyInput,
) {
  const { principal } = context;
  const reason =
    baseline_reason === undefined
      ? undefined
      : exceptionReason.safeParse(baseline_reason);
  if (reason?.success === false)
    throw new ServiceError(
      "invalid",
      "A baseline reason is one line of 1 to 200 characters.",
    );
  return withEvents(context.db, async (tx, emit) => {
    const current = dry_run
      ? await conventionsInForce(tx)
      : await lockConventions(tx);
    // Refused before the book is read; a fixed rule before the part's shape.
    const given = checkSave(principal, current, document);
    if (!isCompanyPart(document))
      throw new ServiceError(
        "invalid",
        "Apply takes the company's part: format: 1 and the keys the company sets.",
      );
    const { proposed } = given;
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
        : await baselineExceptions(
            { ...context, db: tx },
            current.conventions,
            proposed,
            failures,
            reason.data,
          );
    const save =
      added.length === 0
        ? given
        : checkSave(principal, current, {
            ...document,
            exceptions: [...proposed.exceptions, ...added],
          });
    // Equal once the baseline is added, as when a file without it is applied again, in whatever order the file lists its exceptions.
    const unchanged =
      isDeepStrictEqual(
        { ...save.part, exceptions: null },
        { ...current.company, exceptions: null },
      ) &&
      isDeepStrictEqual(
        exceptionLines(save.proposed.exceptions),
        exceptionLines(current.conventions.exceptions),
      );
    const answer = {
      changed_rules: unchanged ? [] : changed,
      now_failing: unchanged ? {} : now_failing,
      exceptions_added: added,
    };
    if (dry_run) return { ...answer, version: null };
    if (unchanged) return { ...answer, version: current.version };
    const { version } = await saveVersion(tx, emit, save);
    return { ...answer, version };
  });
}
