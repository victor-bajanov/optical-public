# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Guard for the Turnstile widget creation helper.

The whole point of `create-turnstile-widget.py` is that the *secret* half of a
Turnstile pair travels from Cloudflare's API response into `wrangler secret put`
without ever being rendered — not to a terminal, not to a log, not to a file.
The sitekey is public (it is embedded in the served page) and is printed on
purpose; the secret is not. `test_secret_never_reaches_stdout_or_stderr` is the
test that actually matters here — the rest guard the API contract around it.
"""
import importlib.util, io, pathlib, sys

import pytest

_spec = importlib.util.spec_from_file_location(
    "mkturnstile", pathlib.Path(__file__).parent / "create-turnstile-widget.py"
)
assert _spec and _spec.loader, "could not load create-turnstile-widget module"
mkturnstile = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mkturnstile
_spec.loader.exec_module(mkturnstile)

HOSTNAME = "scheduler.example.com"
SITEKEY = "REPLACE_WITH_YOUR_TURNSTILE_SITE_KEY"
SECRET = "REPLACE_WITH_YOUR_TURNSTILE_SITE_KEYfffGGGhhhIIIjjjKKK"


class FakeApi:
    """Stands in for the Cloudflare REST API. Records what it was asked to do."""

    def __init__(self, widgets=None, create_response=None):
        self._widgets = widgets or []
        self._create_response = create_response or {
            "success": True,
            "result": {"sitekey": SITEKEY, "secret": SECRET, "domains": [HOSTNAME]},
        }
        self.posted = None

    def list_widgets(self):
        return self._widgets

    def create_widget(self, payload):
        self.posted = payload
        return self._create_response


class FakeRunner:
    """Stands in for `wrangler secret put`. Captures argv and stdin."""

    def __init__(self, returncode=0):
        self.returncode = returncode
        self.cmd = None
        self.stdin = None

    def __call__(self, cmd, stdin_text):
        self.cmd = cmd
        self.stdin = stdin_text
        return self.returncode


def test_payload_binds_the_widget_to_exactly_one_hostname():
    # A Turnstile widget's `domains` is what stops a sitekey being reused on
    # another site. Prod's widget must carry the prod hostname and nothing else.
    payload = mkturnstile.build_widget_payload("Optical booking (prod)", HOSTNAME)
    assert payload["domains"] == [HOSTNAME]
    assert payload["name"] == "Optical booking (prod)"
    assert payload["mode"] == "managed"


def test_existing_widget_for_the_same_domain_is_found():
    # Re-running the script must not silently mint a second widget for a
    # hostname that already has one — the old sitekey would keep working while
    # the deployed secret rotated out from under it.
    widgets = [
        {"sitekey": "0xOTHER", "domains": ["example.com"]},
        {"sitekey": SITEKEY, "domains": [HOSTNAME]},
    ]
    found = mkturnstile.find_widget_for_domain(widgets, HOSTNAME)
    assert found is not None and found["sitekey"] == SITEKEY


def test_no_existing_widget_for_an_unused_domain():
    widgets = [{"sitekey": "0xOTHER", "domains": ["example.com"]}]
    assert mkturnstile.find_widget_for_domain(widgets, HOSTNAME) is None


def test_duplicate_domain_refused_unless_forced():
    api = FakeApi(widgets=[{"sitekey": SITEKEY, "domains": [HOSTNAME]}])
    with pytest.raises(mkturnstile.TurnstileError) as exc:
        mkturnstile.create_pair(api, "Optical booking (prod)", HOSTNAME, force=False)
    assert "already" in str(exc.value).lower()


def test_duplicate_domain_allowed_when_forced():
    api = FakeApi(widgets=[{"sitekey": SITEKEY, "domains": [HOSTNAME]}])
    sitekey, secret = mkturnstile.create_pair(
        api, "Optical booking (prod)", HOSTNAME, force=True
    )
    assert (sitekey, secret) == (SITEKEY, SECRET)


def test_api_failure_raises_rather_than_returning_an_empty_pair():
    # An `Authentication error` (what a token without Turnstile:Edit returns)
    # must abort loudly — never fall through to pushing an empty secret, which
    # would make every claim fail closed with no obvious cause.
    api = FakeApi(
        create_response={
            "success": False,
            "errors": [{"code": 10000, "message": "Authentication error"}],
        }
    )
    with pytest.raises(mkturnstile.TurnstileError) as exc:
        mkturnstile.create_pair(api, "n", HOSTNAME, force=True)
    assert "Authentication error" in str(exc.value)


def test_missing_secret_in_response_raises():
    api = FakeApi(create_response={"success": True, "result": {"sitekey": SITEKEY}})
    with pytest.raises(mkturnstile.TurnstileError):
        mkturnstile.create_pair(api, "n", HOSTNAME, force=True)


def test_prod_secret_put_carries_no_env_flag():
    # `--env` is inheritable in wrangler: omitting it targets top-level (prod),
    # and passing the wrong one would install prod's secret onto scheduler-dev.
    cmd = mkturnstile.secret_put_command("prod")
    assert cmd[:5] == ["npx", "wrangler", "secret", "put", "TURNSTILE_SECRET"]
    assert "--env" not in cmd


def test_dev_secret_put_targets_the_dev_env():
    cmd = mkturnstile.secret_put_command("dev")
    assert cmd[-2:] == ["--env", "dev"]


def test_secret_is_piped_to_wrangler_on_stdin():
    runner = FakeRunner()
    mkturnstile.install_secret(runner, "prod", SECRET)
    assert runner.stdin == SECRET
    assert SECRET not in " ".join(runner.cmd), "secret must never appear in argv"


def test_failed_secret_put_raises():
    runner = FakeRunner(returncode=1)
    with pytest.raises(mkturnstile.TurnstileError):
        mkturnstile.install_secret(runner, "prod", SECRET)


def test_secret_never_reaches_stdout_or_stderr():
    # THE test. Drive the whole create+install path with both streams captured
    # and assert the secret appears in neither, while the public sitekey does.
    api, runner = FakeApi(), FakeRunner()
    out, err = io.StringIO(), io.StringIO()
    mkturnstile.run(
        api=api,
        runner=runner,
        name="Optical booking (prod)",
        hostname=HOSTNAME,
        wrangler_env="prod",
        force=False,
        stdout=out,
        stderr=err,
    )
    combined = out.getvalue() + err.getvalue()
    assert SECRET not in combined, "the secret leaked into the terminal"
    assert SITEKEY in combined, "the sitekey is public and must be reported"
    assert runner.stdin == SECRET, "the secret must still have reached wrangler"


def test_sitekey_is_the_only_thing_on_stdout():
    # stdout is the machine-readable channel: `SITEKEY=$(... )` must yield the
    # sitekey alone, so all commentary goes to stderr.
    api, runner = FakeApi(), FakeRunner()
    out, err = io.StringIO(), io.StringIO()
    mkturnstile.run(
        api=api,
        runner=runner,
        name="n",
        hostname=HOSTNAME,
        wrangler_env="prod",
        force=False,
        stdout=out,
        stderr=err,
    )
    assert out.getvalue().strip() == SITEKEY


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))


def test_wrangler_env_choices_are_prod_and_the_smoke_envs():
    expected = ("prod", "dev")
    assert mkturnstile.WRANGLER_ENVS == expected
    for env in expected:
        args = mkturnstile.build_parser().parse_args(
            ["--hostname", "h.example", "--name", "x", "--wrangler-env", env]
        )
        assert args.wrangler_env == env
    with pytest.raises(SystemExit):
        mkturnstile.build_parser().parse_args(
            ["--hostname", "h.example", "--name", "x", "--wrangler-env", "staging"]
        )


