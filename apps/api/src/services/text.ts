export function excerpt(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  const characters = Array.from(text);
  if (characters.length <= max) return { text, truncated: false };
  const whitespace = characters
    .slice(0, max)
    .findLastIndex((character) => /\s/u.test(character));
  const end = whitespace === -1 ? max - 1 : whitespace;
  return {
    text: characters.slice(0, end).join("").trimEnd() + "…",
    truncated: true,
  };
}
