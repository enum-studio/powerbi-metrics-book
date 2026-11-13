/** "1 draft", "1,200 drafts". */
export const plural = (count: number, one: string) =>
  `${count.toLocaleString("en")} ${one}${count === 1 ? "" : "s"}`;
