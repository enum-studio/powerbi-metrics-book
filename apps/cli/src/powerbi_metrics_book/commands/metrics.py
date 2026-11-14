from typing import Annotated

import typer
from rich.console import Console

from powerbi_metrics_book.answers import (
    Custom,
    custom_fields,
    custom_filters,
    dig,
    list_or_none,
    object_of,
    objects_in,
    objects_of,
    one_line,
    query_of,
    string_field,
    text_or_none,
)
from powerbi_metrics_book.calls import every_metric, show_done, show_object
from powerbi_metrics_book.client import Json, Query, api_path
from powerbi_metrics_book.output import JsonOption, open_session
from powerbi_metrics_book.tables import line, print_fields, print_table, render_page

app = typer.Typer(
    help="Read and curate the book's metrics: list, show, create, change, "
    "check and verify them."
)

LIST_COLUMNS = ["name", "label", "trust_state", "unit", "category.path"]
HISTORY_COLUMNS = ["at", "principal_kind", "principal_id", "via", "action"]
VARIANT_COLUMNS = [
    "id",
    "dataset.name",
    "workspace.name",
    "measure.name",
    "measure_reference",
    "period",
    "reads_selection",
    "selection_columns",
]
SHIFT_COLUMNS = [
    "shift.period",
    "shift.comparison",
    "shift.comparison_period",
    "shift.currency",
    "shift.custom_axes",
    "count",
]

Name = Annotated[
    str, typer.Argument(help="The metric's key, such as number_of_orders.")
]
Definition = Annotated[str | None, typer.Option(help="What the metric measures.")]
Aliases = Annotated[
    str | None,
    typer.Option(help="Other names people search for, comma-separated, or `none`."),
]
WhenToUse = Annotated[
    str | None, typer.Option(help="When to use this metric rather than a similar one.")
]
NotTheSameAs = Annotated[
    str | None,
    typer.Option(help="How it differs from a metric it is mistaken for, or `none`."),
]
Grain = Annotated[
    str | None, typer.Option("--grain", help="The grain and the filters it applies.")
]
Unit = Annotated[str | None, typer.Option(help="Its unit, such as money or count.")]
Category = Annotated[
    str | None, typer.Option(help="The category's path, such as sales/orders.")
]
Owner = Annotated[str | None, typer.Option(help="Who answers for the metric.")]


def _check_sentence(check: dict[str, Json]) -> str:
    """A check's sentence, followed by the labels the answer gives."""
    sentence = one_line(check.get("message"))
    labels = check.get("other_labels")
    if not isinstance(labels, list) or not labels:
        return sentence
    named = "; ".join(one_line(label) for label in labels)
    return f"{sentence} Closest first: {named}."


def _show_metric(console: Console, metric: dict[str, Json]) -> None:
    line(
        console,
        f"{one_line(metric.get('name'))}: {one_line(metric.get('label'))} "
        f"({one_line(metric.get('trust_state'))})",
    )
    failing = objects_in(metric, "failing_checks")
    if failing:
        line(console, f"\nFailing checks ({len(failing)})")
        for failure in failing:
            line(
                console,
                f"  {one_line(failure.get('check'))}: {_check_sentence(failure)}",
            )
    else:
        line(console, "\nNo failing checks.")
    line(console, "")
    verified = metric.get("verified_by")
    print_fields(
        console,
        {
            "definition": metric.get("definition"),
            "aliases": metric.get("aliases"),
            "when_to_use": metric.get("when_to_use"),
            "not_the_same_as": metric.get("not_the_same_as"),
            "grain_and_filters": metric.get("grain_and_filters"),
            "unit": metric.get("unit"),
            "category": dig(metric, "category.path"),
            "owner": metric.get("owner"),
            "verified": None
            if verified is None
            else f"{one_line(verified)} at {one_line(metric.get('verified_at'))}",
            "origin": metric.get("origin"),
            "custom": metric.get("custom"),
            "terms": [
                one_line(term.get("name")) for term in objects_in(metric, "terms")
            ],
            **(
                {"open_questions": metric["open_questions"]}
                if "open_questions" in metric
                else {}
            ),
        },
    )
    line(console, "\nBase variants (use measure_reference in DAX against its dataset)")
    print_table(console, objects_in(metric, "base_variants"), VARIANT_COLUMNS)
    others = objects_in(metric, "other_variants")
    if others:
        line(console, "\nOther variants, by shift (`pbmb variants list <metric>`)")
        print_table(console, others, SHIFT_COLUMNS)
    for answer in (
        objects_in(metric, "accepted_answers") if "accepted_answers" in metric else []
    ):
        line(
            console,
            f"\nAnswered: {one_line(answer.get('question'))} "
            f"({_accepted_by(answer)})\n"
            f"  {one_line(answer.get('answer'))}",
        )


