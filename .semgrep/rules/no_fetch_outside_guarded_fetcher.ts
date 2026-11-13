// Stands in for a file such as apps/api/src/services/powerbi/client.ts. The
// rule's `paths:` block (apps/api/src/**, minus the guarded fetcher) is not
// applied by `semgrep --test`, so the fixture lives beside the rule.
// The undici clause's test-file excludes (*.test.ts, *_security_test.ts) are
// paths too, so this fixture cannot show them; a scan of a *.test.ts and a
// plain .ts file that both import undici flags only the plain one.

// ruleid: no-fetch-outside-guarded-fetcher
await fetch("https://example.com");

// ruleid: no-fetch-outside-guarded-fetcher
await globalThis.fetch(new URL("/health", "https://example.com"));

// ruleid: no-fetch-outside-guarded-fetcher
const load = () => window.fetch("https://example.com", { method: "POST" });

// ok: no-fetch-outside-guarded-fetcher
await deps.fetcher.fetchFixed("https://example.com");

// ok: no-fetch-outside-guarded-fetcher
await deps.fetcher.fetchUntrusted("https://example.com");

// ok: no-fetch-outside-guarded-fetcher
const hit = await cache.fetch("key");

// ok: no-fetch-outside-guarded-fetcher
const fetchCount = 3;

// ruleid: no-undici-outside-guarded-fetcher
import { Agent, fetch as undiciFetch } from "undici";

// ruleid: no-undici-outside-guarded-fetcher
import * as undici from "undici";

// ruleid: no-undici-outside-guarded-fetcher
import { request } from "undici";

// ruleid: no-undici-outside-guarded-fetcher
import "undici";

// ruleid: no-undici-outside-guarded-fetcher
const lazy = await import("undici");

// ruleid: no-undici-outside-guarded-fetcher
const loaded = require("undici");

// ruleid: no-undici-outside-guarded-fetcher
await undici.request("https://example.com");

// ok: no-undici-outside-guarded-fetcher
import { fetcherFor } from "../http/fetcher.js";

// ok: no-undici-outside-guarded-fetcher
import { Agent as HttpsAgent } from "node:https";
