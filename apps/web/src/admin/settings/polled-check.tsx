import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, api, read } from "../../api/client";
import { ADMIN_KEY, type Check, runCheck } from "./api";

const POLL_MS = 3000;

/**
 * Runs a check by name. A check the worker runs (the scanner's) answers
 * pending at once, and is asked again every few seconds, which starts
 * nothing, until it settles or the page closes; then the admin's data is
 * read again.
 */
export function usePolledCheck(name: string | null | undefined) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<Check | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = result?.pending === true;

  useEffect(() => {
    if (!pending || name === null || name === undefined) return;
    const again = setTimeout(() => {
      read(
        api.GET("/api/v1/admin/checks/{name}", { params: { path: { name } } }),
      )
        .then(async (now) => {
          setResult(now);
          if (now.pending !== true)
            await queryClient.invalidateQueries({ queryKey: ADMIN_KEY });
        })
        .catch((error: unknown) => {
          if (!(error instanceof ApiError)) throw error;
          setProblem(error.message);
        });
    }, POLL_MS);
    return () => {
      clearTimeout(again);
    };
  }, [pending, result, name, queryClient]);

  return {
    result,
    problem,
    run: async () => {
      if (name === null || name === undefined) return;
      setProblem(null);
      setResult(await runCheck(name));
      await queryClient.invalidateQueries({ queryKey: ADMIN_KEY });
    },
  };
}

/** A check that runs in the worker, said as it runs. */
export function PendingLine({ message }: { message: string | null }) {
  return (
    <p role="status" className="text-ui text-ink-2">
      <span className="mr-2 font-semibold">Checking.</span>
      {message}
    </p>
  );
}
