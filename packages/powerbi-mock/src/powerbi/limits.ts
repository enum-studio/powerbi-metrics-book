import type { Context } from "hono";
import { powerBiError } from "./wire.js";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export type Scan = {
  id: string;
  created_at: number;
  /** Polls of scanStatus so far: the first answers Running, the later ones Succeeded or Failed. */
  polls: number;
  /** What a Failed scan's error says; null when the scan succeeds. */
  failure: string | null;
  result: unknown;
};

/** What the Power BI routes remember between requests. */
export type Runtime = {
  calls: Map<string, number[]>;
  scans: Map<string, Scan>;
  clear(): void;
};

export function createRuntime(): Runtime {
  const runtime: Runtime = {
    calls: new Map(),
    scans: new Map(),
    clear() {
      runtime.calls.clear();
      runtime.scans.clear();
    },
  };
  return runtime;
}

export type Limit = { bucket: string; max: number; window_ms: number };

/**
 * Counts a call against every limit, or, when one is used up, leaves the
 * counts alone and answers how many seconds until it frees a call. The
 * clock is Date.now(), so a test moves mock time with fake timers.
 */
function throttle(runtime: Runtime, limits: Limit[], now: number) {
  const windows = limits.map((limit) => ({
    limit,
    recent: (runtime.calls.get(limit.bucket) ?? []).filter(
      (at) => at > now - limit.window_ms,
    ),
  }));
  let wait_seconds = 0;
  for (const { limit, recent } of windows) {
    const oldest = recent[0];
    if (recent.length >= limit.max && oldest !== undefined) {
      wait_seconds = Math.max(
        wait_seconds,
        Math.ceil((oldest + limit.window_ms - now) / 1000),
      );
    }
  }
  if (wait_seconds === 0) {
    for (const { limit, recent } of windows) {
      runtime.calls.set(limit.bucket, [...recent, now]);
    }
  }
  return wait_seconds;
}

/** 429 with Retry-After when a limit is used up, otherwise null. */
export function refuseWhenThrottled(
  c: Context,
  runtime: Runtime,
  ...limits: Limit[]
): Response | null {
  const wait_seconds = throttle(runtime, limits, Date.now());
  if (wait_seconds === 0) return null;
  c.header("Retry-After", String(wait_seconds));
  return powerBiError(
    c,
    429,
    "TooManyRequests",
    `Too many requests. Retry in ${String(wait_seconds)} seconds.`,
  );
}
