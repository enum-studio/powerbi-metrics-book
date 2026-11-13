/** What the Node server passes each request, read for the connection's address. */
export type PeerBindings = {
  incoming?: { socket: { remoteAddress?: string | undefined } };
};

/** The connection's address; none for a request made in process (app.request in tests). */
export function peerOf(
  bindings: Partial<PeerBindings> | undefined,
): string | null {
  return bindings?.incoming?.socket.remoteAddress ?? null;
}
