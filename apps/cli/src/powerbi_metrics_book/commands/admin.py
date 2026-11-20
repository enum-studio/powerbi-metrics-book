import getpass
import re
import sys
from contextlib import redirect_stdout
from datetime import datetime
from pathlib import Path
from typing import Annotated

import typer
import yaml
from rich.console import Console
from rich.text import Text

from powerbi_metrics_book.answers import (
    object_of,
    objects_in,
    plain,
    query_of,
    string_field,
    text_of,
    typed_value,
)
from powerbi_metrics_book.calls import show_done, show_list, show_object
from powerbi_metrics_book.client import ApiError, Json, api_path
from powerbi_metrics_book.commands.conventions import preview_apply, print_applied
from powerbi_metrics_book.conventions_file import (
    check_output_paths,
    read_conventions,
    write_conventions,
)
from powerbi_metrics_book.output import FAILED, JsonOption, open_session
from powerbi_metrics_book.pii_ref import PiiReference, parse_ref
from powerbi_metrics_book.tables import line, print_fields, print_table

app = typer.Typer(
    help="Administer the deployment: status, settings, secrets, roles, people, "
    "audit and book.yml. Needs the admin role.",
    no_args_is_help=True,
)
settings_app = typer.Typer(help="Read and change settings.", no_args_is_help=True)
secrets_app = typer.Typer(
    help="List secrets, set one, and save one's expiry date.", no_args_is_help=True
)
people_app = typer.Typer(
    help="List people and invite someone by email.", invoke_without_command=True
)
roles_app = typer.Typer(help="Who holds which role.", no_args_is_help=True)
pii_app = typer.Typer(help="Mark and review personal data rules.", no_args_is_help=True)
datasets_app = typer.Typer(help="Enable and disable datasets.", no_args_is_help=True)
app.add_typer(settings_app, name="settings")
app.add_typer(secrets_app, name="secrets")
app.add_typer(roles_app, name="roles")
app.add_typer(people_app, name="people")
app.add_typer(pii_app, name="pii")
app.add_typer(datasets_app, name="datasets")

SECRET_COLUMNS = [
    "name",
    "readers",
    "set",
    "hint",
    "set_by",
    "set_at",
    "expires_at",
    "check_status",
]
ROLE_COLUMNS = ["id", "role", "subject_kind", "subject", "provider", "granted_at"]
PEOPLE_COLUMNS = [
    "email",
    "status",
    "roles",
    "powerbi_connection",
    "sign_in_method",
    "last_seen_at",
]
AUDIT_COLUMNS = [
    "id",
    "at",
    "principal_id",
    "via",
    "action",
    "resource_kind",
    "resource_id",
    "decision",
]
# The one rule the CLI repeats from the api, its readersOf: a value typed in the wrong
# place must never reach a URL, and `openssl rand -hex` fits any looser pattern.
SECRET_NAME = re.compile(
    r"powerbi_app_client_secret|powerbi_scanner_client_secret|result_link_key"
    r"|resend_api_key|openai_api_key|gemini_api_key"
    r"|sign_in_[a-z0-9][a-z0-9_]*_client_secret"
)
PII_COLUMNS = ["kind", "table_name", "name", "pii", "columns", "datasets"]
DATASET_COLUMNS = ["name", "workspace_name", "enabled", "tables", "columns", "measures"]


def _parse_pii_ref(reference: str, measure: bool = False) -> PiiReference:
    try:
        return parse_ref(reference, measure)
    except ValueError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(FAILED) from error


