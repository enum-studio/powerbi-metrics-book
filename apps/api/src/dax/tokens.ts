export type DaxTokenKind =
  | "keyword"
  | "function"
  | "table"
  | "column"
  | "identifier"
  | "string"
  | "number"
  | "operator"
  | "open"
  | "close"
  | "comma";

/** One token of a DAX expression; `text` is already normalised. */
export type DaxToken = { kind: DaxTokenKind; text: string };

export class DaxSyntaxError extends Error {
  override readonly name = "DaxSyntaxError";
}

/**
 * A token with what normalising drops: `source` is the text as written, and
 * `name` is a table or column name unquoted and unescaped (for other tokens,
 * the text as written).
 */
export type SourceToken = DaxToken & { source: string; name: string };

// Never functions, even before a parenthesis (`RETURN (x)`).
const KEYWORDS = new Set([
  "VAR",
  "RETURN",
  "DEFINE",
  "EVALUATE",
  "MEASURE",
  "COLUMN",
  "TABLE",
  "FUNCTION",
  "ORDER",
  "BY",
  "ASC",
  "DESC",
  "START",
  "AT",
  "IN",
]);
// Keywords alone, functions before a parenthesis: `NOT x` and `NOT(x)`.
const KEYWORD_OR_FUNCTION = new Set(["NOT", "AND", "OR", "TRUE", "FALSE"]);
const TWO_CHAR_OPERATORS = new Set(["&&", "||", "<=", ">=", "<>", "=="]);
const ONE_CHAR_OPERATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "^",
  "&",
  "=",
  "<",
  ">",
]);
// A literal beyond a double's range is not something a measure can hold.
const MAX_EXPONENT_DIGITS = 4;
// Past this many places, a number is written as `0.<digits>e<point>` rather than padded with zeros.
const MAX_PLAIN_PLACES = 40;

const isWordStart = (c: string): boolean => /^[\p{L}_]$/u.test(c);
const isWordPart = (c: string): boolean => /^[\p{L}\p{N}_.]$/u.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/** Splits DAX into tokens, keeping each token's source text beside its normalised text. */
export function lex(dax: string): SourceToken[] {
  const chars = Array.from(dax);
  const at = (k: number): string => chars[k] ?? "";
  const slice = (from: number, to: number): string =>
    chars.slice(from, to).join("");
  const tokens: SourceToken[] = [];
  const push = (
    kind: DaxTokenKind,
    text: string,
    source: string,
    name = source,
  ): void => {
    tokens.push({ kind, text, source, name });
  };

  // Index of the quote closing the one at `from`; a doubled quote is an escaped one.
  const closing = (from: number, quote: string, what: string): number => {
    for (let k = from + 1; k < chars.length; k++) {
      if (at(k) !== quote) continue;
      if (at(k + 1) !== quote) return k;
      k++;
    }
    throw new DaxSyntaxError(
      `Unterminated ${what} starting at position ${String(from)}`,
    );
  };

  let i = 0;
  while (i < chars.length) {
    const c = at(i);
    const next = at(i + 1);
    if (/^\s$/u.test(c)) {
      i++;
    } else if ((c === "/" && next === "/") || (c === "-" && next === "-")) {
      while (i < chars.length && at(i) !== "\n" && at(i) !== "\r") i++;
    } else if (c === "/" && next === "*") {
      let end = i + 2;
      while (end < chars.length && !(at(end) === "*" && at(end + 1) === "/"))
        end++;
      if (end >= chars.length)
        throw new DaxSyntaxError(
          `Unterminated comment starting at position ${String(i)}`,
        );
      i = end + 2;
    } else if (c === '"') {
      const end = closing(i, '"', "string");
      const source = slice(i, end + 1);
      push("string", source, source);
      i = end + 1;
    } else if (c === "'") {
      const end = closing(i, "'", "quoted table name");
      const name = slice(i + 1, end).replaceAll("''", "'");
      push("table", tableText(name), slice(i, end + 1), name);
      i = end + 1;
    } else if (c === "[") {
      const end = closing(i, "]", "bracketed name");
      const name = slice(i + 1, end).replaceAll("]]", "]");
      push(
        "column",
        `[${name.toLowerCase().replaceAll("]", "]]")}]`,
        slice(i, end + 1),
        name,
      );
      i = end + 1;
    } else if (isDigit(c) || (c === "." && isDigit(next))) {
      let end = i;
      while (isDigit(at(end))) end++;
      const whole = slice(i, end);
      let fraction = "";
      if (at(end) === ".") {
        const from = ++end;
        while (isDigit(at(end))) end++;
        fraction = slice(from, end);
      }
      let exponent = "";
      const sign = at(end + 1) === "+" || at(end + 1) === "-" ? 1 : 0;
      if ((at(end) === "e" || at(end) === "E") && isDigit(at(end + 1 + sign))) {
        const from = end + 1;
        end = from + sign;
        while (isDigit(at(end))) end++;
        exponent = slice(from, end);
        if (exponent.length - sign > MAX_EXPONENT_DIGITS) {
          throw new DaxSyntaxError(
            `Number out of range at position ${String(i)}`,
          );
        }
      }
      push("number", numberText(whole, fraction, exponent), slice(i, end));
      i = end;
    } else if (isWordStart(c)) {
      let end = i + 1;
      while (isWordPart(at(end))) end++;
      // Classified once the token after it is known.
      push("identifier", "", slice(i, end));
      i = end;
    } else if (TWO_CHAR_OPERATORS.has(c + next)) {
      push("operator", c + next, c + next);
      i += 2;
    } else if (ONE_CHAR_OPERATORS.has(c)) {
      push("operator", c, c);
      i++;
    } else if (c === "(" || c === "{") {
      push("open", c, c);
      i++;
    } else if (c === ")" || c === "}") {
      push("close", c, c);
      i++;
    } else if (c === ",") {
      push("comma", c, c);
      i++;
    } else {
      throw new DaxSyntaxError(
        `Unexpected character "${c}" at position ${String(i)}`,
      );
    }
  }
  return tokens.map((token, k) =>
    token.kind === "identifier" ? classifyWord(token, tokens[k + 1]) : token,
  );
}

