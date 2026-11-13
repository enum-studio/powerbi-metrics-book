import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { putRule, reference, undoSave, undoError } from "../../admin/pii/api";

type NoticeMessage = { message: string; undo?: () => void };

export function useColumnPii() {
  const client = useQueryClient();
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const dismiss = useCallback(() => {
    setNotice(null);
  }, []);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["catalog"] });
    void client.invalidateQueries({ queryKey: ["metric"] });
  };
  const change = useMutation({
    mutationFn: async (
      action:
        | { table: string; name: string }
        | { saved: Awaited<ReturnType<typeof putRule>> },
    ) => {
      if ("saved" in action) {
        await undoSave(action.saved);
        return null;
      }
      return putRule({
        kind: "column",
        table: action.table,
        name: action.name,
        pii: true,
      });
    },
    onMutate: dismiss,
    onSuccess: (saved, action) => {
      setNotice(
        saved === null || !("table" in action)
          ? { message: "Undone." }
          : {
              message: `${reference(action.table, action.name)} is PII in ${String(saved.columns)} columns of ${String(saved.datasets)} datasets you can reach. People without pii_reader no longer see it.`,
              undo: () => {
                change.mutate({ saved });
              },
            },
      );
      // A rule applies across datasets and book entries. Read their visibility again.
      refresh();
    },
    onError: (error) => {
      refresh();
      setNotice({
        message: undoError(error),
      });
    },
  });
  return { change, notice, dismiss };
}
