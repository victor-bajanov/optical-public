#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Live smoke for multi-endpoint busy feeds (either provider).

Exercises the /v1/calendar-feeds CRUD surface, the two-step /cal-reveal/:token
single-use secret reveal, and the per-endpoint title-reveal-regex behaviour of
/cal/:secret/busy.ics
(internal design notes).

F1  create two endpoints (one with a reveal regex, one without); reveal both
    secrets over the HTTP two-step (GET never consumes — link-preview bots/
    curl are safe; POST reveals once; second POST 410 Link expired).
F2  create a calendar event titled "FeedSmoke hold - <stamp>"; poll both
    feeds; the regex endpoint shows the title, the plain endpoint shows Busy.
F3  PATCH the regex off; the feed reverts to Busy on next poll.
F4  regenerate: the old feed URL 404s (unknown/revoked token — same opaque
    404 as any other invalid secret), the newly revealed URL works.
Cleanup: delete the event and both endpoints (always, in finally).

Provider (2026-09-17): `--provider {google,microsoft}` (default `$SMOKE_PROVIDER`
or google) names the provider A_BEARER was minted for. The busy feed itself
is provider-agnostic on the worker side (feed-route.ts reads the owner's
calendar through `defaultCalendarProvider`), so the only provider-specific
parts here are the F2 hold — created through `_smoke_lib.make_calendar_client`
(Google Calendar API vs Graph) — and the preflight GET /v1/whoami guard
(`_smoke_lib.check_whoami_body`): a Google bearer under `--provider microsoft`
fails in the first second, not as a confusing Graph 401 mid-run. Under the
runner, the registry appends `--provider` from the mode and projects the
matching cast (MS_A_* -> A_*) — nothing here reads the MS_ names.

Requires:
  SCHEDULER_URL, A_BEARER, A_REFRESH, A_EXPECTED_EMAIL  (SMOKE_PROVIDER optional)

Usage:
  op run --env-file=.env -- uv run bin/feed-smoke.py > /tmp/feed-smoke.out 2>&1
  A_BEARER=$MS_A_BEARER A_REFRESH=$MS_A_REFRESH A_EXPECTED_EMAIL=$MS_A_EXPECTED_EMAIL \\
    uv run bin/feed-smoke.py --provider microsoft
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

_spec = importlib.util.spec_from_file_location(
    "_smoke_lib", str(Path(__file__).resolve().parent / "_smoke_lib.py")
)
_smoke_lib = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _smoke_lib
_spec.loader.exec_module(_smoke_lib)
Identity = _smoke_lib.Identity
SchedulerClient = _smoke_lib.SchedulerClient
# Provider-dispatching client factory (Google CalendarClient / Graph
# GraphCalendarClient — same create_event/delete_event/close verbs) and the
# shared whoami preflight — bound from _smoke_lib, never local copies
# (bin/test_feed_smoke_guard.py pins both bindings).
make_calendar_client = _smoke_lib.make_calendar_client
preflight_whoami = _smoke_lib.preflight_whoami

# Shared with every other harness — every create/delete this harness issues
# goes through the bearer API to SCHEDULER_URL, so a wrong host must fail
# closed. Was previously a local copy (drift: fail-open on prod's own
# workers.dev subdomain) — see bin/test_smoke_lib_guards.py's
# D1/m1 for the bug class _smoke_lib.assert_dev_url's own docstring guards
# against.
assert_dev_url = _smoke_lib.assert_dev_url
req = _smoke_lib.req


def reveal_secret(reveal_url: str) -> str:
    """Drive the two-step /cal-reveal/:token reveal like a browser would;
    assert single-use.

    GET never touches the DB (link-preview bots/curl on the URL can't burn
    the reveal), so it stays 200 no matter how many times it's fetched. POST
    atomically consumes the token: the first succeeds and renders the feed
    URL; the second (and any POST of an unknown/expired token) gets the
    opaque "Link expired" page at 410."""
    get1 = httpx.get(reveal_url, timeout=30.0)
    assert get1.status_code == 200 and "Reveal secret" in get1.text, (
        f"GET should show the reveal button page, got {get1.status_code}: "
        f"{get1.text[:300]!r}"
    )
    get2 = httpx.get(reveal_url, timeout=30.0)  # GET twice: must not consume
    assert get2.status_code == 200, "second GET must still be 200 (no consume)"
    post = httpx.post(reveal_url, timeout=30.0)
    assert post.status_code == 200, f"POST reveal failed: {post.status_code}: {post.text[:300]!r}"
    m = re.search(r"(https://\S+/cal/\S+/busy\.ics)", post.text)
    assert m, f"feed URL not found in reveal page: {post.text[:500]!r}"
    again = httpx.post(reveal_url, timeout=30.0)
    assert again.status_code == 410, f"second POST must be 410 (Link expired), got {again.status_code}"
    return m.group(1)


