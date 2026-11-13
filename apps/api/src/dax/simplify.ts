import { type SourceToken, isColumnShape } from "./tokens.js";

/*
 * Rewrites of one measure's own DAX that cannot change its result, so two
 * spellings of one calculation give one text. A VAR is evaluated once, where
 * it is defined, so it is written out only where the context is still that
 * one. Anything else stays as written: a missed merge, never a wrong one. It
 * reads one measure, so a random value behind a measure reference goes unseen:
 * `VAR r = [Random] RETURN r - r` and `[Random] - [Random]` give one text.
 */

// Tenants' DAX is untrusted, and the work below grows with the variables times
// the tokens. Past either an expression stays as written, as it does when
// writing its variables out would take it past the first.
const MAX_TOKENS = 20_000;
const MAX_VARIABLES = 100;

/** Calls that evaluate their arguments in the context they were called in. */
const SAME_CONTEXT = new Set([
  "DIVIDE",
  "IF",
  "COALESCE",
  "SWITCH",
  "ABS",
  "ROUND",
  "ISBLANK",
  "AND",
  "OR",
  "NOT",
]);
/** What DAX reads as an option in a call that takes one: a variable of such a name cannot be told from the word. */
const OPTION_WORDS = new Set([
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "hour",
  "minute",
  "second",
  "dense",
  "skip",
  "both",
  "none",
  "oneway",
  "twoway",
  "integer",
  "double",
  "string",
  "boolean",
  "currency",
  "datetime",
]);
/** A new value on each evaluation: read twice from a VAR it is one value, written out it is two. */
const UNREPEATABLE = new Set(["RAND", "RANDBETWEEN", "NOW", "UTCNOW"]);

const synthetic = (kind: SourceToken["kind"], text: string): SourceToken => ({
  kind,
  text,
  source: text,
  name: text,
});
const OPEN = synthetic("open", "(");
const CLOSE = synthetic("close", ")");
const VAR = synthetic("keyword", "VAR");
const RETURN = synthetic("keyword", "RETURN");
const EQUALS = synthetic("operator", "=");

type Binding = { name: string; value: SourceToken[] };
type Block = { bindings: Binding[]; result: SourceToken[] };

const isVarOrReturn = (token: SourceToken | undefined) =>
  token?.text === "VAR" || token?.text === "RETURN";

/** One operand: a reference, a literal, or a single call or bracket ending at `out`'s end, which `lastOpen` opens. */
function isOperand(
  out: SourceToken[],
  open: number,
  lastOpen: number,
): boolean {
  const inner = out.length - open - 1;
  const first = out[open + 1];
  if (inner === 1)
    return (
      first !== undefined &&
      first.kind !== "keyword" &&
      first.kind !== "operator"
    );
  if (inner === 2 && first?.kind === "table")
    return out[open + 2]?.kind === "column";
  return (
    out.at(-1)?.kind === "close" &&
    (lastOpen === open + 1 ||
      (lastOpen === open + 2 && first?.kind === "function"))
  );
}

/** Whether nothing around the bracket at `open`, up to `after`, can bind to what is inside. */
function isOnItsOwn(
  out: SourceToken[],
  open: number,
  after: SourceToken | undefined,
): boolean {
  const before = out[open - 1];
  const startsAlone =
    before === undefined ||
    before.kind === "comma" ||
    before.text === "(" ||
    before.text === "RETURN" ||
    // A comparison's right side would bind differently: only a VAR's own equals.
    (before.text === "=" && out[open - 3]?.text === "VAR");
  const endsAlone =
    after === undefined ||
    after.kind === "comma" ||
    after.text === ")" ||
    isVarOrReturn(after);
  return startsAlone && endsAlone;
}

/** Drops brackets that bind nothing, innermost first, in one pass: deep nesting costs no stack. */
function withoutExtraBrackets(tokens: readonly SourceToken[]): SourceToken[] {
  const out: SourceToken[] = [];
  const opens: { at: number; holdsComma: boolean }[] = [];
  let lastOpen = -1;
  for (const [at, token] of tokens.entries()) {
    if (token.kind === "open") {
      opens.push({ at: out.length, holdsComma: false });
    } else if (token.kind === "comma") {
      const inner = opens.at(-1);
      if (inner !== undefined) inner.holdsComma = true;
    } else if (token.kind === "close") {
      const bracket = opens.pop();
      if (bracket !== undefined) {
        const { at: open, holdsComma } = bracket;
        const plain =
          out[open]?.text === "(" &&
          out[open - 1]?.kind !== "function" &&
          out.length > open + 1 &&
          !holdsComma;
        if (
          plain &&
          (isOperand(out, open, lastOpen) ||
            isOnItsOwn(out, open, tokens[at + 1]))
        ) {
          out.splice(open, 1);
          lastOpen -= 1;
          continue;
        }
        lastOpen = open;
      }
    }
    out.push(token);
  }
  return out;
}

/** The VAR block that is the whole expression, or null when it is not one. */
function varBlock(tokens: readonly SourceToken[]): Block | null {
  const bindings: Binding[] = [];
  let at = 0;
  while (tokens[at]?.text === "VAR") {
    const name = tokens[at + 1];
    if (name?.kind !== "identifier" || tokens[at + 2]?.text !== "=")
      return null;
    let end = at + 3;
    let depth = 0;
    while (end < tokens.length && (depth > 0 || !isVarOrReturn(tokens[end]))) {
      const kind = tokens[end]?.kind;
      if (kind === "open") depth += 1;
      if (kind === "close") depth -= 1;
      end += 1;
    }
    const value = tokens.slice(at + 3, end);
    if (value.length === 0) return null;
    bindings.push({ name: name.text, value });
    at = end;
  }
  if (bindings.length === 0 || tokens[at]?.text !== "RETURN") return null;
  // Not valid DAX, and each of its variables would read all of the others' reads.
  if (new Set(bindings.map((b) => b.name)).size < bindings.length) return null;
  const result = tokens.slice(at + 1);
  return result.length === 0 ? null : { bindings, result };
}

