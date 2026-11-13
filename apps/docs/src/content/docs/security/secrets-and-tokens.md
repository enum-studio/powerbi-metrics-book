---
title: Secrets and tokens
description: Where each secret and token is kept, who can read it, what a database dump holds, how to back up and rotate the keys, and when client secrets expire.
sidebar:
  order: 40
---

Every secret is encrypted for the container that needs it, with a key that is not in the database. A copy of the database alone opens none of them. This page says what is kept where, who can read it, and what you have to do about backups, rotation and expiry.

## What is kept where

| What | Where it is kept | Who can read it |
| --- | --- | --- |
| The app registration's client secret (`powerbi_app_client_secret`) | `secret_ciphertext`, encrypted for the api | the api |
| The scanner's client secret (`powerbi_scanner_client_secret`) | `secret_ciphertext`, encrypted for the worker | the worker only |
| A sign-in provider's client secret (`sign_in_<id>_client_secret`) | `secret_ciphertext`, encrypted for the api | the api |
| The key that signs CSV links (`result_link_key`) | `secret_ciphertext`, encrypted for the api. The stack makes it and never shows it | the api |
| The embedding key (`openai_api_key` or `gemini_api_key`) | `secret_ciphertext`, one copy encrypted for each container | the api and the worker |
| A person's Power BI tokens | `powerbi_connection`, encrypted for the api. One row per person, only while connected | the api. The worker has no grant on the table |
| Service-account API keys (`pbmb_sk_...`) | their SHA-256 digest, never the key. The key is shown once, when it is made | nobody: the digest cannot be reversed |
| The setup link | its SHA-256 digest in `setup_link`; the link itself is printed by `server setup-link` and never logged | whoever runs `server setup-link` in the container |
| `AUTH_SECRET` and the database passwords | the deployment's `.env`, mode 0600 | whoever runs the host |
| Each container's age identity | its own volume, `api_identity` or `worker_identity`, mode 0400, or `API_AGE_IDENTITY` or `WORKER_AGE_IDENTITY` in the environment | that container |

No secret is in `compose.yml`. No route returns a secret's value. The admin section, the CLI and the API show only whether a secret is set, its last four characters, who set it and when, its expiry and its last check. The proofs are on [the checklist](/docs/security/checklist/#6-secrets-are-never-shown-again-and-a-database-copy-holds-none-in-clear).

## How the encryption works

