import httpx
from cli_support import Serve, json_response
from commands_support import run, sent


def test_documentation_fields_round_trip_without_local_choice_rules(
    serve: Serve,
) -> None:
    seen = serve(
        lambda request: json_response(
            200,
            {
                "name": "orders",
                "failing_checks": [],
                "base_variants": [],
                "other_variants": [],
                "terms": [],
            },
        )
    )
    result = run(
        "metrics",
        "update",
        "orders",
        "--tier",
        "custom_tier",
        "--importance",
        "high",
        "--importance-why",
        "Daily demand",
        "--direction",
        "higher_is_better",
        "--use-for",
        "Plan capacity",
        "--dont-use-for",
        "Profit",
        "--decisions",
        "Staff the warehouse",
        "--actions",
        "Check demand",
        "--owner-team",
        "Operations",
        "--primary-dimensions",
        "Channel",
        "--primary-dimensions",
        "Region",
        "--building-block",
        "--json",
    )
    assert result.exit_code == 0, result.output
    body = sent(seen[-1])
    assert body["tier"] == "custom_tier"
    assert body["primary_dimensions"] == ["Channel", "Region"]
    assert body["building_block"] is True
    assert body["dont_use_for"] == "Profit"


def test_owner_follow_and_relationship_routes(serve: Serve) -> None:
    seen = serve(lambda request: json_response(200, {"following": True}))
    assert run("metrics", "follow", "orders", "--json").exit_code == 0
    assert seen[-1].url.path == "/api/v1/metrics/orders/follow"
    assert sent(seen[-1]) == {"following": True}
    assert (
        run(
            "metrics", "link", "orders", "sales", "same", "More demand", "--json"
        ).exit_code
        == 0
    )
    assert sent(seen[-1])["movement"] == "same"
    assert (
        run(
            "metrics", "owner", "set", "orders", "analyst@sample.example", "--json"
        ).exit_code
        == 0
    )
    assert sent(seen[-1]) == {"email": "analyst@sample.example"}


def test_upgrade_uses_the_server_and_reports_review_drafts(serve: Serve) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/api/v1/conventions/upgrade"
        return json_response(
            200, {"updated": ["orders"], "note": "Review these drafts."}
        )

    serve(answer)
    result = run("conventions", "upgrade", "--json")
    assert result.exit_code == 0
    assert '"orders"' in result.output