ACCEPTED_BY = {
    "asker": "accepted by the asker",
    "asker_own_reply": "the asker accepted their own reply",
    "curator": "accepted by a curator",
    "other": "accepted by someone else",
}


def _accepted_by(answer: dict[str, Json]) -> str:
    text = ACCEPTED_BY.get(str(answer.get("accepted_by_role")), "acceptor unknown")
    agent = (
        answer.get("accepted_by_kind") == "service_account"
        or answer.get("accepted_by_via") == "mcp"
    )
    return f"{text}, an agent" if agent else text


def _metric(
    context: typer.Context,
    json_output: bool,
    method: str,
    name: str,
    what: str,
    *,
    action: str | None = None,
    body: Json = None,
) -> None:
    segments = ("metrics", name) if action is None else ("metrics", name, action)
    show_object(
        context,
        json_output,
        method,
        api_path(*segments),
        what,
        body=body,
        render=_show_metric,
    )


def _fields(
    *,
    label: str | None,
    definition: str | None,
    aliases: str | None,
    when_to_use: str | None,
    not_the_same_as: str | None,
    grain: str | None,
    unit: str | None,
    category: str | None,
    owner: str | None,
    custom: list[str] | None,
) -> dict[str, Json]:
    given = {
        "label": label,
        "definition": definition,
        "when_to_use": when_to_use,
        "grain_and_filters": grain,
        "unit": unit,
        "category": category,
        "owner": owner,
    }
    body: dict[str, Json] = {
        name: value for name, value in given.items() if value is not None
    }
    if aliases is not None:
        body["aliases"] = list_or_none(aliases)
    if not_the_same_as is not None:
        body["not_the_same_as"] = text_or_none(not_the_same_as)
    if custom:
        body["custom"] = custom_fields(custom)
    return body


@app.command("list")
def list_metrics(
    context: typer.Context,
    category: Annotated[
        str | None, typer.Option(help="Only metrics in this category's path.")
    ] = None,
    trust_state: Annotated[
        list[str] | None,
        typer.Option(
            help="draft, agent_verified or human_verified; repeat for several."
        ),
    ] = None,
    unit: Annotated[
        str | None, typer.Option(help="Only metrics with this unit.")
    ] = None,
    dataset: Annotated[
        str | None, typer.Option(help="Only metrics with a variant in this dataset.")
    ] = None,
    workspace: Annotated[
        str | None, typer.Option(help="Only metrics with a variant in this workspace.")
    ] = None,
    app_name: Annotated[
        str | None,
        typer.Option("--app", help="Only metrics in this Power BI app's datasets."),
    ] = None,
    custom: Annotated[
        list[str] | None,
        typer.Option(help="Only metrics whose custom field matches, key=value."),
    ] = None,
    limit: Annotated[int | None, typer.Option(help="At most this many.")] = None,
    cursor: Annotated[
        str | None, typer.Option(help="The cursor the last page ended with.")
    ] = None,
    json_output: JsonOption = False,
) -> None:
    """List metrics A to Z by key, with the filters. Dismissed ones are left out.

    A page ends with a cursor when there are more; repeat the command with
    --cursor to read on.
    """
    query: Query = {
        **query_of(
            category=category,
            trust_states=",".join(trust_state) if trust_state else None,
            unit=unit,
            dataset=dataset,
            workspace=workspace,
            app=app_name,
            limit=limit,
            cursor=cursor,
        ),
        **custom_filters(custom),
    }
    show_object(
        context,
        json_output,
        "GET",
        "/metrics",
        "the metrics",
        query=query,
        render=render_page(LIST_COLUMNS),
    )


