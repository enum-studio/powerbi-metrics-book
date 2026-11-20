// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { CheckMessage } from "./check-message";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SENTENCE = "40 other metrics share a content word of the label.";
const LABELS = Array.from({ length: 40 }, (_, at) => `Label ${String(at)}`);

function mount(otherLabels?: readonly string[]) {
  const host = document.createElement("div");
  act(() => {
    createRoot(host).render(
      <CheckMessage
        message={SENTENCE}
        rule="metric_fields.definition"
        otherLabels={otherLabels}
      />,
    );
  });
  return {
    host,
    items: () => [...host.querySelectorAll("li")].map((li) => li.textContent),
  };
}

it("shows a long list short, under the sentence, and all of it when asked", () => {
  const { host, items } = mount(LABELS);
  expect(host.querySelector("p")?.textContent).toBe(
    `${SENTENCE}metric_fields.definition`,
  );
  expect(items()).toEqual(LABELS.slice(0, 5));

  const button = host.querySelector("button");
  expect(button?.textContent).toBe("Show all 40");
  act(() => {
    button?.click();
  });
  expect(items()).toEqual(LABELS);
  expect(button?.textContent).toBe("Show fewer");
  act(() => {
    button?.click();
  });
  expect(items()).toEqual(LABELS.slice(0, 5));
});

it("puts the rule id in monospace after the sentence", () => {
  const host = document.createElement("div");
  act(() => {
    createRoot(host).render(
      <CheckMessage message={SENTENCE} rule="metric_fields.definition" />,
    );
  });
  expect(host.querySelector("p")?.textContent).toBe(
    `${SENTENCE}metric_fields.definition`,
  );
  expect(host.querySelector("p > code")?.textContent).toBe(
    "metric_fields.definition",
  );
});

it("shows a short list whole, with nothing to press", () => {
  const { host, items } = mount(LABELS.slice(0, 5));
  expect(items()).toEqual(LABELS.slice(0, 5));
  expect(host.querySelector("button")).toBeNull();
});

it("shows only the sentence for a check that lists nothing", () => {
  const { host } = mount();
  expect(host.textContent).toBe(`${SENTENCE}metric_fields.definition`);
  expect(host.querySelector("ul")).toBeNull();
});