def poll_ics(feed_url: str) -> str:
    r = httpx.get(feed_url, timeout=30.0)
    assert r.status_code == 200, f"feed poll failed: {r.status_code}"
    return r.text


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Live smoke for multi-endpoint busy feeds.")
    p.add_argument("--provider", choices=list(_smoke_lib.PROVIDERS),
                   # `or "google"`, not a default= of the env value: SMOKE_PROVIDER=""
                   # (a common shell artifact) would otherwise become argparse's
                   # literal default and bypass `choices` (poll-smoke WP2 finding 6).
                   default=os.environ.get("SMOKE_PROVIDER") or "google",
                   help="Calendar provider A_BEARER was minted for (default: $SMOKE_PROVIDER "
                        "or google). Picks the client the F2 hold is created through and is "
                        "checked against GET /v1/whoami in preflight.")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    provider = args.provider
    url = req("SCHEDULER_URL").rstrip("/")
    assert_dev_url(url)
    ident = Identity(
        scheduler_url=url,
        bearer=req("A_BEARER"),
        refresh_token=req("A_REFRESH"),
        expected_email=req("A_EXPECTED_EMAIL"),
        client_id=os.environ.get("A_CLIENT_ID", "smoke-cli"),
    )
    sched = SchedulerClient(ident)
    # Preflight: the bearer is who (and which provider) we think it is —
    # before the first feed call, so a wrong cast fails here, not as a
    # Graph/Google 401 deep inside F2's propagation wait.
    preflight_whoami(sched, ident.expected_email, provider, "A")
    cal = make_calendar_client(sched, provider)
    now = datetime.now(timezone.utc)
    # Labels never go through the output guard's content screen, so a compact
    # digit run is fine there. The event TITLE does go through that screen —
    # a bare 14-digit run reads as a phone number and gets masked to Busy, so
    # the title uses the date/time shape the guard carves out for dates/times
    # instead. Seconds precision keeps titles unique across runs.
    stamp = now.strftime("%Y%m%d%H%M%S")
    title = f"FeedSmoke hold - {now.strftime('%Y-%m-%d %H:%M:%S')}"
    created_ids: list[str] = []
    event_id: str | None = None
    try:
        # F1 — create endpoints + reveal
        r = sched.request("POST", "/v1/calendar-feeds", json={
            "label": f"smoke-regex-{stamp}", "reveal_regexes": [r"FeedSmoke hold .*"]})
        assert r.status_code == 200, f"create regex endpoint: {r.status_code} {r.text}"
        regex_ep = r.json(); created_ids.append(regex_ep["id"])
        r = sched.request("POST", "/v1/calendar-feeds", json={"label": f"smoke-plain-{stamp}"})
        assert r.status_code == 200, f"create plain endpoint: {r.status_code} {r.text}"
        plain_ep = r.json(); created_ids.append(plain_ep["id"])
        regex_url = reveal_secret(regex_ep["reveal_url"])
        plain_url = reveal_secret(plain_ep["reveal_url"])
        print("F1 PASS — endpoints created, two-step reveal single-use verified")

        # F2 — event visible with title on regex endpoint only
        start = (datetime.now(timezone.utc) + timedelta(days=1)).replace(minute=0, second=0, microsecond=0)
        event_id = cal.create_event(title, start.isoformat(), (start + timedelta(hours=1)).isoformat())
        deadline = time.time() + 120
        while True:  # feed reads live from the provider; retry for propagation
            ics_regex, ics_plain = poll_ics(regex_url), poll_ics(plain_url)
            if title in ics_regex:
                break
            if time.time() > deadline:
                sys.exit(f"F2 FAIL — title never appeared in regex feed\n{ics_regex[:2000]}")
            time.sleep(10)
        assert title not in ics_plain, "plain endpoint must not reveal the title"
        assert "SUMMARY:Busy" in ics_plain, "plain endpoint should show Busy"
        print("F2 PASS — title revealed on regex endpoint, Busy elsewhere")

        # F3 — clearing the regex re-masks
        r = sched.request("PATCH", f"/v1/calendar-feeds/{regex_ep['id']}", json={"reveal_regexes": []})
        assert r.status_code == 200, f"patch: {r.status_code} {r.text}"
        assert title not in poll_ics(regex_url), "cleared regex must re-mask the title"
        print("F3 PASS — cleared regexes re-mask")

        # F4 — regenerate kills the old URL
        r = sched.request("POST", f"/v1/calendar-feeds/{regex_ep['id']}/regenerate")
        assert r.status_code == 200, f"regenerate: {r.status_code} {r.text}"
        new_url = reveal_secret(r.json()["reveal_url"])
        assert httpx.get(regex_url, timeout=30.0).status_code == 404, \
            "old feed URL must 404 after regenerate (opaque unknown/revoked-token response)"
        assert httpx.get(new_url, timeout=30.0).status_code == 200, "new feed URL must work"
        print("F4 PASS — rotation: old URL dead, new URL live")
        print("ALL PASS")
    finally:
        if event_id is not None:
            try:
                cal.delete_event(event_id)
            except Exception as e:
                print(f"cleanup: delete_event failed: {e}")
        for fid in created_ids:
            try:
                sched.request("DELETE", f"/v1/calendar-feeds/{fid}")
            except Exception as e:
                print(f"cleanup: delete feed {fid} failed: {e}")
        sched.close()
        cal.close()


if __name__ == "__main__":
    main()