@app.command("show")
def show(context: typer.Context, name: Name, json_output: JsonOption = False) -> None:
    """Show a metric completely: failing checks first, then its fields, base
    variants per dataset (with the measure_reference to use in DAX), the count
    of its other variants by shift, terms and, when questions are on,
    accepted answers.

    Use a variant's DAX instead of writing your own: `pbmb variants show <id>`.
    """
    _metric(context, json_output, "GET", name, "the metric")


@app.command("create")
def create(
    context: typer.Context,
    name: Annotated[str, typer.Argument(help="The new metric's key.")],
    label: Annotated[str, typer.Option(help="Its name in words.")],
    definition: Definition = None,
    aliases: Aliases = None,
    when_to_use: WhenToUse = None,
    not_the_same_as: NotTheSameAs = None,
    grain: Grain = None,
    unit: Unit = None,
    category: Category = None,
    owner: Owner = None,
    custom: Custom = None,
    json_output: JsonOption = False,
) -> None:
    """Create a metric. The conventions decide which fields it needs: read them
    with `pbmb conventions show`, then run `pbmb metrics check <name>`."""
    body = _fields(
        label=label,
        definition=definition,
        aliases=aliases,
        when_to_use=when_to_use,
        not_the_same_as=not_the_same_as,
        grain=grain,
        unit=unit,
        category=category,
        owner=owner,
        custom=custom,
    )
    show_object(
        context,
        json_output,
        "POST",
        "/metrics",
        "the metric",
        body={"name": name, **body},
        render=_show_metric,
    )


@app.command("update")
def update(
    context: typer.Context,
    name: Name,
    label: Annotated[str | None, typer.Option(help="Its name in words.")] = None,
    definition: Definition = None,
    aliases: Aliases = None,
    when_to_use: WhenToUse = None,
    not_the_same_as: NotTheSameAs = None,
    grain: Grain = None,
    unit: Unit = None,
    category: Category = None,
    owner: Owner = None,
    custom: Custom = None,
    json_output: JsonOption = False,
) -> None:
    """Change the fields you name and leave the rest. A change by a token moves
    a verified metric back to draft or agent_verified; check it again."""
    body = _fields(
        label=label,
        definition=definition,
        aliases=aliases,
        when_to_use=when_to_use,
        not_the_same_as=not_the_same_as,
        grain=grain,
        unit=unit,
        category=category,
        owner=owner,
        custom=custom,
    )
    if not body:
        raise typer.BadParameter("Name at least one field to change, such as --label.")
    _metric(context, json_output, "PATCH", name, "the metric", body=body)


@app.command("rename")
def rename(
    context: typer.Context,
    name: Name,
    new_name: Annotated[str, typer.Argument(help="The new key.")],
    json_output: JsonOption = False,
) -> None:
    """Change a metric's key. Its old key stops working."""
    _metric(context, json_output, "PATCH", name, "the metric", body={"name": new_name})


@app.command("merge")
def merge(
    context: typer.Context,
    from_name: Annotated[str, typer.Argument(help="The metric to fold in.")],
    into: Annotated[str, typer.Option(help="The metric that keeps the variants.")],
    json_output: JsonOption = False,
) -> None:
    """Move every variant of one metric under another and delete the emptied one.

    Refused when the two have different units: they are different metrics.
    """
    _metric(
        context,
        json_output,
        "POST",
        into,
        "the metric",
        action="merge",
        body={"from": from_name},
    )


