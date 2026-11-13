---
title: Address
description: Set PUBLIC_BASE_URL to the https address people open, put a proxy in front, and open the setup.
sidebar:
  order: 1
---

Screen 1, **Address**, checks on load and appears only when the check fails. It fixes the one address the whole product uses. Sign-in, the Power BI connection and every agent send people back to it, and the cookies that keep people signed in travel over https only.

## Before you start

- The stack runs (see the [quickstart](/docs/start/quickstart/)).
- You have a name for it, such as `metrics.example.com`, and a way to serve it over https. The [Deploy](/docs/deploy/) part has one guide per target.

## Steps

1. Decide the address people will type, with `https://` and no path. In this guide it is `https://metrics.example.com`.
2. Set it in the deployment's `.env`. `pbmb init --public-base-url` wrote it the first time; edit the line if it is wrong:

   ```text
   PUBLIC_BASE_URL=https://metrics.example.com
   ```

3. Put a reverse proxy in front of the api that ends https. The stack publishes the api on `127.0.0.1` only (port `3000`, or `PBMB_PORT`). The proxy must:
   - pass the `Host` header unchanged, so the host the api sees is the host in `PUBLIC_BASE_URL`;
   - add the client's address in `X-Forwarded-For`;
   - be named in `TRUSTED_PROXY` in `.env` (its address, or a range holding it), or every sign-in attempt counts against the proxy's own address.

   With Caddy the whole proxy is:

   ```text
   metrics.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Source: [Caddy's reverse_proxy directive](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), which sets `X-Forwarded-For` and leaves the `Host` header as the client sent it when the upstream is plain http.

4. Restart the stack so the api reads `.env`:

   ```bash
   docker compose up -d
   ```

5. Print a setup link and open it. It works once, for 24 hours, and printing a new one ends every earlier link and any open setup session:

   ```bash
   docker compose exec api server setup-link
   ```

   On Dokploy, Coolify, Railway or Azure Container Apps, run `server setup-link` in the api service with that platform's shell. Each [deploy guide](/docs/deploy/) shows where.
6. If screen 1 appears, compare **This page's address** with `PUBLIC_BASE_URL`, make the fix the page names, then select **Check the address**. A passing check moves straight to screen 2.

Plain `http` works only in development and test. In production the check fails, because the cookies are always `Secure`.

## Check

Press **Check the address**. It passes when the api is served over https and the page was opened at the host in `PUBLIC_BASE_URL`. You can run the same check later:

```bash
pbmb admin check address
```

If it fails, find the sentence on [When a check fails](/docs/set-up/when-a-check-fails/#address) and make the one change it names.

Next: **Connect your Microsoft tenant**, starting with [The app registration](/docs/set-up/app-registration/).
