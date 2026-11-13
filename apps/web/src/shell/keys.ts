/** A key pressed in a field is typing, never a shortcut. */
export const typingIn = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest("input, textarea, select, [contenteditable='true']") !== null;