@app.command("dismiss")
def dismiss(
    context: typer.Context,
    name: Name,
    reason: Annotated[str, typer.Option(help="Why it is not a metric.")],
    json_output: JsonOption = False,
) -> None:
    """Dismiss a draft that is not a metric, such as a helper measure."""
    _metric(
        context,
        json_output,
        "POST",
        name,
        "the metric",
        action="dismiss",
        body={"reason": reason},
    )


@app.command("delete")
def delete(context: typer.Context, name: Name, json_output: JsonOption = False) -> None:
    """Delete a metric that has no variants. Merge it instead when it has."""
    show_done(
        context,
        json_output,
        "DELETE",
        api_path("metrics", name),
        {"deleted": name},
        f"Deleted the metric {name}.",
    )


@app.command("verify")
def verify(context: typer.Context, name: Name, json_output: JsonOption = False) -> None:
    """Mark a metric agent_verified. Refused while a check the conventions turn
    on fails; the sentence says which. A person approves it for
    human_verified: `pbmb metrics request-review`."""
    _metric(context, json_output, "POST", name, "the metric", action="verify")


@app.command("request-review")
def request_review(
    context: typer.Context, name: Name, json_output: JsonOption = False
) -> None:
    """Print the link where a person reviews and approves the metric.

    Approval (human_verified) is only possible in a browser, signed in as a
    curator. Give the person this link; do not try to approve it yourself.
    """
    with open_session(context, json_output) as session:
        found = object_of(session.client.get(api_path("metrics", name)), "the metric")
        key = string_field(found, "name")
        link = session.client.url + api_path(
            "review", "metrics", key, answered_by_api=True
        )
        document: dict[str, Json] = {
            "name": key,
            "review_url": link,
            "trust_state": found.get("trust_state"),
            "note": "A person must open this link in a browser and approve.",
        }
        session.emit(
            document,
            lambda console: line(
                console,
                f"A person must review {key}: open {link} in a browser and "
                f"approve it. It is {one_line(found.get('trust_state'))} until then.",
            ),
        )


@app.command("history")
def history(
    context: typer.Context, name: Name, json_output: JsonOption = False
) -> None:
    """List the changes made to a metric, newest first. --json has the before
    and after of each."""
    with open_session(context, json_output) as session:
        changes = session.client.get(api_path("metrics", name, "history"))
        session.emit(
            changes,
            lambda console: print_table(
                console, objects_of(changes, "the changes"), HISTORY_COLUMNS
            ),
        )


@app.command("check")
def check(
    context: typer.Context,
    name: Annotated[
        str | None, typer.Argument(help="The metric to check; or use --all.")
    ] = None,
    all_metrics: Annotated[
        bool, typer.Option("--all", help="Check every metric.")
    ] = False,
    json_output: JsonOption = False,
) -> None:
    """Run the conventions' checks. Exits 1 when any fails and says why.

    Prints each failing check with its sentence; a metric that passes is only
    counted. --json lists every check of every metric checked.
    """
    if (name is None) == (not all_metrics):
        raise typer.BadParameter("Give a metric name, or --all, not both.")
    with open_session(context, json_output) as session:
        names = (
            [string_field(item, "name") for item in every_metric(session.client)]
            if name is None
            else [name]
        )
        metrics: list[Json] = []
        failures: list[tuple[str, str, str]] = []
        for metric in names:
            answer = object_of(
                session.client.get(
                    api_path("metrics", metric, "checks", answered_by_api=name is None)
                ),
                "the checks",
            )
            metrics.append({"name": metric, "checks": answer.get("checks")})
            failures += [
                (
                    metric,
                    one_line(result.get("check")),
                    _check_sentence(result),
                )
                for result in objects_in(answer, "checks")
                if result.get("passed") is not True
            ]

        def render(console: Console) -> None:
            for metric, failed, sentence in failures:
                line(console, f"{one_line(metric)}: {failed}: {sentence}")
            if failures:
                line(console, f"{len(failures)} checks fail.")
            else:
                line(console, f"All checks pass on {len(names)} metrics.")

        session.emit({"metrics": metrics, "failing": len(failures)}, render)
    if failures:
        raise typer.Exit(1)
