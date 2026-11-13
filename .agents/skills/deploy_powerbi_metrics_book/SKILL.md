---
name: deploy_powerbi_metrics_book
description: Use when a person wants to deploy, install or set up Power BI Metrics Book in their company, pick where it runs (a VM, Dokploy or Coolify, Railway, Azure), or finish its first-time setup after the stack is running.
---

# Deploy Power BI Metrics Book

You set up a metrics book in a company's own cloud account and tenant. Most steps need a person with rights you do not have. Your job is to do the typing, say who acts at each step, and check each result. The docs are the procedure: the deployment serves them at `/docs`, and before one exists they are in `apps/docs/src/content/docs/` of the repository. Do not restate them; follow them.

## Rules for the whole task

- Never ask for a secret in the chat, and never put one in a command line or a file. A secret is set by the person: tell them where Entra or the provider shows it, then say "Run `pbmb admin secrets set <name>` in your own terminal and type the value when it asks." It needs a terminal and prompts without echo, so you cannot run it for them. `pbmb admin secrets list` shows which are set.
- Never read, print or commit `.env`, the age identities, or anything that prints environment values (`env`, `printenv`, `docker inspect`, `docker compose config`). Tell the person to keep a copy of `.env` in the company's password manager: without it the database cannot be reached again.
- Before any step that changes a machine or a cloud account (installing packages, firewall, DNS, creating resources, starting the stack), show the exact command and what it changes, then wait for a yes. A person-only step you hand over; you do not attempt it.
- Never run `docker compose down -v`, `server rotate-identity` or anything that deletes a volume or an identity unless the person asks for that by name.

## 1. Pick where it runs

Ask where the stack should run. The four guides are in `/docs/deploy/`: one VM with Docker Compose (the reference), Dokploy or Coolify on a VM, Railway, Azure Container Apps. Kubernetes has no chart yet, so do not offer it. Ask what the company already runs, and recommend from "Choose it when" in `/docs/deploy/`. Confirm the choice before you go on.

## 2. Follow the guide

Open that guide and follow it in order. Each step says who acts. Tell the person which of their steps come next (DNS, buckets for backups, a cloud login) before you start, so they can line them up.

The guide has you run `pbmb init <directory> --public-base-url <https address>`, then `pbmb check <directory>`, then start the stack. `pbmb init` needs an empty or missing directory. `pbmb init --help` lists its options.

## 3. The setup link

When the stack is healthy, the person prints the setup link themselves. Running it is a step for them: you never run the command, never see the link and never ask for it. Tell them to run, in their own terminal, `docker compose exec api server setup-link` on a VM, or the platform's own exec as the Dokploy, Railway or Azure guide gives it. They open the link in their own browser.

Tell them the facts: the link works once and for 24 hours, running the command again gives a new one and ends every earlier link, and the api never writes the link to its logs, so there is nowhere else to look for it. Then wait until they say the setup page is open.

## 4. The steps only a person can do

The setup follows the pages in `/docs/set-up/`: the address, the app registration in Entra, the scanner registration and its security group, the Power BI tenant settings in the admin portal, what to sync, sign-in providers, who gets in, search, connecting agents, the first sync. Entra and the admin portal need someone with those admin rights. For each step, send the person to its page and say what to come back with; do not copy the page into the chat.

After each step run `pbmb login --url <address>` once (the person enters the code it prints in a browser), then `pbmb admin status` to see what still fails, and `pbmb admin check <name>` for the check the page names. The page "When a check fails" says the one thing to change. Do not move on while a check fails.

A secret the step needs (the app's or the scanner's client secret, an embedding key) goes through `pbmb admin secrets set`, as above.

## 5. Finish

`pbmb admin status` answers, and `pbmb sync status` shows the first sync ran. Any check the status lists as failing says what to change: do it, or pass it to the person when it is theirs, such as a secret saved without its expiry date. Tell the person what is running, where it is, what they still must do themselves (backups, keeping `.env`), and point them at `adapt_conventions` as the next step.
