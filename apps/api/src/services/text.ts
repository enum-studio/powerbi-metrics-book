export function excerpt(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  const characters = Array.from(text);
  if (characters.length <= max) return { text, truncated: false };
  let end = max - 1;
  for (let i = end; i >= 0; i--) {
    if (/\s/u.test(characters[i] ?? "")) {
      end = i;
      break;
    }
  }
  return {
    text: characters.slice(0, end).join("").trimEnd() + "…",
    truncated: true,
  };
}