function classifyWord(
  word: SourceToken,
  following: SourceToken | undefined,
): SourceToken {
  const upper = word.source.toUpperCase();
  if (KEYWORDS.has(upper)) return { ...word, kind: "keyword", text: upper };
  if (following?.text === "(")
    return { ...word, kind: "function", text: upper };
  if (KEYWORD_OR_FUNCTION.has(upper))
    return { ...word, kind: "keyword", text: upper };
  if (following?.kind === "column")
    return { ...word, kind: "table", text: tableText(word.source) };
  return { ...word, kind: "identifier", text: word.source.toLowerCase() };
}

// One spelling for `'Sales'`, `Sales` and `SALES`: unquoted when the name could
// be written unquoted, so it matches an unquoted table reference read as an identifier.
function tableText(name: string): string {
  const folded = name.toLowerCase();
  const letters = Array.from(folded);
  const plain =
    letters.length > 0 &&
    letters.every((c, k) =>
      k === 0 ? isWordStart(c) : isWordPart(c) && c !== ".",
    ) &&
    !KEYWORDS.has(name.toUpperCase()) &&
    !KEYWORD_OR_FUNCTION.has(name.toUpperCase());
  return plain ? folded : `'${folded.replaceAll("'", "''")}'`;
}

// Exact decimal arithmetic on the digits, so two literals share a text only when they are the same number.
function numberText(whole: string, fraction: string, exponent: string): string {
  const digits = whole + fraction;
  let start = 0;
  while (digits[start] === "0") start++;
  let end = digits.length;
  while (end > start && digits[end - 1] === "0") end--;
  if (start === end) return "0";
  const significant = digits.slice(start, end);
  const point = whole.length + Number(exponent || "0") - start;
  if (Math.abs(point) > MAX_PLAIN_PLACES)
    return `0.${significant}e${String(point)}`;
  if (point <= 0) return `0.${"0".repeat(-point)}${significant}`;
  if (point >= significant.length)
    return significant + "0".repeat(point - significant.length);
  return `${significant.slice(0, point)}.${significant.slice(point)}`;
}

/** Joins tokens with a space only where two would otherwise read as one. */
export function render(tokens: readonly DaxToken[]): string {
  let out = "";
  let previous: DaxToken | undefined;
  for (const token of tokens) {
    if (previous && needsSpace(previous, token)) out += " ";
    out += token.text;
    previous = token;
  }
  return out;
}

function needsSpace(before: DaxToken, after: DaxToken): boolean {
  if (before.kind === "operator" && after.kind === "operator") return true;
  const last = Array.from(before.text).at(-1) ?? "";
  const first = Array.from(after.text)[0] ?? "";
  if (isWordPart(last) && isWordPart(first)) return true;
  return (last === "'" || last === '"') && first === last;
}

/** Drops comments (`//`, `--`, `/* *\/`) and whitespace; throws DaxSyntaxError on an unterminated string, quoted table, bracket or comment. */
export function tokenize(dax: string): DaxToken[] {
  return lex(dax).map(({ kind, text }) => ({ kind, text }));
}

/** The canonical text of a DAX expression: two spellings of one calculation give one text. */
export function normalize(dax: string): string {
  return render(lex(dax));
}

/** The call starting at `from`: its upper-case name, its arguments split at top-level commas, and the index after its closing parenthesis. */
export function call(
  tokens: readonly SourceToken[],
  from: number,
): { name: string; argumentList: SourceToken[][]; end: number } | null {
  const head = tokens[from];
  if (head?.kind !== "function" || tokens[from + 1]?.text !== "(") return null;
  const argumentList: SourceToken[][] = [];
  let current: SourceToken[] = [];
  let depth = 0;
  for (const [offset, token] of tokens.slice(from + 2).entries()) {
    if (token.kind === "close" && depth === 0) {
      argumentList.push(current);
      return { name: head.text, argumentList, end: from + 3 + offset };
    }
    if (token.kind === "comma" && depth === 0) {
      argumentList.push(current);
      current = [];
      continue;
    }
    if (token.kind === "open") depth++;
    if (token.kind === "close") depth--;
    current.push(token);
  }
  return null;
}

/** `[C]` or `'T'[C]`, whether C is a column or a measure. */
export function isColumnShape(tokens: readonly SourceToken[]): boolean {
  if (tokens.length === 1) return tokens[0]?.kind === "column";
  return (
    tokens.length === 2 &&
    tokens[0]?.kind === "table" &&
    tokens[1]?.kind === "column"
  );
}
