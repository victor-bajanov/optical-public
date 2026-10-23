# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27", "python-dateutil>=2.9", "pydantic>=2.7", "rich>=13.7"]
# ///
"""Guard for L7's deployment-stamp check on committed chunk events.

The worker stamps every event it creates with the private extended property
optical_deployment = the origin of its OAUTH_ISSUER (worker/src/providers/
deployment-scope.ts), so several deployments sharing one calendar never treat
each other's chunks as their own. L7 checks the chunks it just committed carry
the TARGET deployment's stamp. A deployment still on the pre-stamp code writes
none, which must pass so the harness keeps working against it.
_deployment_stamp_problem is the pure check; these tests pin its semantics.
Also pins that the Graph client reads the stamp back, so the check isn't
vacuous on a Microsoft-provider run.
"""
import importlib.util, pathlib, sys

_spec = importlib.util.spec_from_file_location(
    "regsmoke", pathlib.Path(__file__).parent / "regression-smoke.py"
)
assert _spec and _spec.loader, "could not load regression-smoke module"
regsmoke = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = regsmoke
_spec.loader.exec_module(regsmoke)

_lib_spec = importlib.util.spec_from_file_location(
    "smoke_lib_stamp", pathlib.Path(__file__).parent / "_smoke_lib.py"
)
assert _lib_spec and _lib_spec.loader
lib = importlib.util.module_from_spec(_lib_spec)
sys.modules[_lib_spec.name] = lib
_lib_spec.loader.exec_module(lib)

_hosts_spec = importlib.util.spec_from_file_location(
    "env_hosts_stamp", pathlib.Path(__file__).parent / "_env_hosts.py"
)
assert _hosts_spec and _hosts_spec.loader
hosts = importlib.util.module_from_spec(_hosts_spec)
_hosts_spec.loader.exec_module(hosts)

URL = "https://optical-a.example.com"
DEV_ORIGIN = f"https://{hosts.ENV_HOSTS['dev']}"


def _chunk(priv: dict) -> dict:
    return {"id": "e1", "extendedProperties": {"private": {"scheduler_chunk_id": "t#0", **priv}}}


def test_matching_stamp_passes():
    assert regsmoke._deployment_stamp_problem(_chunk({"optical_deployment": URL}), URL) is None


def test_expected_origin_is_the_custom_url_origin_normalised():
    assert regsmoke._expected_issuer_origin("https://Optical-A.example.com/", "dev") == URL
    assert regsmoke._expected_issuer_origin(f"{URL}/some/path", "dev") == URL


def test_expected_origin_of_a_workers_dev_url_is_the_wrangler_envs_issuer_host():
    # A smoke run may target the workers.dev URL but the worker stamps its
    # OAUTH_ISSUER (custom-domain) origin; resolve it via _env_hosts.
    for env_name, host in hosts.ENV_HOSTS.items():
        got = regsmoke._expected_issuer_origin("https://weekly-scheduling-assistant-x.acct.workers.dev", env_name)
        assert got == f"https://{host}"


def test_expected_origin_of_a_workers_dev_url_with_an_unknown_env_is_none():
    assert regsmoke._expected_issuer_origin("https://w.acct.workers.dev", "nope") is None


def test_unknown_expected_origin_skips_the_equality_check():
    ev = _chunk({"optical_deployment": "https://anything.example"})
    assert regsmoke._deployment_stamp_problem(ev, None) is None


def test_dev_workers_dev_run_accepts_the_dev_issuer_stamp():
    ev = _chunk({"optical_deployment": DEV_ORIGIN})
    expected = regsmoke._expected_issuer_origin("https://weekly-scheduling-assistant-dev.acct.workers.dev", "dev")
    assert regsmoke._deployment_stamp_problem(ev, expected) is None


def test_missing_stamp_passes_for_pre_stamp_deployments():
    assert regsmoke._deployment_stamp_problem(_chunk({}), URL) is None


def test_foreign_stamp_is_reported_with_both_values():
    msg = regsmoke._deployment_stamp_problem(_chunk({"optical_deployment": "https://optical-b.example.com"}), URL)
    assert msg is not None
    assert "https://optical-b.example.com" in msg and URL in msg and "e1" in msg


def test_graph_client_reads_the_stamp_back():
    raw = {
        "id": "AAMk1", "subject": "s", "showAs": "busy", "isCancelled": False, "isAllDay": False,
        "categories": [], "attendees": [],
        "start": {"dateTime": "2026-07-06T09:00:00.0000000", "timeZone": "UTC"},
        "end": {"dateTime": "2026-07-06T10:00:00.0000000", "timeZone": "UTC"},
        "singleValueExtendedProperties": [
            {"id": lib.graph_prop_id("optical_deployment"), "value": URL},
        ],
    }
    assert lib.normalize_graph_event(raw)["extendedProperties"]["private"] == {"optical_deployment": URL}
    assert "optical_deployment" in lib._GRAPH_PRIVATE_PROPS


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
