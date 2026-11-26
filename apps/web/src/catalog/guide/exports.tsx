import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, read } from "../../api/client";
import { exportsQuery } from "./queries";

export function Exports({ name }: { name?: string }) {
  const settings = useQuery(exportsQuery);
  const restorePrint = useRef<(() => void) | null>(null);
  function preparePrint() {
    if (restorePrint.current) return;
    const root = document.documentElement;
    const theme = root.getAttribute("data-theme");
    const closed = [
      ...document.querySelectorAll<HTMLDetailsElement>("details:not([open])"),
    ].filter((detail) => !detail.closest(".print\\:hidden"));
    for (const detail of closed) detail.open = true;
    root.setAttribute("data-theme", "light");
    restorePrint.current = () => {
      for (const detail of closed) detail.open = false;
      if (theme === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", theme);
      restorePrint.current = null;
    };
  }
  useEffect(() => {
    const restore = () => restorePrint.current?.();
    window.addEventListener("beforeprint", preparePrint);
    window.addEventListener("afterprint", restore);
    return () => {
      window.removeEventListener("beforeprint", preparePrint);
      window.removeEventListener("afterprint", restore);
      restore();
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function download(format: "markdown" | "pdf") {
    setBusy(true);
    setError(null);
    try {
      const result =
        name === undefined
          ? await read(
              api.GET("/api/v1/guide/export", {
                params: { query: { format } },
              }),
            )
          : await read(
              api.GET("/api/v1/metrics/{name}/export", {
                params: { path: { name }, query: { format } },
              }),
            );
      if (format === "pdf") {
        preparePrint();
        window.print();
      } else {
        const url = URL.createObjectURL(
          new Blob([result.markdown], { type: "text/markdown;charset=utf-8" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name ?? "metrics-guide"}.md`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (failure) {
      restorePrint.current?.();
      setError(
        failure instanceof Error ? failure.message : "The export failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (settings.error) return <p role="alert">{settings.error.message}</p>;
  return (
    <div className="flex flex-wrap gap-3 print:hidden">
      {settings.data?.markdown && (
        <button
          disabled={busy}
          className="text-ui text-accent underline"
          onClick={() => {
            void download("markdown");
          }}
        >
          Export Markdown
        </button>
      )}
      {settings.data?.pdf && (
        <button
          disabled={busy}
          className="text-ui text-accent underline"
          onClick={() => {
            void download("pdf");
          }}
        >
          Export PDF
        </button>
      )}
      {error && (
        <p role="alert" className="text-ui text-ink-2">
          {error}
        </p>
      )}
    </div>
  );
}