@pii_app.command("list")
def pii_list(
    context: typer.Context,
    pii: Annotated[
        bool, typer.Option("--pii", help="Show rules marked as personal data.")
    ] = False,
    cleared: Annotated[
        bool, typer.Option("--cleared", help="Show cleared rules.")
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """List PII rules and their current dataset coverage."""
    if pii and cleared:
        raise typer.BadParameter("Choose either --pii or --cleared.")
    show_list(
        context,
        json_output,
        "/admin/pii/rules",
        "rules",
        PII_COLUMNS,
        "the PII rules",
        query=query_of(pii="true" if pii else "false" if cleared else None),
    )


def _set_pii_rule(
    context: typer.Context,
    reference: str,
    value: bool,
    note: str | None,
    measure: bool,
    json_output: bool,
) -> None:
    parsed = _parse_pii_ref(reference, measure)
    body: dict[str, Json] = {"kind": parsed.kind, "table": parsed.table, "pii": value}
    if parsed.name is not None:
        body["name"] = parsed.name
    if note is not None:
        body["note"] = note
    show_object(
        context,
        json_output,
        "PUT",
        "/admin/pii/rules",
        "the PII rule",
        body=body,
        render=_render_pii_coverage,
    )


def _render_pii_coverage(console: Console, answer: dict[str, Json]) -> None:
    columns = answer.get("columns", 0)
    measures = answer.get("measures", 0)
    datasets = answer.get("datasets", 0)
    console.print(
        f"Matched {columns} columns and {measures} measures in {datasets} datasets."
    )
    if columns == 0 and measures == 0:
        console.print(
            "Warning: this rule matches nothing yet; it will apply to a table or "
            "column of that name when one appears."
        )


@pii_app.command("mark")
def pii_mark(
    context: typer.Context,
    reference: Annotated[
        str,
        typer.Argument(help="Table[Column], 'Table Name'[Column], or a table name."),
    ],
    note: Annotated[
        str | None, typer.Option(help="Why this rule was reviewed.")
    ] = None,
    measure: Annotated[
        bool, typer.Option("--measure", help="Treat the bracketed name as a measure.")
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Mark a table, column or measure as personal data."""
    _set_pii_rule(context, reference, True, note, measure, json_output)


@pii_app.command("clear")
def pii_clear(
    context: typer.Context,
    reference: Annotated[
        str,
        typer.Argument(help="Table[Column], 'Table Name'[Column], or a table name."),
    ],
    note: Annotated[
        str | None, typer.Option(help="Why this rule was reviewed.")
    ] = None,
    measure: Annotated[
        bool, typer.Option("--measure", help="Treat the bracketed name as a measure.")
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Mark a reviewed table, column or measure as cleared."""
    _set_pii_rule(context, reference, False, note, measure, json_output)


@pii_app.command("remove")
def pii_remove(
    context: typer.Context,
    reference: Annotated[
        str, typer.Argument(help="The table, column or measure rule to remove.")
    ],
    measure: Annotated[
        bool, typer.Option("--measure", help="Treat the bracketed name as a measure.")
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Remove a PII rule by its table, column or measure reference."""
    parsed = _parse_pii_ref(reference, measure)
    with open_session(context, json_output) as session:
        rules = objects_in(session.client.get("/admin/pii/rules"), "rules")
        rule = next(
            (
                item
                for item in rules
                if item.get("kind") == parsed.kind
                and item.get("table_name") == parsed.table
                and item.get("name") == parsed.name
            ),
            None,
        )
        if rule is None:
            typer.echo("No PII rule matches that reference.", err=True)
            raise typer.Exit(FAILED)
        rule_id = text_of(rule.get("id"))
        session.client.request(
            "DELETE",
            api_path("admin", "pii", "rules", rule_id),
            query={"expected_version": text_of(rule.get("version"))},
        )
        session.emit(
            {"id": rule_id, "removed": True},
            lambda console: console.print(f"Removed PII rule {rule_id}."),
        )


@pii_app.command("suggest")
def pii_suggest(
    context: typer.Context,
    dataset: Annotated[
        str | None, typer.Option(help="Only suggest columns in this dataset.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Suggest columns that may contain personal data."""
    show_list(
        context,
        json_output,
        "/admin/pii/suggestions",
        "suggestions",
        ["dataset_name", "table_name", "column_name", "matched"],
        "the suggestions",
        query=query_of(dataset=dataset),
    )


@datasets_app.command("list")
def admin_datasets_list(
    context: typer.Context,
    off: Annotated[bool, typer.Option("--off", help="Show disabled datasets.")] = False,
    json_output: JsonOption = False,
) -> None:
    """List datasets, optionally showing disabled ones only."""
    with open_session(context, json_output) as session:
        answer = object_of(session.client.get("/admin/datasets"), "the datasets")
        datasets = objects_in(answer, "datasets")
        if off:
            answer["datasets"] = [
                dataset for dataset in datasets if dataset.get("enabled") is False
            ]
        session.emit(
            answer,
            lambda console: print_table(
                console, objects_in(answer, "datasets"), DATASET_COLUMNS
            ),
        )


def _set_dataset(
    context: typer.Context, dataset: str, enabled: bool, json_output: bool
) -> None:
    show_object(
        context,
        json_output,
        "PUT",
        api_path("admin", "datasets", dataset),
        "the dataset",
        body={"enabled": enabled},
    )


@datasets_app.command("on")
def admin_datasets_on(
    context: typer.Context,
    dataset: Annotated[str, typer.Argument(help="Dataset name or id.")],
    json_output: JsonOption = False,
) -> None:
    """Enable a dataset for queries."""
    _set_dataset(context, dataset, True, json_output)


@datasets_app.command("off")
def admin_datasets_off(
    context: typer.Context,
    dataset: Annotated[str, typer.Argument(help="Dataset name or id.")],
    json_output: JsonOption = False,
) -> None:
    """Disable a dataset for queries."""
    _set_dataset(context, dataset, False, json_output)


@app.command("status")
def status(context: typer.Context, json_output: JsonOption = False) -> None:
    """Show what needs an admin: the last sync, failing checks, expiring secrets."""
    show_object(context, json_output, "GET", "/admin/status", "the status")


@settings_app.command("get")
def settings_get(
    context: typer.Context,
    key: Annotated[
        str | None,
        typer.Argument(help="A setting such as results.ttl_hours. Omit it to list."),
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Show a setting: its value, where the value comes from and its last check.

    Without a key, shows only the values this deployment has saved, from its
    export: a setting still at its default, or set by an environment variable,
    is not listed. Never a secret.
    """
    if key is not None:
        show_object(
            context,
            json_output,
            "GET",
            api_path("admin", "settings", key),
            "the setting",
        )
        return
    with open_session(context, json_output) as session:
        exported = object_of(session.client.get("/admin/export"), "the export")
        saved = object_of(yaml.safe_load(text_of(exported.get("yaml"))), "book.yml")
        listing = object_of(saved.get("settings") or {}, "the settings")
        session.emit(
            {"settings": listing}, lambda console: print_fields(console, listing)
        )


@settings_app.command("set")
def settings_set(
    context: typer.Context,
    key: Annotated[str, typer.Argument(help="A setting such as results.ttl_hours.")],
    value: Annotated[
        str,
        typer.Argument(
            help='The new value: JSON (48, true, ["a"]) or, when it is not JSON, text.'
        ),
    ],
    save_failing: Annotated[
        bool,
        typer.Option("--save-failing", help="Save the value although its check fails."),
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Change a setting. The api checks the value first and says what is wrong.

    Secrets are not settings: use `pbmb admin secrets set`.
    """
    show_object(
        context,
        json_output,
        "PUT",
        api_path("admin", "settings", key),
        "the setting",
        body={"value": typed_value(value), "save_failing": save_failing},
    )


@secrets_app.command("list")
def secrets_list(context: typer.Context, json_output: JsonOption = False) -> None:
    """List the secrets: whether each is set, who set it, when it expires.

    Never shows a value; once saved, a secret is write-only.
    """
    show_list(
        context, json_output, "/admin/secrets", "secrets", SECRET_COLUMNS, "the secrets"
    )


def _has_terminal() -> bool:
    return sys.stdin.isatty()


def _refuse(sentence: str) -> typer.Exit:
    typer.echo(sentence, err=True)
    return typer.Exit(2)


# Without this the parser prints a word starting with -- as an unknown option, and
# that word may be a value typed in the wrong place. The commands refuse it instead.
TAKES_ANY_WORD = {"ignore_unknown_options": True}


def _refuse_what_is_no_secret_name(name: str, value: list[str] | None) -> None:
    """A value typed in the wrong place stops here, before it reaches a URL or a log."""
    if value:
        raise _refuse(
            "A secret's value is only read from a prompt, never from the command "
            "line. Run `pbmb admin secrets set <name>` on its own."
        )
    if not SECRET_NAME.fullmatch(name):
        raise _refuse(
            "That is not the name of a secret, and nothing was sent. "
            "See the names with `pbmb admin secrets list`."
        )


def _end_of_day(day: str, param_hint: str) -> str:
    """A person's date as the moment the api stores: the last second of that day."""
    try:
        return f"{datetime.strptime(day, '%Y-%m-%d').date()}T23:59:59Z"
    except ValueError as error:
        raise typer.BadParameter(
            "Write the day as YYYY-MM-DD.", param_hint=param_hint
        ) from error


@secrets_app.command("set", context_settings=TAKES_ANY_WORD)
def secrets_set(
    context: typer.Context,
    name: Annotated[str, typer.Argument(help="The secret's name.")],
    value: Annotated[list[str] | None, typer.Argument(hidden=True)] = None,
    expires: Annotated[
        str | None,
        typer.Option(help="The day the secret expires, YYYY-MM-DD, as Entra shows it."),
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Set a secret. The value is typed at a prompt, with no echo.

    Values are only read from the prompt, never from the command line, so a
    value cannot land in shell history or in an agent's transcript. It needs a
    terminal. Once saved it is encrypted for the containers that read it and
    nothing can show it again.
    """
    _refuse_what_is_no_secret_name(name, value)
    if not _has_terminal():
        raise _refuse(
            "Secrets are only read from a prompt, and this is not a terminal. "
            f"Run `pbmb admin secrets set {name}` in a terminal."
        )
    expires_at = None if expires is None else _end_of_day(expires, "--expires")
    entered = getpass.getpass(f"Value for {name} (not shown): ")
    if not entered:
        typer.echo("No value entered; nothing was saved.", err=True)
        raise typer.Exit(FAILED)
    show_object(
        context,
        json_output,
        "PUT",
        api_path("admin", "secrets", name),
        "the secret",
        body={"value": entered, "expires_at": expires_at},
    )


@secrets_app.command("expiry", context_settings=TAKES_ANY_WORD)
def secrets_expiry(
    context: typer.Context,
    name: Annotated[str, typer.Argument(help="The secret's name.")],
    day: Annotated[
        str,
        typer.Argument(help="The day it expires, YYYY-MM-DD, as Entra shows it."),
    ],
    value: Annotated[list[str] | None, typer.Argument(hidden=True)] = None,
    json_output: JsonOption = False,
) -> None:
    """Save the day a secret expires. The value stays as it is.

    For a secret already saved: Entra shows a value once, so a person who comes
    back with the date no longer has the value to enter again. The status page
    and `pbmb admin status` warn 30 and 7 days before the day.
    """
    _refuse_what_is_no_secret_name(name, value)
    show_object(
        context,
        json_output,
        "PUT",
        api_path("admin", "secrets", name, "expiry"),
        "the secret",
        body={"expires_at": _end_of_day(day, "DAY")},
    )


def _print_check(console: Console, answer: dict[str, Json]) -> None:
    """The status and message, then the sentence of each checklist item that fails."""
    print_fields(console, {k: v for k, v in answer.items() if k != "details"})
    details = answer.get("details")
    items = details.get("items") if isinstance(details, dict) else None
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict) and item.get("status") == "failing":
            line(console, f"  - {text_of(item.get('sentence'))}")


@app.command("check")
def check(
    context: typer.Context,
    name: Annotated[
        str, typer.Argument(help="The check, such as scanner or app_registration.")
    ],
    json_output: JsonOption = False,
) -> None:
    """Run one of the deployment's checks against the real service.

    Prints passing or failing and why, and under it each checklist item that
    fails, as the security check has. --json adds the check's details. Exits 1
    when it fails, so a script can wait on it.
    """
    answer = show_object(
        context,
        json_output,
        "POST",
        api_path("admin", "checks", name),
        "the check",
        render=_print_check,
    )
    if answer.get("status") != "passing":
        raise typer.Exit(FAILED)


@roles_app.command("list")
def roles_list(context: typer.Context, json_output: JsonOption = False) -> None:
    """List who holds which role."""
    show_list(context, json_output, "/admin/roles", "roles", ROLE_COLUMNS, "the roles")


@roles_app.command("assign")
def roles_assign(
    context: typer.Context,
    role: Annotated[
        str,
        typer.Argument(help="viewer, curator, admin, pii_reader or your own."),
    ],
    person: Annotated[
        str | None, typer.Option(help="A person, by email address.")
    ] = None,
    domain: Annotated[
        str | None, typer.Option(help="Everyone at an email domain.")
    ] = None,
    group: Annotated[
        str | None,
        typer.Option(help="A group, by the id the sign-in provider puts in the token."),
    ] = None,
    provider: Annotated[
        str, typer.Option(help="The sign-in provider the group belongs to.")
    ] = "microsoft",
    custom: Annotated[
        bool,
        typer.Option(
            "--custom", help="The role is one your own Cerbos policies define."
        ),
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Give a role to a person, an email domain or a group. Give exactly one."""
    given = {
        kind: subject
        for kind, subject in (
            ("person", person),
            ("email_domain", domain),
            ("group", group),
        )
        if subject is not None
    }
    if len(given) != 1:
        raise typer.BadParameter("Give exactly one of --person, --domain or --group.")
    [(subject_kind, subject)] = given.items()
    body: dict[str, Json] = {
        "role": role,
        "subject_kind": subject_kind,
        "subject": subject,
    }
    if subject_kind == "group":
        body["provider"] = provider
    if custom:
        body["custom"] = True
    show_object(context, json_output, "POST", "/admin/roles", "the role", body=body)


@roles_app.command("revoke")
def roles_revoke(
    context: typer.Context,
    assignment_id: Annotated[
        str,
        typer.Argument(metavar="ID", help="The assignment's id, from `roles list`."),
    ],
    json_output: JsonOption = False,
) -> None:
    """Take a role assignment away. The last admin cannot be revoked."""
    show_done(
        context,
        json_output,
        "DELETE",
        api_path("admin", "roles", assignment_id),
        {"id": assignment_id, "revoked": True},
        f"Revoked {assignment_id}.",
    )


@people_app.callback()
def people(context: typer.Context, json_output: JsonOption = False) -> None:
    """List the people who have signed in, their roles and Power BI connection."""
    if context.invoked_subcommand is not None:
        return
    with open_session(context, json_output) as session:
        answer = object_of(session.client.get("/admin/people"), "the people")
        rows: list[dict[str, Json]] = [
            {
                **person,
                "roles": [text_of(r.get("role")) for r in objects_in(person, "roles")],
            }
            for person in objects_in(answer, "people")
        ]
        session.emit(answer, lambda console: print_table(console, rows, PEOPLE_COLUMNS))


@people_app.command("invite")
def people_invite(
    context: typer.Context,
    emails: Annotated[list[str], typer.Argument(help="The email addresses to invite.")],
    role: Annotated[str, typer.Option(help="The role to give these emails.")],
    link: Annotated[
        bool, typer.Option("--link", help="Print each invite link once.")
    ] = False,
    custom: Annotated[
        bool, typer.Option("--custom", help="Use a role your Cerbos policies define.")
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Invite people by email, or create links to share yourself."""
    body: dict[str, Json] = {
        "emails": list(emails),
        "role": role,
        "delivery": "link" if link else "email",
    }
    if custom:
        body["custom"] = True
    with open_session(context, json_output) as session:
        answer = object_of(
            session.client.request("POST", "/admin/people/invites", body=body),
            "the invites",
        )

        def render(console: Console) -> None:
            for invite in objects_in(answer, "invites"):
                line(console, f"Invited {string_field(invite, 'email')}.")
                if invite.get("link") is not None:
                    console.print(
                        Text(plain(string_field(invite, "link"))), soft_wrap=True
                    )

        session.emit(answer, render)


@people_app.command("invites")
def people_invites(context: typer.Context, json_output: JsonOption = False) -> None:
    """List pending and expired invites."""
    show_list(
        context,
        json_output,
        "/admin/people/invites",
        "invites",
        ["email", "role", "delivery", "expires_at", "expired"],
        "the invites",
    )


def _people_request(
    context: typer.Context,
    json_output: bool,
    email: str,
    method: str,
    action: str | None,
    done: str,
    *,
    invites: bool = False,
    body: Json = None,
) -> None:
    with open_session(context, json_output) as session:
        path = "/admin/people/invites" if invites else "/admin/people"
        key = "invites" if invites else "people"
        answer = object_of(session.client.get(path), f"the {key}")
        matches = [
            item
            for item in objects_in(answer, key)
            if string_field(item, "email").casefold() == email.casefold()
        ]
        if not matches:
            raise ApiError("not_found", f"No {key} found for {plain(email)}.", 404)
        identifier = string_field(matches[0], "id")
        segments = ["admin", "people", *(["invites"] if invites else []), identifier]
        if action is not None:
            segments.append(action)
        result = session.client.request(method, api_path(*segments), body=body)
        if result is None:
            session.emit(
                {"email": email, "done": True},
                lambda console: console.print(Text(plain(done))),
            )
            return

        def render(console: Console) -> None:
            answer = object_of(result, "the answer")
            if action == "resend":
                line(console, done)
                if answer.get("link") is not None:
                    console.print(
                        Text(plain(string_field(answer, "link"))), soft_wrap=True
                    )
            else:
                print_fields(console, answer)

        session.emit(result, render)


@people_app.command("resend")
def people_resend(
    context: typer.Context,
    email: str,
    json_output: JsonOption = False,
) -> None:
    """Resend an invite, showing a replacement link for link delivery."""
    _people_request(
        context,
        json_output,
        email,
        "POST",
        "resend",
        f"Resent the invite to {email}.",
        invites=True,
    )


@people_app.command("revoke-invite")
def people_revoke_invite(
    context: typer.Context,
    email: str,
    json_output: JsonOption = False,
) -> None:
    """Revoke the invite for an email address."""
    _people_request(
        context,
        json_output,
        email,
        "DELETE",
        None,
        f"Revoked the invite to {email}.",
        invites=True,
    )


@people_app.command("role")
def people_role(
    context: typer.Context,
    email: str,
    role: Annotated[str, typer.Argument(help="viewer, curator or admin.")],
    json_output: JsonOption = False,
) -> None:
    """Change a person's direct role."""
    _people_request(
        context,
        json_output,
        email,
        "PUT",
        "role",
        f"{email} is now {role}.",
        body={"role": role},
    )


@people_app.command("deactivate")
def people_deactivate(
    context: typer.Context,
    email: str,
    json_output: JsonOption = False,
) -> None:
    """Deactivate a person and revoke their access."""
    _people_request(
        context, json_output, email, "POST", "deactivate", f"Deactivated {email}."
    )


@people_app.command("reactivate")
def people_reactivate(
    context: typer.Context,
    email: str,
    json_output: JsonOption = False,
) -> None:
    """Reactivate a person so they can sign in again."""
    _people_request(
        context, json_output, email, "POST", "reactivate", f"Reactivated {email}."
    )


@people_app.command("delete")
def people_delete(
    context: typer.Context,
    email: str,
    json_output: JsonOption = False,
) -> None:
    """Delete a person after you type their email address again."""
    with redirect_stdout(sys.stderr):
        confirmation = typer.prompt(
            "Type the email again to delete this person", err=True
        )
    if confirmation.strip().casefold() != email.casefold():
        raise _refuse("The email did not match. No person was deleted.")
    _people_request(context, json_output, email, "DELETE", None, f"Deleted {email}.")


@app.command("audit")
def audit(
    context: typer.Context,
    since: Annotated[
        str | None,
        typer.Option(help="Only after this timestamp, such as 2026-10-01T00:00:00Z."),
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Show the audit log, newest first: who did what, through which channel."""
    show_list(
        context,
        json_output,
        "/admin/audit",
        "events",
        AUDIT_COLUMNS,
        "the audit",
        query=query_of(since=since),
    )


@app.command("export")
def export(
    context: typer.Context,
    output: Annotated[
        Path | None,
        typer.Option(
            "-o",
            "--output",
            dir_okay=False,
            help="Write book.yml here. Without it the YAML is printed.",
        ),
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Export settings, roles and service accounts as book.yml, with the company
    conventions in conventions.yml beside the output file. These files never hold
    a secret or a key, so they can go in git."""
    with open_session(context, json_output) as session:
        answer = object_of(session.client.get("/admin/export"), "the export")
        yaml_text = text_of(answer.get("yaml"))
        company = object_of(
            session.client.get("/conventions/company"), "the company part"
        )
        answer = {**answer, "yaml": yaml_text, "conventions": company}
        if output is not None:
            try:
                check_output_paths({}, output)
                check_output_paths(company, output.parent / "conventions.yml")
                output.write_text(yaml_text, encoding="utf-8")
                write_conventions(company, output.parent / "conventions.yml")
            except OSError as error:
                typer.echo(f"Cannot write {output}: {error.strerror}.", err=True)
                raise typer.Exit(FAILED) from error
            session.emit(
                {"path": str(output)},
                lambda console: console.print(Text(f"Wrote {output}.")),
            )
        elif session.as_json:
            session.emit(answer, lambda console: None)
        else:
            typer.echo(plain(yaml_text), nl=False)


@app.command("import")
def import_book(
    context: typer.Context,
    file: Annotated[
        Path, typer.Argument(exists=True, dir_okay=False, help="A book.yml.")
    ],
    yes: Annotated[
        bool, typer.Option("--yes", help="Apply without asking after the difference.")
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Apply a book.yml: show what would change, ask, then make the changes.

    With --json and no --yes, prints the difference and changes nothing.
    """
    yaml_text = file.read_text(encoding="utf-8")
    conventions_path = file.parent / "conventions.yml"
    company = None
    if conventions_path.exists():
        try:
            book = yaml.safe_load(yaml_text)
        except yaml.YAMLError as error:
            raise typer.BadParameter(f"{file}: {error}") from error
        if isinstance(book, dict) and "conventions" in book:
            raise typer.BadParameter(
                f"{file} has conventions: and {conventions_path} exists; "
                "keep only one source."
            )
        company = read_conventions(conventions_path)
    with open_session(context, json_output) as session:
        difference = object_of(
            session.client.request(
                "POST", "/admin/import", body={"yaml": yaml_text, "apply": False}
            ),
            "the difference",
        )
        conventions_changes: list[Json] = []
        if company is not None:
            preview, conventions_changes = preview_apply(session, company)
            difference["conventions"] = preview
            if not session.as_json:
                line(Console(), "Conventions:")
                print_applied(Console(), preview, company, conventions_changes, True)
        if session.as_json and not yes:
            session.emit(difference, lambda console: None)
            return
        if not session.as_json:
            line(Console(), "Book:")
            _show_difference(Console(), difference)
        if not objects_in(difference, "changes") and not conventions_changes:
            if not session.as_json:
                line(Console(), "Nothing to change: the deployment already matches.")
            return
        if not yes:
            typer.confirm("Apply these changes?", abort=True)
        applied = object_of(
            session.client.request(
                "POST", "/admin/import", body={"yaml": yaml_text, "apply": True}
            ),
            "the result",
        )
        if company is not None and conventions_changes:
            applied["conventions"] = session.client.request(
                "POST",
                "/conventions/apply",
                body={"conventions": company, "dry_run": False},
            )
        session.emit(applied, lambda console: console.print(Text("Applied.")))


def _show_difference(console: Console, difference: dict[str, Json]) -> None:
    changes = objects_in(difference, "changes")
    if not changes:
        line(console, "No change.")
        return
    print_table(console, changes, ["path", "before", "after"])
