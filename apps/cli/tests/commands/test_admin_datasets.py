import json

from cli_support import Serve, json_response
from commands_support import run, sent


def test_dataset_off_sends_disabled_state_and_json(serve: Serve) -> None:
    answer = {"id": "ds_1", "name": "Sales", "enabled": False}
    seen = serve(lambda request: json_response(200, answer))

    result = run("admin", "datasets", "off", "ds_1", "--json")

    assert result.exit_code == 0
    assert seen[0].url.path == "/api/v1/admin/datasets/ds_1"
    assert sent(seen[0]) == {"enabled": False}
    assert json.loads(result.stdout) == answer


def test_dataset_on_sends_enabled_state_and_json(serve: Serve) -> None:
    answer = {"id": "ds_1", "name": "Sales", "enabled": True}
    seen = serve(lambda request: json_response(200, answer))

    result = run("admin", "datasets", "on", "ds_1", "--json")

    assert result.exit_code == 0
    assert sent(seen[0]) == {"enabled": True}
    assert json.loads(result.stdout) == answer


def test_dataset_list_off_filters_disabled(serve: Serve) -> None:
    seen = serve(
        lambda request: json_response(
            200,
            {
                "datasets": [
                    {"name": "Sales", "enabled": True},
                    {"name": "Archive", "enabled": False},
                ]
            },
        )
    )

    result = run("admin", "datasets", "list", "--off", "--json")

    assert result.exit_code == 0
    assert seen[0].url.path == "/api/v1/admin/datasets"
    assert [item["name"] for item in json.loads(result.stdout)["datasets"]] == [
        "Archive"
    ]
