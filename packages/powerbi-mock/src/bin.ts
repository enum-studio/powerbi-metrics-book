import { serve } from "@hono/node-server";
import { createMockPowerBi } from "./server.js";
import { SAMPLE_PUBLIC_BASE_URL, sampleTenant } from "./sample/tenant.js";

const port = Number(process.env.PORT ?? 3001);
// The origin tokens and links name. A browser and the api reach the container
// at different hosts, so the compose file says which one is the issuer.
const origin = process.env.MOCK_ORIGIN ?? `http://localhost:${String(port)}`;
const control = process.env.MOCK_CONTROL === "1";
// The api's PUBLIC_BASE_URL, whose callbacks the sample's app registration lists.
const public_base_url =
  process.env.SAMPLE_PUBLIC_BASE_URL ?? SAMPLE_PUBLIC_BASE_URL;

serve({
  fetch: createMockPowerBi({
    tenant: sampleTenant({ public_base_url }),
    origin,
    control,
  }).fetch,
  port,
});
console.info(
  `powerbi-mock listening on port ${String(port)} as ${origin}${control ? " with /_mock control routes" : ""}`,
);

// Node as PID 1 ignores SIGTERM unless something handles it; the mock holds no state worth a graceful stop.
process.once("SIGTERM", () => process.exit(0));