/** `MIN(column)` or `MAX(column)`: an aggregation with no context transition. */
function isColumnBound(value: readonly SourceToken[]): boolean {
  const head = value[0]?.text;
  return (
    // First, as this runs for each read: `MIN('T'[c])` is five tokens.
    value.length <= 5 &&
    (head === "MIN" || head === "MAX") &&
    value[1]?.kind === "open" &&
    value.at(-1)?.kind === "close" &&
    isColumnShape(value.slice(2, -1))
  );
}

type Frame = { call: string | null; argument: number };

/** Whether a read inside these calls is evaluated in the context its VAR is. */
function keepsContext(frames: readonly Frame[], value: readonly SourceToken[]) {
  for (let k = 0; k < frames.length; k += 1) {
    const frame = frames[k];
    if (
      frame === undefined ||
      frame.call === null ||
      SAME_CONTEXT.has(frame.call)
    )
      continue;
    // CALCULATE evaluates a filter argument outside itself. DATESBETWEEN may
    // iterate its dates, so only a bound with no context transition reads the same.
    const inner = frames[k + 1];
    if (
      frame.call === "CALCULATE" &&
      frame.argument > 0 &&
      inner?.call === "DATESBETWEEN" &&
      inner.argument > 0 &&
      isColumnBound(value)
    ) {
      k += 1;
      continue;
    }
    return false;
  }
  return true;
}

/** How many reads of the binding `later` holds, when every one may become its value; null when one may not. */
function readsToSubstitute(
  later: readonly SourceToken[],
  binding: Binding,
): number | null {
  const { name, value } = binding;
  if (value.some((t) => t.text === "VAR")) return null;
  const frames: Frame[] = [];
  let reads = 0;
  for (const [at, token] of later.entries()) {
    // Another block may hold a variable of this name.
    if (token.text === "VAR") return null;
    if (token.kind === "open") {
      const caller = later[at - 1];
      frames.push({
        call: caller?.kind === "function" ? caller.text : null,
        argument: 0,
      });
    } else if (token.kind === "close") {
      frames.pop();
    } else if (token.kind === "comma") {
      const frame = frames.at(-1);
      if (frame !== undefined) frame.argument += 1;
    } else if (token.text === name) {
      if (token.kind === "table") return null;
      if (token.kind === "identifier") {
        if (!keepsContext(frames, value)) return null;
        reads += 1;
      }
    }
  }
  return reads > 1 && value.some((t) => UNREPEATABLE.has(t.text))
    ? null
    : reads;
}

function substitute(
  tokens: readonly SourceToken[],
  name: string,
  value: readonly SourceToken[],
): SourceToken[] {
  return tokens.flatMap((token) =>
    token.kind === "identifier" && token.text === name
      ? [OPEN, ...value, CLOSE]
      : [token],
  );
}

/** The block with its variables named by their order; as it is when a name there may mean something else. */
function written({ bindings, result }: Block): SourceToken[] {
  const nested = [...bindings.flatMap((b) => b.value), ...result];
  const named = new Map(
    bindings.map((binding, n) => [binding.name, `__v${String(n + 1)}`]),
  );
  const open =
    nested.some((t) => t.text === "VAR") ||
    bindings.some((b) => OPTION_WORDS.has(b.name));
  const rename = (tokens: readonly SourceToken[]) =>
    open
      ? tokens
      : tokens.map((token) => {
          const text = named.get(token.text);
          return text !== undefined &&
            (token.kind === "identifier" || token.kind === "table")
            ? { ...token, text }
            : token;
        });
  return [
    ...bindings.flatMap((binding) => [
      VAR,
      synthetic(
        "identifier",
        open ? binding.name : (named.get(binding.name) ?? binding.name),
      ),
      EQUALS,
      ...rename(binding.value),
    ]),
    ...(bindings.length > 0 ? [RETURN] : []),
    ...rename(result),
  ];
}

/** The measure's own tokens in one spelling. Its measure references stay references. */
export function simplify(tokens: readonly SourceToken[]): SourceToken[] {
  if (tokens.length > MAX_TOKENS) return [...tokens];
  const plain = withoutExtraBrackets(tokens);
  const block = varBlock(plain);
  if (block === null || block.bindings.length > MAX_VARIABLES) return plain;
  let { bindings, result } = block;
  let size = plain.length;
  // The last first: only those after a variable can read it.
  for (let k = bindings.length - 1; k >= 0; k -= 1) {
    const binding = bindings[k];
    if (binding === undefined) continue;
    const after = bindings.slice(k + 1);
    const later = [...after.flatMap((b) => b.value), ...result];
    const reads = readsToSubstitute(later, binding);
    if (reads === null) continue;
    const { name, value } = binding;
    size += reads * (value.length + 1);
    if (size > MAX_TOKENS) return plain;
    bindings = [
      ...bindings.slice(0, k),
      ...after.map((b) => ({ ...b, value: substitute(b.value, name, value) })),
    ];
    result = substitute(result, name, value);
  }
  return withoutExtraBrackets(written({ bindings, result }));
}
