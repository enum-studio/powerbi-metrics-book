import { execFileSync } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { ProxyOptions } from "vite";
import { defineConfig } from "vitest/config";

const DEV_PORT = 5173;
const DEV_ORIGIN = `http://localhost:${String(DEV_PORT)}`;

/**
 * `vite` proxies /api to this checkout's dev stack (pnpm dev:up). The api
 * refuses a state-changing request from another origin, which the dev server
 * is, so a request from the dev server's own page is sent with the api's
 * origin. A request from any other origin keeps its own, and the api refuses
 * it as it would without the proxy.
 */
function devStackProxy(): Record<string, ProxyOptions> {
  const target = execFileSync("node", ["../../scripts/dev-stack.mjs", "url"], {
    encoding: "utf8",
  }).trim();
  return {
    "/api": {
      target,
      changeOrigin: true,
      configure: (proxy) => {
        proxy.on("proxyReq", (request, incoming) => {
          if (incoming.headers.origin === DEV_ORIGIN)
            request.setHeader("origin", target);
        });
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  // No asset inlined as a data: URL, so the api's CSP needs nothing but 'self'.
  build: { assetsInlineLimit: 0 },
  server:
    command === "serve" && process.env.VITEST === undefined
      ? { port: DEV_PORT, strictPort: true, proxy: devStackProxy() }
      : {},
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
}));
