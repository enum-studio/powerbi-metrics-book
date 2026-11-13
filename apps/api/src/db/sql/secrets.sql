-- Row level security on the secrets tables, so the worker can rotate its own
-- identity without being able to touch the api's. Grants (src/db/schema/
-- secrets.ts) say which commands a role may run; these policies say on which
-- rows. The migrator owns the tables and is not subject to them. Runs on
-- every start: enabling is idempotent, and each policy is dropped first.

alter table secret_ciphertext enable row level security;

-- The api writes every reader's ciphertext when an admin saves a secret.
drop policy if exists secret_ciphertext_api on secret_ciphertext;
create policy secret_ciphertext_api on secret_ciphertext
  to api_rw using (true) with check (true);

-- The worker sees and re-encrypts only its own rows.
drop policy if exists secret_ciphertext_worker_select on secret_ciphertext;
create policy secret_ciphertext_worker_select on secret_ciphertext
  for select to worker_rw using (reader = 'worker');

drop policy if exists secret_ciphertext_worker_update on secret_ciphertext;
create policy secret_ciphertext_worker_update on secret_ciphertext
  for update to worker_rw using (reader = 'worker') with check (reader = 'worker');

alter table container_identity enable row level security;

-- Recipients are public keys: both roles read all of them.
drop policy if exists container_identity_select on container_identity;
create policy container_identity_select on container_identity
  for select to api_rw, worker_rw using (true);

-- The api is not held to its own row: it handles in clear every value it
-- encrypts for the worker, so a forged worker recipient would gain it nothing.
drop policy if exists container_identity_api on container_identity;
create policy container_identity_api on container_identity
  to api_rw using (true) with check (true);

-- The worker publishes and retires only its own.
drop policy if exists container_identity_worker_insert on container_identity;
create policy container_identity_worker_insert on container_identity
  for insert to worker_rw with check (container = 'worker');

drop policy if exists container_identity_worker_update on container_identity;
create policy container_identity_worker_update on container_identity
  for update to worker_rw using (container = 'worker') with check (container = 'worker');
