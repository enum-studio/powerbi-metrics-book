---
title: Quickstart
description: Three commands start the stack and print the setup link. Open it to begin the setup.
sidebar:
  order: 3
---

Three commands start the stack and print a one-time setup link. No tenant to connect yet? [Try the sample tenant](/docs/start/sample-tenant/) first. You need Docker with Compose, and `uv` to install the `pbmb` command. The stack listens on `127.0.0.1` only, so put a reverse proxy with TLS in front of it before anyone else opens it (the [Deploy](/docs/deploy/) part has one guide per target).

## 1. Write the deployment

```bash
uv tool install powerbi-metrics-book
pbmb init ./powerbi-metrics-book-deployment --public-base-url https://metrics.example.com
cd ./powerbi-metrics-book-deployment
```

Replace the address with the https address people will open. `pbmb init` writes `compose.yml`, `.env` with new random passwords, `access/` for your own policies, and an `AGENTS.md` for your agent. It changes nothing else and does not call the api.

Keep a copy of `.env` somewhere safe. Without it the database cannot be reached again. It is git-ignored, so do not commit it.

## 2. Start the stack

```bash
docker compose up -d
```

The first start pulls the image, creates the database and applies its migrations.

## 3. Print the setup link

```bash
docker compose exec api server setup-link
```

The command prints an address. Open it in your browser. It works once, for 24 hours. Run the command again for a new one: each new link ends every earlier link and setup session.

The api never writes the link to its log, so only someone who can run commands in the container can start the setup. Once an admin exists there is no setup link.

## Then the setup

The link opens the setup: a guide with a step rail, where each step says what to do, gives every value to copy and checks the result with a real call before the next step. Follow the [Set up](/docs/set-up/) part in the same order. It uses the same words as the setup screens.

## Then curate with your agent

Once the first sync has run, sign in with `pbmb login` in your own terminal. Then open Claude Code, Codex or Cursor in any folder and tell it:

```text
Run `pbmb curate` and follow what it prints.
```

The command changes nothing. It gives the agent a brief, and the agent asks you only what it cannot work out. [Start with an agent](/docs/use/for-curators-agent/) says what it does and when it asks.

## Check

Both of these must pass before you open the link:

```bash
docker compose ps
curl -s http://127.0.0.1:3000/health
```

`docker compose ps` shows `api`, `worker`, `postgres` and `cerbos` as healthy. The `curl` answers `{"ok":true,...}` with the version. If the `api` is not healthy, read `docker compose logs api`: it names the bootstrap value that is missing or wrong.
