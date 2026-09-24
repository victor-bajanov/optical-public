# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Guards for GraphMailClient — the Microsoft-Graph analogue of GmailClient.

bin/poll-smoke.py's mailbox-first token relay reads the organiser's Sent
mail to find each invitee's poll link without an operator pasting it in
(bin/_smoke_lib.py's GmailClient, wired in via configure_gmail_client). On a
Microsoft organiser that same relay must read the organiser's Sent Items
through Graph instead of the Gmail API — GraphMailClient is that read path.

Graph rejects a request that combines $filter and $orderby on different
properties, so subject-prefix ("[pollsmoke]") and to-recipient matching are
NOT done server-side here — GraphMailClient hands back every Sent Items
message at/after the watermark, raw, and bin/poll-smoke.py's GraphReader
(WP2.3) does that matching client-side, mirroring how GmailClient's
list_messages()+get_message() split works for Gmail.
"""
import importlib.util, pathlib, sys
from datetime import datetime, timezone

import httpx
import pytest

_spec = importlib.util.spec_from_file_location(
    "smoke_lib", pathlib.Path(__file__).parent / "_smoke_lib.py"
)
assert _spec and _spec.loader
lib = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = lib
_spec.loader.exec_module(lib)


class FakeScheduler:
    def request(self, method, path, **kw):
        assert (method, path) == ("GET", "/v1/calendar-access-token")
        return httpx.Response(200, json={"access_token": "graph-mail-tok"},
                              request=httpx.Request("GET", "https://sched/v1/calendar-access-token"))


def make_client(handler):
    c = lib.GraphMailClient(FakeScheduler())
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    return c


def rendered_invite_html(url: str, label: str = "Mark your availability") -> str:
    """A representative rendered poll-invite email body — mirrors
    worker/src/polls/emails.ts's emailShell(ctaButton(url, label)) output
    (WP2 review finding 7): the worker sends poll mail HTML-only, with the
    link living ONLY inside this anchor's href, never as bare text."""
    return (
        '<!doctype html><html><body style="margin:0;padding:24px;background:#f6f8fc">'
        '<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;padding:24px">'
        "<p>Sam Organiser wants to find a time for <strong>Poll Smoke Edit</strong> (30 minutes).</p>"
        "<p>Window: Mon 6 July – Mon 13 July<br>Responses close: Mon 6 July, 11:00 AM UTC</p>"
        f'<div style="margin-top:18px"><a href="{url}" '
        'style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;'
        f'font-size:14px;font-weight:600;padding:11px 24px;border-radius:6px">{label}</a></div>'
        "</div></body></html>"
    )


def graph_message(**over):
    base = {
        "id": "AAMk-msg1",
        "subject": "[pollsmoke] Poll Smoke Edit — you're invited",
        "sentDateTime": "2026-07-06T09:00:00Z",
        "toRecipients": [{"emailAddress": {"address": "invitee-a@example.com"}}],
        "body": {
            "contentType": "html",
            "content": rendered_invite_html("https://sched/poll/poll-1?t=abc123"),
        },
    }
    base.update(over)
    return base


# --- request shape -----------------------------------------------------------

def test_list_sent_since_hits_sentitems_with_filter_select_orderby_and_bearer():
    calls = []

    def handler(req: httpx.Request):
        calls.append(req)
        assert req.headers["authorization"] == "Bearer graph-mail-tok"
        assert req.url.path.endswith("/me/mailFolders/sentitems/messages")
        # No Prefer: outlook.body-content-type="text" (WP2 review finding 1):
        # the worker's poll emails are HTML-only (contentType: "HTML", no
        # plaintext alternative — MicrosoftGraphNotificationProvider.sendMail)
        # and the poll link lives only inside a <a href="…"> — forcing
        # Exchange to convert that to text either drops the href entirely or
        # line-wraps the long URL, truncating the token. Request the native
        # body instead and let the caller (GraphReader) match the raw HTML.
        header_names = {k.lower() for k in req.headers.keys()}
        assert "prefer" not in header_names
        filt = req.url.params["$filter"]
        assert filt.startswith("sentDateTime ge ")
        assert "2026-07-06T09:00:00Z" in filt
        select = req.url.params["$select"]
        for field in ("id", "subject", "sentDateTime", "toRecipients", "body"):
            assert field in select
        assert "$top" in req.url.params
        # $orderby on the SAME property as $filter (sentDateTime) is allowed
        # by Graph and gives newest-first paging (WP2 review finding 2) —
        # it's $filter/$orderby on DIFFERENT properties that Graph rejects
        # ("the restriction or sort order is too complex").
        assert req.url.params["$orderby"] == "sentDateTime desc"
        return httpx.Response(200, json={"value": [graph_message(id="m1")]})

    not_before = int(datetime(2026, 7, 6, 9, 0, 0, tzinfo=timezone.utc).timestamp())
    msgs = make_client(handler).list_sent_since(not_before)
    assert [m["id"] for m in msgs] == ["m1"]
    assert len(calls) == 1


def test_list_sent_since_pages_via_odata_next_link():
    def handler(req: httpx.Request):
        if req.url.path.endswith("/me/mailFolders/sentitems/messages"):
            return httpx.Response(200, json={
                "value": [graph_message(id="p1")],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
            })
        assert str(req.url) == "https://graph.microsoft.com/v1.0/next-page"
        return httpx.Response(200, json={"value": [graph_message(id="p2")]})

    msgs = make_client(handler).list_sent_since(0)
    assert [m["id"] for m in msgs] == ["p1", "p2"]


# --- scope error ---------------------------------------------------------------

def test_403_raises_mail_scope_error():
    c = make_client(lambda req: httpx.Response(403, text="Mail.Read scope missing"))
    with pytest.raises(lib.MailScopeError):
        c.list_sent_since(0)


def test_mail_scope_error_and_gmail_scope_error_are_interchangeable():
    # WP2.2: GmailScopeError becomes a provider-neutral alias/sibling of
    # MailScopeError so poll-smoke's circuit breaker (`except GmailScopeError`)
    # trips identically for a Microsoft 403, without renaming that call site.
    # WP2 review finding 8: the `issubclass(X, X) or X is X` assertions this
    # test used to open with are trivially true regardless of whether the two
    # names are actually related — the concrete raise-and-catch pairs below
    # are the real proof, so they're all that's left.

    def raise_graph_style():
        raise lib.MailScopeError("graph 403")

    def raise_gmail_style():
        raise lib.GmailScopeError("gmail 403")

    with pytest.raises(lib.GmailScopeError):
        raise_graph_style()
    with pytest.raises(lib.MailScopeError):
        raise_gmail_style()


# --- graph_datetime_to_epoch (WP2 review finding 4) ---------------------------
# Graph's sentDateTime (like the calendar event start/end _graph_instant
# already handles) can carry 7 fractional digits, which datetime.fromisoformat
# rejects on 3.11 — a naive fromisoformat(sentIso.replace("Z","+00:00")) drops
# every message silently. graph_datetime_to_epoch is the shared, tested
# tolerant parser both call sites should use.

def test_graph_datetime_to_epoch_plain_z():
    epoch = lib.graph_datetime_to_epoch("2026-07-06T09:00:00Z")
    assert epoch == int(datetime(2026, 7, 6, 9, 0, 0, tzinfo=timezone.utc).timestamp())


def test_graph_datetime_to_epoch_seven_fractional_digits():
    # The exact shape Graph emits for sentDateTime/receivedDateTime.
    epoch = lib.graph_datetime_to_epoch("2026-07-06T09:00:00.1234567Z")
    assert epoch == int(datetime(2026, 7, 6, 9, 0, 0, tzinfo=timezone.utc).timestamp())


def test_graph_datetime_to_epoch_raises_valueerror_on_garbage():
    with pytest.raises(ValueError):
        lib.graph_datetime_to_epoch("not-a-date")


def test_graph_datetime_to_epoch_raises_on_empty_string():
    with pytest.raises(ValueError):
        lib.graph_datetime_to_epoch("")


def test_gmail_client_now_raises_the_neutral_mail_scope_error():
    # bin/_smoke_lib.GmailClient.list_messages/get_message should raise the
    # provider-neutral class directly (2.2's "update GmailClient to raise
    # the neutral class") — caught by both names via the alias above.
    class FakeSched:
        def request(self, method, path, **kw):
            return httpx.Response(200, json={"access_token": "gmail-tok"},
                                  request=httpx.Request("GET", "https://sched/v1/calendar-access-token"))

    c = lib.GmailClient(FakeSched())
    c._client = httpx.Client(transport=httpx.MockTransport(
        lambda req: httpx.Response(403, text="gmail.readonly scope missing")))
    with pytest.raises(lib.MailScopeError):
        c.list_messages("q")
    with pytest.raises(lib.MailScopeError):
        c.get_message("id1")


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
