---
title: When a check fails
description: Every sentence a setup check can answer when it does not pass, grouped by step, each with its cause and the one fix.
sidebar:
  order: 11
---

Find the sentence your step showed, read its cause, and make the one change it names. Then press the step's button again.

Every sentence below is quoted exactly as the check says it. A test compares this page with the code, so a sentence the product says always has an entry here. Where a sentence holds a value of yours (an address, a count, a name), the entry shows an example in its place.

The first run follows [Address](/docs/set-up/address/), [Connect your Microsoft tenant](/docs/set-up/app-registration/), [Sign in](/docs/set-up/sign-in/) and [What to sync](/docs/set-up/what-to-sync/). Other checks run in the admin section. Find a sentence under: [Address](#address), [The app registration](#the-app-registration), [The scanner](#the-scanner), [What to sync](#what-to-sync), [Sign-in](#sign-in), [Who gets in](#who-gets-in), [Search](#search), [Agents](#agents), [First sync](#first-sync), [Security](#security).

## Address

Guide: [Address](/docs/set-up/address/).

> PUBLIC_BASE_URL is not https. Serve the api over https at the proxy, then set PUBLIC_BASE_URL to that https address.

**Cause.** The address in `.env` starts with `http://`, and only development and test allow that. **Fix.** Put an https proxy in front of the api, set `PUBLIC_BASE_URL=https://metrics.example.com` in `.env`, run `docker compose up -d`, and open a new setup link.

> This page came in at another address than PUBLIC_BASE_URL, https://metrics.example.com. Open the setup at that address, or set PUBLIC_BASE_URL to the one people use.

**Cause.** You opened the setup at a host that is not the one in `PUBLIC_BASE_URL`, or the proxy rewrote the `Host` header. **Fix.** Open the setup at the address the sentence names. If that is the wrong address, change `PUBLIC_BASE_URL`. If the proxy rewrites `Host`, make it pass it on unchanged.

## The app registration

Guide: [The app registration](/docs/set-up/app-registration/).

> Enter the app registration's client id and secret first.

**Cause.** The client id or the secret is empty. **Fix.** Enter the **Application (client) ID**, the **Directory (tenant) ID** and the **Client secret value**, then press **Check the app registration**.

> Microsoft refused the app registration's client id or secret. Copy the secret's Value, not its Secret ID, from Certificates & secrets.

**Cause.** The client id is wrong, or the secret field holds the **Secret ID** or an expired secret. **Fix.** In Entra open the registration, then **Certificates & secrets**, and copy the **Value** column of a secret that has not expired. If none is left, make a new one.

> The client secret has expired: make a new one in Certificates & secrets and enter it here.

**Cause.** Microsoft refused an expired client secret. **Fix.** In the registration's **Certificates & secrets**, make a new secret, copy its **Value**, and enter it again.

> Microsoft gave the app registration no token. Check the tenant id: it is the Directory (tenant) ID on the registration's Overview page.

**Cause.** The tenant id does not match the registration, or Microsoft could not be reached. **Fix.** Copy **Directory (tenant) ID** again from the registration's **Overview** page. If it is right, run the check again in a few minutes.

> Microsoft answered a token this check cannot read, so its permissions are unknown. Run the check again; if it repeats, the authority setting may not be Microsoft's.

**Cause.** The answer was not a token the check can read. Something other than Microsoft answered, or the answer was cut. **Fix.** Run the check again. If it repeats, read the api's log with `docker compose logs api`.

> The app registration works. Sign in with Microsoft now: you become the first admin.

**Cause.** Not a failure. The credentials work, and the first admin does not exist yet. **Fix.** Press **Sign in with Microsoft now** and sign in with the account that will run the product.

> Confirm the person who signed in. They become the first admin, and the setup's link and session end.

**Cause.** Not a failure. The setup shows the name and email of the person who signed in. **Fix.** Check that it is you and press **Make me the admin**.

> That is not the email of the person who signed in. Confirm the email the setup shows.

**Cause.** The email sent for confirmation differs from the signed-in person's. **Fix.** Use the button the setup offers. It sends the email shown beside the name.

> The setup's sign-in came through {tenant}, and the stack now has {tenant}. Print a new setup link and sign in again.

**Cause.** The tenant id or the identity address changed between the sign-in and the confirmation, so the sign-in no longer matches the stack. Nothing was made. **Fix.** Run `docker compose exec api server setup-link`, open the new link and sign in again.

> The dev sign-in is open (NODE_ENV={env} with ALLOW_DEV_SIGN_IN=1), and the stack points at Microsoft identity at {host}. The dev sign-in runs only on the mock: shut it, or point the stack at the mock.

**Cause.** The api runs with the development sign-in open while it points at Microsoft identity rather than the mock. The dev sign-in lets anyone in as any email, so it never runs over a real tenant. The api and the worker refuse to start in this state, and the confirmation refuses too. **Fix.** Set `ALLOW_DEV_SIGN_IN=0` or `NODE_ENV=production` and restart. Or, on the sample's own database, point `POWERBI_AUTHORITY` at the mock: a database bound to a real tenant never starts on the mock.

> Connect Power BI now, so the check can read what your token allows.

**Cause.** Not a failure. The check reads the permissions your own Power BI token holds, and you have not connected yet. **Fix.** Press **Connect Power BI**. If Microsoft asks for consent, admin consent was not granted: see the entry that begins "Your Power BI token lacks".

> Not needed by this app, which never uses {it or them}: {permissions}. The app can still do what {it allows or they allow}.

**Cause.** Not a failure: the check passed, and setup goes on. The sign-in app holds more than this app needs, perhaps because it also serves another product. Names that show what a permission can do come first, with a label: `Tenant.ReadWrite.All` can change every workspace, `Tenant.Read.All` reads every workspace, and a name holding `ReadWrite` can write. A name does not show every write: `Mail.Send` gets no label. Past the room in the sentence, it says how many more, and those may do as much as the ones named. A name that is not a permission's usual form is not repeated, and reads as "a permission". **Fix.** None needed. If nothing else uses a permission, you can remove it under **API permissions**, then connect Power BI again.

> {An application permission acts or Application permissions act} without any person: {permissions}. This app does not use {it or them}, and {it or they} can be removed.

**Cause.** Not a failure: the check passed, and setup goes on. The registration has a permission of type **Application** for Power BI, named the same way as above. This app reads Power BI only as each person. The check reads no other resource, so it does not show one on Microsoft Graph. **Fix.** None needed. If nothing else uses it, open **API permissions** in Entra, select the three dots beside each permission whose **Type** is **Application**, and choose **Remove permission**.

> {An application permission acts or Application permissions act} without any person: {permissions}. This app's service-account queries send the token holding {it or them}.

**Cause.** Not a failure: the check passed, and setup goes on. `powerbi.service_account_queries` was on when the check ran, and those queries run with the app's own token, which holds this permission. **Fix.** None needed. To take it away from those queries, remove it as the entry above says, if nothing else uses it.

If an earlier release stopped you with a sentence that told you to remove a permission from the sign-in app, you need to change nothing in Entra. Open the setup again: the check runs again by itself, and passes with one of the notes above.

> Your Power BI token lacks Dataset.Read.All. Add that delegated permission under API permissions, grant admin consent, then connect Power BI again.

**Cause.** `Dataset.Read.All` is missing, or admin consent was not granted for it. **Fix.** Under **API permissions** add **Power BI service** > **Delegated permissions** > `Dataset.Read.All`, select **Grant admin consent**, then press **Connect Power BI**.

## The scanner

Guide: [The scanner](/docs/set-up/scanner/). These sentences also appear on [What to sync](#what-to-sync), which reads Power BI as the scanner.

> These are the same app. The scanner needs its own registration.

**Cause.** The scanner's client id belongs to the app used for sign-in. **Fix.** Create a separate scanner registration and enter its **Application (client) ID** and **Client secret value**.

> Enter the scanner registration's client id and secret first.

**Cause.** The scanner's client id or secret is empty. **Fix.** Enter the scanner's **Application (client) ID** and **Client secret value** on screen 2.

> Microsoft refused the scanner registration's client id or secret. Copy the secret's Value, not its Secret ID, from Certificates & secrets.

**Cause.** The scanner's client id is wrong, or the secret is the **Secret ID** or has expired. **Fix.** Copy the **Value** of a live secret from the scanner registration's **Certificates & secrets**, and enter it again.

> Microsoft gave the scanner registration no token. Check the tenant id: it is the Directory (tenant) ID on the registration's Overview page.

**Cause.** The tenant id saved in step 2 does not match the scanner registration's tenant, or Microsoft's token endpoint answered with an error. **Fix.** Check that both registrations are in the same tenant and that step 2 holds its **Directory (tenant) ID**. Then run the check again.

> The scanner registration holds an API permission. Remove it: Power BI refuses admin APIs to an app that holds one, and the tenant setting gives the scanner what it reads.

**Cause.** The scanner registration has a permission of type **Application**. **Fix.** In Entra open the scanner registration's **API permissions** and remove every permission of type **Application**. An empty list is right.

> Power BI refused admin APIs to this service principal: add it to the security group named in Admin API settings.

**Cause.** The scanner's service principal is not in the security group that `Service principals can access read-only admin APIs` allows, or the setting has not reached it yet. **Fix.** Put the scanner in the group, check that the group is the one named in **Admin API settings**, and wait up to 15 minutes.

> Tables came back without columns and measures: turn on the tenant setting Enhance admin APIs responses with detailed metadata, for the scanner's security group.

**Cause.** The tenant setting is off or does not include the group. **Fix.** Turn on `Enhance admin APIs responses with detailed metadata` for the scanner's security group, and wait up to 15 minutes.

> Measures came back without DAX: turn on the tenant setting Enhance admin APIs responses with DAX and mashup expressions, for the scanner's security group.

**Cause.** The DAX setting is off or does not include the group. **Fix.** Turn on `Enhance admin APIs responses with DAX and mashup expressions` for the scanner's security group, and wait up to 15 minutes.

> Power BI's admin API answered 500. Try the check again in a few minutes.

**Cause.** Power BI's admin API failed with an error the other sentences here do not cover, and the check shows only the status number, never Power BI's own wording. **Fix.** Wait a few minutes and run the check again. The worker's log has a line `scanner check failed` with the status and Power BI's error code, if you need to send it with a report.

> Power BI's admin API is limiting calls. Try again in 30 seconds.

**Cause.** Power BI limited the calls. **Fix.** Wait as long as it says, and run the check again.

> Power BI's scan did not finish. Try the check again in a few minutes.

**Cause.** The scan of up to 10 workspaces failed, or did not finish in time. **Fix.** Wait a few minutes and run the check again.

> Power BI's admin API did not answer the scanner. Try the check again in a few minutes.

**Cause.** The call timed out or could not connect. **Fix.** Wait a few minutes and run the check again.

> Power BI's admin API answered in a shape this version cannot read.

**Cause.** Power BI sent an answer this version does not understand. **Fix.** Update to the latest version. If it still happens, the worker's log has a line `scanner check failed` naming where the answer differed, never what it said; send that line with your report.

> Power BI lists no workspace to the scanner. Give it a workspace, or include personal ones.

**Cause.** The tenant has no workspace the scanner may list. **Fix.** Create a workspace with a report in it, or tick **Also sync people's personal workspaces** on screen 4.

### Waiting for the worker

The scanner and What to sync run in the worker, so the page may say this while it waits. While a check waits or runs, its section says **Checking**. **Needs a fix** appears only once a check has run and failed.

> The worker is checking the scanner: a token, the workspace list, then a scan of up to 10 workspaces. This takes up to a minute.

**Cause.** Not a failure. **Check the scanner** is running. **Fix.** Wait. The page asks again every few seconds.

> The worker is asking Microsoft for the scanner's token.

**Cause.** Not a failure. **Check the scanner app** is running. **Fix.** Wait. It takes a second or two.

> The worker is asking Power BI for the workspace list.

**Cause.** Not a failure. The What to sync check is running. **Fix.** Wait.

> The check is in the worker's queue and starts shortly.

**Cause.** Not a failure. The worker has not reached the check yet. **Fix.** Wait.

> The worker is finishing a sync. This check starts right after it.

**Cause.** Not a failure. The worker runs one job at a time, and a sync can take some minutes. **Fix.** Wait. You can leave this page, and the check still runs.

> The worker is finishing another job. This check starts right after it.

**Cause.** Not a failure. The worker runs one job at a time. **Fix.** Wait.

> The worker has not started this check after 90 seconds, and no job of its is running. Check that the worker container is running.

**Cause.** The check is still queued with nothing ahead of it, so the worker is probably stopped. **Fix.** Run `docker compose ps`, and start the `worker` if it is stopped. If it is running, read `docker compose logs worker`. The check starts when the worker is back, and you do not need to press the button again.

> The worker could not run this check. The worker's log says why.

**Cause.** The worker's job failed or was skipped. **Fix.** Run `docker compose logs worker`, fix what it names, and press the button again.

> This check has not run yet. Run it on this step.

**Cause.** The check never ran. **Fix.** Press the step's button.

## What to sync

Guide: [What to sync](/docs/set-up/what-to-sync/). A refusal from the scanner shows the sentences under [The scanner](#the-scanner).

> Personal workspaces in the listed set before trimming; a lower bound when truncated.

This describes `personal_count`, not a failure: it counts personal workspaces before the list is trimmed. A truncated list gives a lower bound.

> The first sync would scan no workspace. Include at least one that Power BI lists.

**Cause.** Your lists leave no workspace: **Only these workspaces** is empty or names ids Power BI does not list, or **Workspaces to skip** holds every one. **Fix.** Tick **Every workspace Power BI lists**, or list ids from the workspaces' addresses, and remove a skipped workspace you want.

## Sign-in

Guide: [Sign-in](/docs/set-up/sign-in/).

> Enter the client secret of the sign-in provider google.

**Cause.** A provider you added has no secret saved. **Fix.** Under **Credentials** enter **Client secret of** that provider, or remove the provider.

> The provider okta has no discovery document at its issuer. Check the issuer URL: it ends before /.well-known.

**Cause.** `<issuer>/.well-known/openid-configuration` did not answer, or its `issuer` field is not what you entered. **Fix.** Open that address in a browser. Enter the `issuer` value from the document in **Issuer**, character for character, without `/.well-known/openid-configuration`.

## Who gets in

Guide: [Who gets in](/docs/set-up/who-gets-in/). This check does not fail, so it has no sentence to fix. It passes with one of two sentences that say who would get in: `Only the people, domains and groups assigned a role get in.` when **Everyone in the tenant gets** is **No role until given one**, and `Everyone in the tenant gets in as viewer, and the people, domains and groups assigned a role get it.` (with the default role you chose) otherwise. Check that the list under it shows everyone who should get in.

## Search

Guide: [Search](/docs/set-up/search/).

> Enter the API key of the provider you chose, then run the check again.

**Cause.** The chosen provider has no key saved. **Fix.** Enter its key, or choose **None**.

> The provider refused the API key. Paste the key again, and check that it belongs to the provider you chose.

**Cause.** The key is wrong, revoked, or from the other provider. **Fix.** Create a key with the chosen provider and paste it again.

> The provider is rate limiting this key. Wait a few minutes and run the check again.

**Cause.** The key has used its quota for now. **Fix.** Wait and run the check again, or raise the key's limit with the provider.

> The provider failed on its side. Run the check again in a few minutes.

**Cause.** The provider had a fault. **Fix.** Wait and run the check again.

> The provider refused the request. Check the model name and the address, and that the key is for this provider.

**Cause.** The model name is unknown to the provider, or the key cannot use it. **Fix.** Leave **Model** empty for the default, or enter a model as the provider names it.

> The provider answered in a shape this version does not know. Check the model name and the address.

**Cause.** The provider answered something other than an embedding, which a model that is not an embedding model does. **Fix.** Leave **Model** empty to use the default.

> The provider could not be reached. Check the address and that this server can reach it.

**Cause.** The api cannot connect to the provider. **Fix.** Check that the `api` container may reach the internet (the `egress` network).

## Agents

Guide: [Agents](/docs/set-up/agents/).

> No agent of yours has signed in to the connector yet. Add the MCP address to Claude, Codex or Cursor, then ask it to run whoami.

**Cause.** No admin has called `whoami` through the connector. **Fix.** Add `https://metrics.example.com/api/mcp` to your agent, sign in as an admin, and ask it to run `whoami`. The `pbmb` command does not count: the call must come through MCP.

## First sync

Guide: [First sync](/docs/set-up/first-sync/).

> The first sync is running: 12 workspaces scanned so far.

**Cause.** Not a failure. The sync is running. **Fix.** Wait. The page asks again every few seconds.

> The first sync waits for the worker to start it. Check that the worker container is running.

**Cause.** The sync is queued and the worker has not started it. **Fix.** Run `docker compose ps`, start the `worker` if it is stopped, and read `docker compose logs worker`.

> No sync has run yet. Start the first sync on this step.

**Cause.** No sync has been started. **Fix.** Press **Start the first sync**.

> The last sync failed. pbmb sync status says what it could not read or store, and why: fix that, then start the sync again.

**Cause.** The scan or the store failed. A workspace, dataset or app that fails leaves the others mirrored, so this can come from one model. **Fix.** Run `pbmb sync status`, whose newest run names each one that failed by its ID, and `docker compose logs worker` for more. Fix what it names and press **Start the sync again**. A workspace that fails on every sync, or holds a dataset or app that does, can go under **Workspaces to skip**, by the workspace ID the run names, and the next full scan then removes it from the mirror. Until it does, an app in that workspace that could not be stored keeps failing each run.

## Security

Guide: [Security](/docs/set-up/security/). Each failing item has a sentence of its own.

> 2 of the security checklist's items fail. Each says what to change.

**Cause.** The summary above the failing items. **Fix.** Fix the items listed under it.

> PUBLIC_BASE_URL is not https. Serve the api over https at the proxy.

**Cause.** The address is http. **Fix.** As under [Address](#address).

> The api can read the scanner's secret. Enter it again, so it is encrypted for the worker only.

**Cause.** The scanner's secret was saved in a way that the api can read. **Fix.** Enter the scanner's secret again on screen 2.

> The app registration's check has not passed. Finish the app registration step first.

**Cause.** The app registration check has not passed. **Fix.** Pass [The app registration](#the-app-registration) first.

> The app registration's client secret has no expiry date. Enter the date Entra shows, so you are warned before it expires.

**Cause.** The named secret was saved without its expiry date. The app registration's is `powerbi_app_client_secret` on the page, and the scanner registration's is `powerbi_scanner_client_secret`. **Fix.** In **Settings > Secrets**, press **Expiry date** on that secret and enter the date Entra shows, or run `pbmb admin secrets expiry powerbi_app_client_secret 2027-06-30` with its name and date. The value stays as it is.

> IDENTITY_DIR does not exist in the api, so its identity is not kept on a volume.

**Cause.** The `api_identity` volume is not mounted where the api looks. **Fix.** Mount it at `/var/lib/pbmb/identity` in the `api` service, or give the identity in `API_AGE_IDENTITY`.

> The api could not read IDENTITY_DIR, so it cannot say who else can. The api's log has the reason.

**Cause.** Something other than a missing folder stopped the api reading it, such as a file in its path or a volume with the wrong owner. The log line "IDENTITY_DIR could not be read in its check" holds the error code. **Fix.** Make `/var/lib/pbmb/identity` a folder the api's user can read.

> Other users can read the api's identity volume. Run chmod 700 on it.

**Cause.** The folder is open to other users. **Fix.** Run `docker compose exec api chmod 700 /var/lib/pbmb/identity`.

## Any step

> Stored setup check details are invalid.

**Cause.** The stored check details do not match this version's schema. **Fix.** Run the check again to replace them. If it still fails, read the worker's log.

> The check's answer repeated part of the value, so it is not shown. Look at the value where it was issued.

**Cause.** The check's answer held part of the value you entered, so the product replaced it. **Fix.** The value is probably wrong. Copy it again from where it was issued (Entra, Google, your provider).
