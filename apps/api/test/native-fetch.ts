/** Test-only client for the native fetch path used inside authentication libraries. */
export function nativeFetch(url: string): Promise<Response> {
  return globalThis.fetch(url);
}
