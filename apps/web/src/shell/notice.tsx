import { useEffect } from "react";

/** A completed action or a refusal, read aloud and dismissed after six seconds. */
export function Notice({
  message,
  undo,
  onDismiss,
}: {
  message: string;
  undo?: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 6_000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [message, onDismiss]);
  return (
    <div
      role="status"
      className="fixed bottom-[calc(var(--space-6)+var(--safe-bottom))] left-1/2 z-50 flex w-max max-w-[calc(100%-var(--space-8))] -translate-x-1/2 items-center gap-4 rounded bg-ink px-4 py-3 text-ui text-bg shadow"
    >
      <span>{message}</span>
      {undo !== undefined && (
        <button
          type="button"
          className="shrink-0 underline underline-offset-4 pointer-coarse:min-h-(--tap)"
          onClick={() => {
            onDismiss();
            undo();
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}
