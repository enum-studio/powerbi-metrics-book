import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";

export async function mount(child: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, child));
    await Promise.resolve();
  });
  return {
    host,
    close: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
      client.clear();
    },
  };
}

export async function fill(host: HTMLElement, name: string, value: string) {
  const input = host.querySelector(`input[name="${name}"]`);
  if (!(input instanceof HTMLInputElement))
    throw new Error(`Missing ${name} input`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

export async function submit(host: HTMLElement) {
  const form = host.querySelector("form");
  if (!form) throw new Error("Missing form");
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

export const navigate = vi.fn();
