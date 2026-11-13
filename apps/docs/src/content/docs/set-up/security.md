---
title: Security
description: Run the security checklist on your own deployment and fix each item that fails.
sidebar:
  order: 4.3
---

**What to do next** and **Admin > Status** show an admin each item of the security checklist that fails. Each says why, says what to change, and links to where you change it. Security is not a first-run step. The full checklist, with the items that pass, comes from the command line.

The checklist here covers what can be checked on a running deployment. [The evaluator's checklist](/docs/security/checklist/) covers the controls built into the code, each with the test that proves it. [Secrets and tokens](/docs/security/secrets-and-tokens/) explains where each secret is kept.

## Before you start

- The address, sign-in app and scanner checks have run, because several items read their results.
- A terminal in the folder that holds your `compose.yml`.

## Steps

1. Read any failing items on **What to do next**, or under **Needs attention** in **Admin > Status**.
2. For the full list, run the command below. Each line shows `passing`, `failing` or `explained`, then the item's name and one sentence.

   ```bash
   pbmb admin check security --json \
     | jq -r '.details.items[] | "\(.status) \(.item): \(.sentence)"'
   ```

3. Fix each item that fails, using the table, and reload the page. Both pages read the checklist fresh each time they load.

| Item | Passes when | If it fails |
|---|---|---|
| `https` | `PUBLIC_BASE_URL` is https. | Serve the api over https at the proxy and set the address. See [Address](/docs/set-up/address/). |
| `cookies_secure` | Always passes: cookies are `Secure`, `HttpOnly` and `SameSite=Lax`. | Nothing to change. |
| `scanner_secret_worker_only` | The scanner's secret is encrypted for the worker only. | Enter the scanner's secret again on [The scanner](/docs/set-up/scanner/). A secret saved there is encrypted for the worker alone. |
| `app_registration_read_only` | The app registration's check has passed and named nothing extra for Power BI. It reads no other resource, such as Microsoft Graph. **Explained** when the check named permissions for Power BI that the app does not need, which may include one that writes. | Finish [The app registration](/docs/set-up/app-registration/). If it is explained, read the note on that check, and remove what nothing else uses. |
| `expiry_<name>` | An Entra or sign-in secret has the expiry date you entered. | In **Settings > Secrets**, press **Expiry date** on the secret, or run `pbmb admin secrets expiry <name> YYYY-MM-DD`. The value stays as it is. Use the date Entra shows. |
| `identity_volume_private` | Only the api's own user can read its identity volume (`/var/lib/pbmb/identity`). | Mount the `api_identity` volume there, and run `docker compose exec api chmod 700 /var/lib/pbmb/identity`. |
| `worker_identity_volume_private` | Always **explained**: the api cannot see the worker's volume. | Check it yourself, below. |

If you give the api its identity in `API_AGE_IDENTITY`, `identity_volume_private` is **explained**, because no volume holds it.

The worker's volume is the one item you check by hand:

```bash
docker compose exec worker ls -ld /var/lib/pbmb/identity
```

The line must start with `drwx------`. Back up the identity volumes apart from the database dump: a dump alone holds no usable secret, and a lost volume means entering that container's secrets again.

## Check

The check passes when no item fails. The same check runs from a terminal and exits 1 while an item fails, so a script can wait on it:

```bash
pbmb admin check security
pbmb admin status
```

`pbmb admin status` lists failing checks and the secrets that expire within 30 days. The checks run again every day. If a sentence appears, find it on [When a check fails](/docs/set-up/when-a-check-fails/#security).