Each container makes an [age](https://age-encryption.org) identity (X25519) the first time it starts, in a volume only that container mounts. It publishes the public half to the table `container_identity`. When an admin saves a secret, the api encrypts it once for each container that reads it. Only the matching private key opens a copy.

The api writes the scanner's secret and can never read it back, because the api's identity is not a recipient of it. A broken api therefore does not hold the credential that reads your whole tenant.

You can give a container its identity from the environment instead of a volume. Then no file holds it, and the security checklist marks the volume check as explained.

## What a database dump holds

A dump holds ciphertext for every secret and Power BI token above. It also holds:

- API key digests and setup link digests, which cannot be turned back into the key or the link.
- The JWT signing key for access tokens, encrypted with `AUTH_SECRET`. That value is in `.env`, not in the database.
- Device codes and user codes, in clear. They last 10 minutes. The threat model records this as an exception that awaits sign-off.
- In clear: the mirror (workspace, dataset, table, column and measure names, DAX, access lists), the book, people's names and email addresses, the audit trail, the query log, and stored query results until they expire (`results.ttl_hours`: 24 hours by default, 72 at most, and the worker deletes a result within 15 minutes of expiry; the VM backup leaves result rows out).

So a dump is not a safe thing to hand around. It holds no usable secret, and it does hold your metadata and recent results. Treat it as confidential data.

## Back up the identity volumes apart from the dump

The two copies must not travel together. A dump with the identity volumes opens every secret and token. Either one alone opens none.

The containers do not take a backup in this version. Whatever you use must follow three rules:

1. Back up `api_identity` and `worker_identity` to a store that is different from the one that holds database dumps, with different access.
2. Keep dumps for the retention your policy sets, and know that a dump taken before an [identity rotation](#rotating-an-identity) still opens with the old identity.
3. Test a restore of both. A database restored without its identity volumes works, but its secrets cannot be read: you enter them again.

If an identity volume is lost, enter that container's secrets again in the admin section, which lists them. People whose tokens were sealed for the api connect Power BI again.

## Rotating an identity

Rotate an identity when its volume or its backup may have been seen by someone who should not have seen it. Run the command in the running container, then restart it:

```bash
docker compose exec api server rotate-identity
docker compose restart api
```

```text
The api has a new identity and 4 secrets were encrypted to it. Restart the api so it reads them with the new identity.
```

The command makes a new identity, decrypts every secret the container reads with the old one, encrypts it for the new one and publishes the new public key, all in one database transaction. If that fails, the old key file is put back and nothing changes. For the worker, use `worker` in both places.

The retired key file is handled differently in each container, and both leave a file that still opens backups made before the rotation until it is gone.

- **Worker.** The command deletes the retired file itself. If it cannot, it prints the file's name and tells you to remove it by hand.
- **Api.** The command keeps the retired file, because the running api still seals Power BI tokens with the old identity until it restarts. The command also queues the job `rekey_tokens`, and the restarted api queues it again at start while a retired file is on disk. The job seals every stored token again with the new identity and deletes the retired file once no token needs it. If the delete fails, the job fails and prints nothing to your terminal. The failure is in the job's row in `job_request` (`status` is `failed`, `error` holds the message) and in the api's log as a `job finished` line with `status` `failed`. This version has no admin page for jobs. The retired file is named `api.key.retired-<timestamp>`, in the identity volume beside `api.key`.

An identity set in `API_AGE_IDENTITY` or `WORKER_AGE_IDENTITY` is not replaced by the command. Make a new one yourself and change the variable.

A rotation does not change the secrets. If an identity leaked together with a dump, also issue new client secrets at Microsoft, Google or your provider, and enter them again.

Proved by:

- [`apps/api/src/services/secrets/rotate.test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/secrets/rotate.test.ts): `leaves every secret readable with the new identity and none with the old`, `puts the old key file back when re-encrypting fails`, `refuses to replace an identity the environment sets`
- [`apps/api/src/services/secrets/worker_rotation_security_test.ts`](https://github.com/enum-studio/powerbi-metrics-book/blob/main/apps/api/src/services/secrets/worker_rotation_security_test.ts): `are all it can see or change, and its rotation still succeeds end to end`

## When client secrets expire

An Entra client secret lives at most 24 months. When you enter one, enter the expiry date Entra shows:

```bash
pbmb admin secrets set powerbi_app_client_secret --expires 2027-06-30
```

```text
Value for powerbi_app_client_secret (not shown):
```

The value is typed at that prompt, never on the command line. To add or change only the date, press **Expiry date** on the secret in **Settings > Secrets**, or run `pbmb admin secrets expiry powerbi_app_client_secret 2027-06-30`: the value stays as it is. Thirty days before the date, and again seven days before, the admin section and `pbmb admin status` list the secret, and whoever manages secrets is warned in their own `/api/v1/me`. In `pbmb admin status`:

```text
 secrets_expiring  []
```

The list is empty when nothing is within 30 days. A secret for Microsoft or a sign-in provider that has no expiry date makes the security check fail. `pbmb admin check security` then exits 1. It prints a count, such as `1 of the security checklist's items fail. Each says what to change.`, and under it the sentence of each failing item, here `The app registration's client secret has no expiry date. Enter the date Entra shows, so you are warned before it expires.` With `--json`, every item is in the field `details.items`. [The checklist](/docs/security/checklist/#7-the-internet-facing-api-cannot-read-the-tenant-wide-credential) shows how to read it.

API keys expire too. They live at most 90 days, and the database refuses a longer one. See the last item on [the checklist](/docs/security/checklist/#12-credentials-expire-and-are-rotated).
