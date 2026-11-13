from typing import Annotated

import typer

from powerbi_metrics_book.answers import object_of, objects_in, plain, string_field
from powerbi_metrics_book.calls import (
    show_done,
    show_list,
    show_object,
)
from powerbi_metrics_book.client import ApiError, Json, api_path
from powerbi_metrics_book.output import JsonOption, open_session

app = typer.Typer(
    help="Service accounts: named identities for scripts and agents, each with "
    "its own keys. Needs the admin role.",
    no_args_is_help=True,
)
keys_app = typer.Typer(help="A service account's API keys.", no_args_is_help=True)
app.add_typer(keys_app, name="keys")

ACCOUNT_COLUMNS = [
    "name",
    "owner_email",
    "roles",
    "workspace_ids",
    "app_ids",
    "max_key_age_days",
    "disabled_at",
]
KEY_COLUMNS = ["id", "prefix", "created_at", "expires_at", "last_used_at", "revoked_at"]
NAME = Annotated[str, typer.Argument(help="The service account's name.")]


@app.command("create")
def create(
    context: typer.Context,
    name: NAME,
    owner: Annotated[
        str, typer.Option(help="The email address of the person answerable for it.")
    ],
    role: Annotated[
        list[str], typer.Option(help="A role it holds. Repeat for more than one.")
    ],
    workspace: Annotated[
        list[str] | None,
        typer.Option(help="Limit it to this workspace id. Repeat for more."),
    ] = None,
    app_id: Annotated[
        list[str] | None,
        typer.Option("--app", help="Limit it to this app id. Repeat for more."),
    ] = None,
    max_key_age_days: Annotated[
        int | None, typer.Option(help="The longest any of its keys may live, in days.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Create a service account. It has no key until you run `sa keys create`."""
    body: dict[str, Json] = {"name": name, "owner_email": owner, "roles": [*role]}
    if workspace:
        body["workspace_ids"] = [*workspace]
    if app_id:
        body["app_ids"] = [*app_id]
    if max_key_age_days is not None:
        body["max_key_age_days"] = max_key_age_days
    show_object(
        context,
        json_output,
        "POST",
        "/admin/service-accounts",
        "the service account",
        body=body,
    )


@app.command("list")
def list_accounts(context: typer.Context, json_output: JsonOption = False) -> None:
    """List the service accounts."""
    show_list(
        context,
        json_output,
        "/admin/service-accounts",
        "service_accounts",
        ACCOUNT_COLUMNS,
        "the service accounts",
    )


@app.command("disable")
def disable(
    context: typer.Context, name: NAME, json_output: JsonOption = False
) -> None:
    """Disable a service account. Its keys stop working at once."""
    show_object(
        context,
        json_output,
        "PATCH",
        api_path("admin", "service-accounts", name),
        "the service account",
        body={"disabled": True},
    )


@app.command("delete")
def delete(context: typer.Context, name: NAME, json_output: JsonOption = False) -> None:
    """Delete a service account and its keys."""
    show_done(
        context,
        json_output,
        "DELETE",
        api_path("admin", "service-accounts", name),
        {"name": name, "deleted": True},
        f"Deleted {name}.",
    )


@keys_app.command("create")
def keys_create(
    context: typer.Context,
    name: NAME,
    expires_in_days: Annotated[
        int | None,
        typer.Option(
            help="Days until the key expires. Default: the account's longest "
            "allowed key age."
        ),
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """Create an API key for a service account.

    The key is printed once and cannot be shown again; the api keeps only a
    digest. Run this yourself and put the key where the script reads it, such
    as PBMB_API_KEY. Never paste it into a chat.
    """
    with open_session(context, json_output) as session:
        if expires_in_days is None:
            accounts = objects_in(
                session.client.get("/admin/service-accounts"), "service_accounts"
            )
            found = [account for account in accounts if account.get("name") == name]
            limit = found[0].get("max_key_age_days") if found else None
            if not isinstance(limit, int):
                raise ApiError(
                    "not_found",
                    f"No service account named {name} says how long its keys may live.",
                    404,
                )
            expires_in_days = limit
        key = object_of(
            session.client.request(
                "POST",
                api_path("admin", "service-accounts", name, "keys"),
                body={"expires_in_days": expires_in_days},
            ),
            "the key",
        )
        secret = string_field(key, "key")
        if session.as_json:
            session.emit(key, lambda console: None)
            return
        typer.echo(
            plain(
                f"Key {key.get('id')} for {name} expires {key.get('expires_at')}. "
                "It will not be shown again: store it now."
            ),
            err=True,
        )
        typer.echo(plain(secret))


@keys_app.command("list")
def keys_list(
    context: typer.Context, name: NAME, json_output: JsonOption = False
) -> None:
    """List a service account's keys: when each was made, expires and was last used.

    The keys themselves are never shown, only their first characters.
    """
    show_list(
        context,
        json_output,
        api_path("admin", "service-accounts", name, "keys"),
        "keys",
        KEY_COLUMNS,
        "the keys",
    )


@keys_app.command("revoke")
def keys_revoke(
    context: typer.Context,
    name: NAME,
    key_id: Annotated[
        str, typer.Argument(metavar="KEY_ID", help="The key's id, from `keys list`.")
    ],
    json_output: JsonOption = False,
) -> None:
    """Revoke a key. It stops working at once."""
    show_done(
        context,
        json_output,
        "DELETE",
        api_path("admin", "service-accounts", name, "keys", key_id),
        {"name": name, "key_id": key_id, "revoked": True},
        f"Revoked key {key_id}.",
    )
