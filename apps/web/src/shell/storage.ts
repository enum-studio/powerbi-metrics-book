/** What a choice kept in the browser reads and writes. A function, because reading window.localStorage itself throws where the browser refuses the site storage. */
export type StorageHost = {
  storage: () => Pick<Storage, "getItem" | "setItem">;
};

/**
 * A browser refuses storage with a DOMException (blocked site data, a full
 * quota). The choice then lasts for this page and nothing else changes; any
 * other error is a bug and is thrown.
 */
export function unlessRefused<T>(use: () => T): T | null {
  try {
    return use();
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}
