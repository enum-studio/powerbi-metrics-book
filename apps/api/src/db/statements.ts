/** Well under Postgres's 65,535 parameters a statement, at a dozen a row. */
export const ROWS_PER_STATEMENT = 1000;

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size)
    out.push(items.slice(at, at + size));
  return out;
}
