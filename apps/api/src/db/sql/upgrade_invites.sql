-- Cleans up, once, the invites made before migration 0003. That migration
-- left last_sent_at null on each of them, and the app writes it on every
-- invite it makes or sends, so the cleanup touches only rows where it is
-- null, and the last statement sets it. A second start finds no null and
-- changes nothing.
--
-- The release before 0003 ended invites by setting used_at. The release
-- with 0003 and without 0004 turned each such end into accepted_at or
-- revoked_at at its start, and 0004 drops the column. So a deployment made
-- before 0003 starts once on that release before it takes 0004, and a start
-- with 0004 refuses until it has (src/db/migrate.ts). The table lock below
-- makes an invite and the role assignment the release before 0003 made with
-- it land wholly before or after this file.
--
-- Each invite this file ends is recorded as the app records an accept or a
-- revoke, by principal upgrade_invites.sql.
--
-- The statements go once a migration makes last_sent_at not null.

lock table invite in share row exclusive mode;

-- A Microsoft sign-in never ended an invite, and a default role or a group let
-- people in after their invite expired. An open invite whose email is already
-- a user's is accepted when that user holds its role by a person assignment,
-- and revoked otherwise.

with ended as (
  update invite
     set accepted_at = greatest("user".created_at, invite.created_at),
         accepted_user_id = "user".id
    from "user"
   where invite.last_sent_at is null
     and invite.accepted_at is null
     and invite.revoked_at is null
     and lower("user".email) = invite.email
     and exists (
       select from role_assignment
        where role_assignment.subject_kind = 'person'
          and role_assignment.subject = invite.email
          and role_assignment.role = invite.role
     )
  returning invite.email
)
insert into audit_event
  (principal_kind, principal_id, via, action, resource_kind, resource_id,
   decision, reason, detail)
select 'system', 'upgrade_invites.sql', 'migration', 'people.invite_accept',
       'person', email, 'allow',
       'An invite sent before 0003 to a user who holds its role by a person assignment.',
       jsonb_build_object('email', email)
  from ended;

with ended as (
  update invite
     set revoked_at = now()
   where last_sent_at is null
     and accepted_at is null
     and revoked_at is null
     and exists (select from "user" where lower("user".email) = invite.email)
  returning email
)
insert into audit_event
  (principal_kind, principal_id, via, action, resource_kind, resource_id,
   decision, reason, detail)
select 'system', 'upgrade_invites.sql', 'migration', 'admin.people.invite_revoke',
       'person', email, 'allow',
       'An invite sent before 0003 to a user who does not hold its role by a person assignment.',
       jsonb_build_object('email', email)
  from ended;

-- Sending such an invite assigned its role to the email at once, by the
-- inviter, in the transaction that saved it: the invite's created_at from the
-- app's clock, the assignment's granted_at from Postgres' now(). The window
-- finds that assignment as long as the two clocks were within 10 seconds of
-- each other. It goes while nobody has signed in as the email, the invite
-- open or not: an open invite admits its person on its own now. Each delete
-- is recorded as revokeRole records one. An admin assignment goes only when
-- another admin is left, and otherwise stays, with a notice.

do $$
declare
  admin boolean;
  gone_to text;
begin
  foreach admin in array array[false, true] loop
    begin
      with gone as (
        delete from role_assignment
         using invite
         where invite.last_sent_at is null
           and role_assignment.subject_kind = 'person'
           and role_assignment.subject = invite.email
           and role_assignment.role = invite.role
           and role_assignment.granted_by = invite.invited_by
           and role_assignment.granted_at
               between invite.created_at - interval '10 seconds'
                   and invite.created_at + interval '10 seconds'
           and (role_assignment.role = 'admin') = admin
           and not exists (
             select from "user" where lower("user".email) = invite.email
           )
        returning role_assignment.id, role_assignment.role,
                  role_assignment.subject
      ), recorded as (
        insert into audit_event
          (principal_kind, principal_id, via, action, resource_kind,
           resource_id, decision, reason, detail)
        select 'system', 'upgrade_invites.sql', 'migration', 'admin.role.revoke',
               'role_assignment', gone.id::text, 'allow',
               'An invite sent before 0003 assigned this role, and nobody has signed in as the email.',
               jsonb_build_object('role', gone.role, 'subject', gone.subject)
          from gone
      )
      select string_agg(subject, ', ' order by subject) into gone_to from gone;
      -- tenant.sql, which runs before this file, defines the function.
      if admin and gone_to is not null then
        if not deployment_has_admin() then
          raise exception using errcode = 'PB001';
        end if;
      end if;
    exception when sqlstate 'PB001' then
      raise notice 'upgrade_invites.sql kept the admin assignment to % that an invite made when it was sent, since no other admin is left. Make someone else an admin, then revoke it.', gone_to;
    end;
  end loop;
end $$;

update invite set last_sent_at = created_at where last_sent_at is null;
