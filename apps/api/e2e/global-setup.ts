import type { TestProject } from "vitest/node";
import { compose, type E2eStack, openStack, takeDown } from "./stack.js";

declare module "vitest" {
  export interface ProvidedContext {
    e2e_stack: E2eStack;
  }
}

/**
 * Builds and starts the stack from empty volumes before the suite, and takes
 * it down with its volumes after, whether the suite passed or not. A run that
 * was killed leaves its project behind; the first down clears it.
 */
export default function setup(project: TestProject): () => void {
  const stack = openStack();
  takeDown(stack);
  try {
    compose(stack, ["up", "--detach", "--build", "--wait"]);
  } catch (error) {
    // vitest's report of a global setup's error can fail and hide it.
    console.error(
      `The end-to-end stack did not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    takeDown(stack);
    throw error;
  }
  project.provide("e2e_stack", stack);
  return () => {
    takeDown(stack);
  };
}
