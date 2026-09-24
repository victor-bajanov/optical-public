# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27", "python-dateutil>=2.9", "pydantic>=2.7", "rich>=13.7"]
# ///
"""Guards for the provider-agnostic calendar surface of the smoke harness.

bin/regression-smoke.py reads calendar events in Google's wire shape
(`summary`, `start.dateTime`, `colorId`, `extendedProperties.private.*`,
`attendees[].email/responseStatus`). To run the SAME levels against a
Microsoft-provider account, _smoke_lib.GraphCalendarClient talks to Graph and
normalises every event into that shape, so no level code needs to know which
provider it is driving. These tests pin that normalisation and the
done-marking translation (Outlook category <-> colorId) to what the worker's
graph-event-mapping.ts does.
"""
import importlib.util, json, pathlib, sys

import httpx
import pytest

_spec = importlib.util.spec_from_file_location(
    "smoke_lib", pathlib.Path(__file__).parent / "_smoke_lib.py"
)
assert _spec and _spec.loader
lib = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = lib
_spec.loader.exec_module(lib)

CHUNK_PROP = lib.graph_prop_id("scheduler_chunk_id")
MEETING_PROP = lib.graph_prop_id("optical_meeting_task_id")
POLL_PROP = lib.graph_prop_id("optical_poll_id")


def graph_event(**over):
    base = {
        "id": "AAMk1", "subject": "[regsmoke L6] write memo", "showAs": "busy",
        "isCancelled": False, "isAllDay": False, "categories": [],
        "start": {"dateTime": "2026-07-06T09:00:00.0000000", "timeZone": "UTC"},
        "end": {"dateTime": "2026-07-06T10:00:00.0000000", "timeZone": "UTC"},
        "attendees": [], "singleValueExtendedProperties": [],
    }
    base.update(over)
    return base


# --- normaliser --------------------------------------------------------------

def test_normalise_maps_core_fields_to_google_shape():
    ev = lib.normalize_graph_event(graph_event())
    assert ev["id"] == "AAMk1"
    assert ev["summary"] == "[regsmoke L6] write memo"
    assert ev["status"] == "confirmed"
    # 7-digit Graph fractions are NOT fromisoformat-safe on 3.11; the harness
    # parses start/end with datetime.fromisoformat(x.replace("Z", "+00:00")).
    assert ev["start"]["dateTime"] == "2026-07-06T09:00:00+00:00"
    assert ev["end"]["dateTime"] == "2026-07-06T10:00:00+00:00"
    assert ev["colorId"] is None


def test_normalise_cancelled_and_done_category():
    ev = lib.normalize_graph_event(graph_event(isCancelled=True, categories=["Optical Done", "Other"]))
    assert ev["status"] == "cancelled"
    assert ev["colorId"] == lib.OPTICAL_DONE_CATEGORY == "Optical Done"


def test_normalise_extended_properties_and_attendees():
    ev = lib.normalize_graph_event(graph_event(
        singleValueExtendedProperties=[
            {"id": CHUNK_PROP, "value": "uuid-1#0"},
            {"id": MEETING_PROP, "value": "uuid-m"},
            {"id": POLL_PROP, "value": "poll-1"},
            {"id": "String {00000000-0000-0000-0000-000000000000} Name unrelated", "value": "x"},
        ],
        attendees=[
            {"emailAddress": {"address": "a@x.com"}, "status": {"response": "accepted"}},
            {"emailAddress": {"address": "b@x.com"}, "status": {"response": "none"}},
            {"emailAddress": {"address": "c@x.com"}, "status": {"response": "declined"}},
            {"emailAddress": {"address": "d@x.com"}, "status": {"response": "tentativelyAccepted"}},
        ],
    ))
    assert ev["extendedProperties"]["private"] == {
        "scheduler_chunk_id": "uuid-1#0", "optical_meeting_task_id": "uuid-m",
        "optical_poll_id": "poll-1",
    }
    assert [(a["email"], a["responseStatus"]) for a in ev["attendees"]] == [
        ("a@x.com", "accepted"), ("b@x.com", "needsAction"),
        ("c@x.com", "declined"), ("d@x.com", "tentative"),
    ]
    assert ev["_graph"]["id"] == "AAMk1"  # raw event kept for provider-specific probes


def test_normalise_maps_location_display_name():
    # As worker/src/providers/microsoft-calendar-provider.ts's createEvent
    # writes it: location.displayName is the whole shape Graph gives back.
    ev = lib.normalize_graph_event(graph_event(location={"displayName": "42 Test Ave, Sydney NSW"}))
    assert ev["location"] == "42 Test Ave, Sydney NSW"


def test_normalise_location_absent_is_none():
    # WP2 review finding 9: Google's raw event dict simply has no `location`
    # key when unset, so event.get("location") is None there — normalising
    # Graph's absent case to "" instead of None was a cross-provider
    # divergence a level could trip on (an equality check against None,
    # e.g. `if event.get("location") is None:`, would not have matched "").
    ev = lib.normalize_graph_event(graph_event())
    assert ev["location"] is None
    ev2 = lib.normalize_graph_event(graph_event(location={}))
    assert ev2["location"] is None


def test_graph_instant_strips_fraction_before_a_trailing_z():
    # Review fix #9: _graph_instant's old regex (r"\.\d+$") only strips a
    # fraction that's the LAST thing in the string — a dateTime ending in
    # "...0000000Z" (fraction immediately before a trailing Z, as getSchedule
    # scheduleItems can return) left the Z glued onto the fraction, producing
    # garbage instead of stripping it. Must tolerate both shapes.
    ev = lib.normalize_graph_event(graph_event(
        start={"dateTime": "2026-07-06T09:00:00.0000000Z", "timeZone": "UTC"},
        end={"dateTime": "2026-07-06T10:00:00.0000000Z", "timeZone": "UTC"},
    ))
    assert ev["start"]["dateTime"] == "2026-07-06T09:00:00+00:00"
    assert ev["end"]["dateTime"] == "2026-07-06T10:00:00+00:00"


def test_graph_instant_still_strips_fraction_with_no_trailing_z():
    ev = lib.normalize_graph_event(graph_event(
        start={"dateTime": "2026-07-06T09:00:00.1234567", "timeZone": "UTC"},
    ))
    assert ev["start"]["dateTime"] == "2026-07-06T09:00:00+00:00"


def test_graph_instant_handles_no_fraction_at_all():
    ev = lib.normalize_graph_event(graph_event(
        start={"dateTime": "2026-07-06T09:00:00", "timeZone": "UTC"},
    ))
    assert ev["start"]["dateTime"] == "2026-07-06T09:00:00+00:00"


def test_graph_instant_handles_no_fraction_with_trailing_z():
    # The fourth shape: no fraction, but a trailing Z (e.g. a getSchedule
    # scheduleItem with whole-second precision).
    ev = lib.normalize_graph_event(graph_event(
        start={"dateTime": "2026-07-06T09:00:00Z", "timeZone": "UTC"},
    ))
    assert ev["start"]["dateTime"] == "2026-07-06T09:00:00+00:00"


# --- _strip_graph_fraction: shared by _graph_instant and
# graph_datetime_to_epoch (review fix #8) — pinned directly against all four
# shapes Graph emits across its endpoints. ------------------------------------

def test_strip_graph_fraction_bare_no_z():
    assert lib._strip_graph_fraction("2026-07-06T10:00:00.0000000") == "2026-07-06T10:00:00"


def test_strip_graph_fraction_fraction_then_z():
    assert lib._strip_graph_fraction("2026-07-06T10:00:00.0000000Z") == "2026-07-06T10:00:00Z"


def test_strip_graph_fraction_z_only_no_fraction():
    assert lib._strip_graph_fraction("2026-07-06T10:00:00Z") == "2026-07-06T10:00:00Z"


def test_strip_graph_fraction_no_fraction_no_z():
    assert lib._strip_graph_fraction("2026-07-06T10:00:00") == "2026-07-06T10:00:00"


# --- graph_datetime_to_epoch: same four shapes, via the shared helper --------

def test_graph_datetime_to_epoch_bare_fraction_no_z_matches_no_fraction_no_z():
    # Neither shape carries a Z, so there's no absolute UTC epoch to assert —
    # but stripping the fraction must be the ONLY thing that changes the
    # parse, so the two must agree exactly (both interpreted the same way by
    # fromisoformat/`.timestamp()`, whatever timezone that resolves to).
    with_fraction = lib.graph_datetime_to_epoch("2026-07-06T09:00:00.0000000")
    without_fraction = lib.graph_datetime_to_epoch("2026-07-06T09:00:00")
    assert with_fraction == without_fraction


def test_graph_datetime_to_epoch_fraction_then_z_matches_z_only():
    # Both carry a definite UTC "Z", so these agree with the plain-Z and
    # seven-fractional-digit cases already pinned by
    # bin/test_smoke_graph_mail_client.py's graph_datetime_to_epoch tests.
    with_fraction = lib.graph_datetime_to_epoch("2026-07-06T09:00:00.0000000Z")
    without_fraction = lib.graph_datetime_to_epoch("2026-07-06T09:00:00Z")
    assert with_fraction == without_fraction


def test_expand_filter_fetches_the_poll_id_extended_property():
    assert "singleValueExtendedProperties" in lib.GraphCalendarClient._EXPAND
    assert POLL_PROP in lib.GraphCalendarClient._EXPAND


# --- client verbs over a mock Graph -----------------------------------------

class FakeScheduler:
    def request(self, method, path, **kw):
        assert (method, path) == ("GET", "/v1/calendar-access-token")
        return httpx.Response(200, json={"access_token": "graph-tok"},
                              request=httpx.Request("GET", "https://sched/v1/calendar-access-token"))


def make_client(handler):
    c = lib.GraphCalendarClient(FakeScheduler())
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    return c


def test_list_events_pages_calendarview_with_expand_and_normalises():
    calls = []
    def handler(req: httpx.Request):
        calls.append(req)
        assert req.headers["authorization"] == "Bearer graph-tok"
        if req.url.path.endswith("/me/calendarView"):
            assert req.url.params["startDateTime"] == "2026-07-06T00:00:00Z"
            assert "singleValueExtendedProperties" in req.url.params["$expand"]
            assert CHUNK_PROP in req.url.params["$expand"]
            return httpx.Response(200, json={"value": [graph_event(id="p1")],
                                             "@odata.nextLink": "https://graph.microsoft.com/v1.0/next"})
        assert str(req.url) == "https://graph.microsoft.com/v1.0/next"
        return httpx.Response(200, json={"value": [graph_event(id="p2")]})
    evs = make_client(handler).list_events("2026-07-06T00:00:00Z", "2026-07-13T00:00:00Z")
    assert [e["id"] for e in evs] == ["p1", "p2"]
    assert evs[0]["summary"] == "[regsmoke L6] write memo"
    assert len(calls) == 2


def test_create_move_delete_payloads():
    seen = []
    def handler(req: httpx.Request):
        seen.append((req.method, req.url.path, json.loads(req.content) if req.content else None))
        if req.method == "POST":
            return httpx.Response(201, json={"id": "new1"})
        if req.method == "DELETE":
            return httpx.Response(404)
        return httpx.Response(200, json={})
    c = make_client(handler)
    assert c.create_event("s", "2026-07-06T09:00:00Z", "2026-07-06T10:00:00Z") == "new1"
    c.create_event("m", "2026-07-06T09:00:00Z", "2026-07-06T10:00:00Z", attendee_emails=["a@x.com"])
    c.move_event("new1", "2026-07-07T09:00:00Z", "2026-07-07T10:00:00Z")
    c.delete_event("new1")  # 404 tolerated
    assert seen[0] == ("POST", "/v1.0/me/events", {
        "subject": "s",
        "start": {"dateTime": "2026-07-06T09:00:00Z", "timeZone": "UTC"},
        "end": {"dateTime": "2026-07-06T10:00:00Z", "timeZone": "UTC"},
    })
    assert seen[1][2]["attendees"] == [{"emailAddress": {"address": "a@x.com"}, "type": "required"}]
    assert seen[2] == ("PATCH", "/v1.0/me/events/new1", {
        "start": {"dateTime": "2026-07-07T09:00:00Z", "timeZone": "UTC"},
        "end": {"dateTime": "2026-07-07T10:00:00Z", "timeZone": "UTC"},
    })
    assert seen[3][:2] == ("DELETE", "/v1.0/me/events/new1")


def test_recolor_translates_to_category_set_and_clear():
    seen = []
    def handler(req: httpx.Request):
        seen.append(json.loads(req.content))
        return httpx.Response(200, json={})
    c = make_client(handler)
    c.recolor_event("e1", lib.OPTICAL_DONE_CATEGORY)
    c.recolor_event("e1", "")
    assert seen == [{"categories": ["Optical Done"]}, {"categories": []}]


def test_recolor_rejects_google_numeric_color_on_graph():
    # A Google colorId like "11" has no Outlook meaning; the worker's mapping
    # drops it silently — the harness must fail loudly instead of passing
    # vacuously (L6 would "recolor" and then assert nothing changed).
    with pytest.raises(ValueError):
        make_client(lambda r: httpx.Response(200)).recolor_event("e1", "11")


def test_google_client_gains_recolor_primitive():
    seen = []
    class FakeSched(FakeScheduler):
        pass
    c = lib.CalendarClient(FakeSched())
    c._client = httpx.Client(transport=httpx.MockTransport(
        lambda req: (seen.append((req.method, req.url.path, json.loads(req.content))), httpx.Response(200, json={}))[1]))
    c.recolor_event("g1", "11")
    assert seen == [("PATCH", "/calendar/v3/calendars/primary/events/g1", {"colorId": "11"})]


# --- WP4: rsvp / freebusy / visibility behind provider-neutral client methods
# (internal design notes WP4.1) — bin/meeting-smoke.py drives
# these instead of raw cal.BASE/cal._authed reach-throughs, so level code
# never sees a provider.

def test_google_create_event_default_sends_no_sendupdates_param():
    # Review fix #8: send_updates defaults to None (not False), so a caller
    # that never passes it — feed-smoke/poll-smoke/booking-smoke/regression-
    # smoke/multiuser-smoke/reset-smoke-env's create_event calls, all
    # unaware of this WP4-only kwarg — sees EXACTLY the pre-WP4 behaviour:
    # no sendUpdates param at all, letting Google apply its own default.
    seen = []
    def handler(req: httpx.Request):
        seen.append((dict(req.url.params), json.loads(req.content)))
        return httpx.Response(200, json={"id": "g1"})
    c = lib.CalendarClient(FakeScheduler())
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    eid = c.create_event("s", "2026-07-06T09:00:00Z", "2026-07-06T10:00:00Z",
                         attendee_emails=["a@x.com", "b@x.com"])
    assert eid == "g1"
    params, body = seen[0]
    assert params == {}
    assert body["attendees"] == [{"email": "a@x.com"}, {"email": "b@x.com"}]


def test_google_create_event_explicit_send_updates_false_sends_sendupdates_none():
    # Only an EXPLICIT send_updates=False maps to sendUpdates=none — the
    # shape bin/meeting-smoke.py's create_event(..., send_updates=False)
    # calls need (folding in the old create_event_with_attendees helper's
    # always-quiet behaviour).
    seen = []
    def handler(req: httpx.Request):
        seen.append(dict(req.url.params))
        return httpx.Response(200, json={"id": "g1"})
    c = lib.CalendarClient(FakeScheduler())
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    c.create_event("s", "2026-07-06T09:00:00Z", "2026-07-06T10:00:00Z", send_updates=False)
    assert seen[0] == {"sendUpdates": "none"}


def test_google_create_event_send_updates_true_also_omits_the_param():
    seen = []
    def handler(req: httpx.Request):
        seen.append(dict(req.url.params))
        return httpx.Response(200, json={"id": "g1"})
    c = lib.CalendarClient(FakeScheduler())
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    c.create_event("s", "2026-07-06T09:00:00Z", "2026-07-06T10:00:00Z", send_updates=True)
    assert seen[0] == {}


def test_google_delete_event_default_sends_no_sendupdates_param():
    # Review fix #8: same three-state contract as create_event — existing
    # callers across booking/poll/regression/feed/multiuser/reset-smoke-env
    # get exactly the pre-WP4 behaviour by default (no suppression), since
    # bookers/poll invitees are meant to receive cancellation email.
    seen = []
    def handler(req: httpx.Request):
        seen.append(dict(req.url.params))
        return httpx.Response(204)
    c = lib.CalendarClient(FakeScheduler())
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    c.delete_event("g1")
    assert seen[0] == {}


def test_google_delete_event_explicit_send_updates_false_sends_sendupdates_none():
    seen = []
    def handler(req: httpx.Request):
        seen.append(dict(req.url.params))
        return httpx.Response(204)
    c = lib.CalendarClient(FakeScheduler())
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    c.delete_event("g1", send_updates=False)
    assert seen[0] == {"sendUpdates": "none"}


def test_google_get_event_icaluid_reads_ical_uid_field():
    c = lib.CalendarClient(FakeScheduler())
    c._client = httpx.Client(transport=httpx.MockTransport(
        lambda req: httpx.Response(200, json={"id": "g1", "iCalUID": "uid-123@google.com"})))
    assert c.get_event_icaluid("g1") == "uid-123@google.com"


def test_graph_get_event_icaluid_reads_ical_uid_field():
    c = make_client(lambda req: httpx.Response(200, json=graph_event(id="AAMk1", iCalUId="uid-abc")))
    assert c.get_event_icaluid("AAMk1") == "uid-abc"


def test_google_attendee_responses_maps_lowercased_email_to_status():
    attendees = [
        {"email": "Org@x.com", "responseStatus": "accepted"},
        {"email": "att@x.com", "responseStatus": "needsAction"},
    ]
    c = lib.CalendarClient(FakeScheduler())
    c._client = httpx.Client(transport=httpx.MockTransport(
        lambda req: httpx.Response(200, json={"id": "g1", "attendees": attendees})))
    assert c.attendee_responses("g1") == {"org@x.com": "accepted", "att@x.com": "needsAction"}


def test_graph_attendee_responses_uses_the_normaliser():
    c = make_client(lambda req: httpx.Response(200, json=graph_event(
        id="AAMk1",
        attendees=[{"emailAddress": {"address": "a@x.com"}, "status": {"response": "accepted"}}],
    )))
    assert c.attendee_responses("AAMk1") == {"a@x.com": "accepted"}


def test_google_query_freebusy_posts_freebusy_endpoint():
    seen = []
    def handler(req: httpx.Request):
        seen.append((req.url.path, json.loads(req.content)))
        return httpx.Response(200, json={"calendars": {"a@x.com": {"busy": [{"start": "s", "end": "e"}]}}})
    c = lib.CalendarClient(FakeScheduler())
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    out = c.query_freebusy(["a@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T01:00:00Z")
    assert seen[0][0] == "/calendar/v3/freeBusy"
    assert seen[0][1]["items"] == [{"id": "a@x.com"}]
    assert out == {"a@x.com": {"busy": [{"start": "s", "end": "e"}]}}


def test_graph_query_freebusy_calls_getschedule_and_normalises_busy_items():
    # Review fix #3: mirror the worker's exclusion rule exactly
    # (microsoft-calendar-provider.ts queryFreeBusyBatch) — "free" and
    # "workingElsewhere" are transparent, everything else (busy/tentative/
    # oof/an unrecognised status) blocks. Review fix #11: also pin the full
    # request shape (startTime/endTime, availabilityViewInterval) and the
    # Prefer: outlook.timezone="UTC" header this POST goes out with (sent
    # automatically by GraphCalendarClient._authed's override — this test
    # is what actually proves it for THIS call site).
    seen = []
    def handler(req: httpx.Request):
        seen.append((req.url.path, json.loads(req.content), dict(req.headers)))
        return httpx.Response(200, json={"value": [
            {"scheduleId": "a@x.com", "scheduleItems": [
                {"status": "free", "start": {"dateTime": "2026-07-06T09:00:00.0000000", "timeZone": "UTC"},
                 "end": {"dateTime": "2026-07-06T09:30:00.0000000", "timeZone": "UTC"}},
                {"status": "workingElsewhere", "start": {"dateTime": "2026-07-06T09:30:00.0000000", "timeZone": "UTC"},
                 "end": {"dateTime": "2026-07-06T10:00:00.0000000", "timeZone": "UTC"}},
                {"status": "busy", "start": {"dateTime": "2026-07-06T10:00:00.0000000", "timeZone": "UTC"},
                 "end": {"dateTime": "2026-07-06T10:30:00.0000000", "timeZone": "UTC"}},
                {"status": "tentative", "start": {"dateTime": "2026-07-06T11:00:00.0000000", "timeZone": "UTC"},
                 "end": {"dateTime": "2026-07-06T11:30:00.0000000", "timeZone": "UTC"}},
                {"status": "oof", "start": {"dateTime": "2026-07-06T12:00:00.0000000", "timeZone": "UTC"},
                 "end": {"dateTime": "2026-07-06T12:30:00.0000000", "timeZone": "UTC"}},
                {"status": "unknown", "start": {"dateTime": "2026-07-06T13:00:00.0000000", "timeZone": "UTC"},
                 "end": {"dateTime": "2026-07-06T13:30:00.0000000", "timeZone": "UTC"}},
            ]},
        ]})
    c = make_client(handler)
    out = c.query_freebusy(["a@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T23:00:00Z")
    path, body, headers = seen[0]
    assert path.endswith("/me/calendar/getSchedule")
    assert body["schedules"] == ["a@x.com"]
    assert body["startTime"] == {"dateTime": "2026-07-06T00:00:00Z", "timeZone": "UTC"}
    assert body["endTime"] == {"dateTime": "2026-07-06T23:00:00Z", "timeZone": "UTC"}
    # availabilityViewInterval must match the worker's own request (30 min) —
    # a mismatched interval would misinterpret the availabilityView fallback
    # string's per-character granularity.
    assert body["availabilityViewInterval"] == 30
    assert headers.get("prefer") == lib.GraphCalendarClient._PREFER
    assert out == {"a@x.com": {"busy": [
        {"start": "2026-07-06T10:00:00+00:00", "end": "2026-07-06T10:30:00+00:00"},
        {"start": "2026-07-06T11:00:00+00:00", "end": "2026-07-06T11:30:00+00:00"},
        {"start": "2026-07-06T12:00:00+00:00", "end": "2026-07-06T12:30:00+00:00"},
        {"start": "2026-07-06T13:00:00+00:00", "end": "2026-07-06T13:30:00+00:00"},
    ]}}


def test_graph_query_freebusy_matches_by_scheduleid_not_response_position():
    # Review fix #2 (BLOCKING): Graph does not guarantee response order —
    # microsoft-calendar-provider.ts builds a Map keyed by scheduleId. A
    # reordered/out-of-order response must still attribute the right busy
    # blocks to the right email, not silently swap them by position.
    def handler(req: httpx.Request):
        return httpx.Response(200, json={"value": [
            {"scheduleId": "b@x.com", "scheduleItems": [
                {"status": "busy", "start": {"dateTime": "2026-07-06T14:00:00.0000000", "timeZone": "UTC"},
                 "end": {"dateTime": "2026-07-06T14:30:00.0000000", "timeZone": "UTC"}},
            ]},
            {"scheduleId": "a@x.com", "scheduleItems": [
                {"status": "busy", "start": {"dateTime": "2026-07-06T10:00:00.0000000", "timeZone": "UTC"},
                 "end": {"dateTime": "2026-07-06T10:30:00.0000000", "timeZone": "UTC"}},
            ]},
        ]})
    c = make_client(handler)
    out = c.query_freebusy(["a@x.com", "b@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T23:00:00Z")
    assert out["a@x.com"]["busy"] == [{"start": "2026-07-06T10:00:00+00:00", "end": "2026-07-06T10:30:00+00:00"}]
    assert out["b@x.com"]["busy"] == [{"start": "2026-07-06T14:00:00+00:00", "end": "2026-07-06T14:30:00+00:00"}]


def test_graph_query_freebusy_scheduleid_match_is_case_insensitive():
    c = make_client(lambda req: httpx.Response(200, json={"value": [
        {"scheduleId": "A@X.COM", "scheduleItems": []},
    ]}))
    out = c.query_freebusy(["a@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T23:00:00Z")
    assert out["a@x.com"] == {"busy": []}


def test_graph_query_freebusy_per_item_error_becomes_the_response_code_string():
    # Review fix #2: mirror `s.error.responseCode ?? s.error.message ??
    # "schedule_error"` exactly — a STRING, not the raw error dict.
    c = make_client(lambda req: httpx.Response(200, json={"value": [
        {"scheduleId": "a@x.com", "error": {"responseCode": "ErrorAccessDenied"}},
    ]}))
    out = c.query_freebusy(["a@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T23:00:00Z")
    assert out["a@x.com"]["errors"] == ["ErrorAccessDenied"]


def test_graph_query_freebusy_per_item_error_falls_back_to_message_then_generic():
    c = make_client(lambda req: httpx.Response(200, json={"value": [
        {"scheduleId": "a@x.com", "error": {"message": "boom"}},
        {"scheduleId": "b@x.com", "error": {}},
    ]}))
    out = c.query_freebusy(["a@x.com", "b@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T23:00:00Z")
    assert out["a@x.com"]["errors"] == ["boom"]
    assert out["b@x.com"]["errors"] == ["schedule_error"]


def test_graph_query_freebusy_id_absent_from_response_is_missing_in_response():
    # Review fix #2: mirror the worker's exact "missing_in_response" reason
    # string for a scheduleId the response never mentions at all.
    c = make_client(lambda req: httpx.Response(200, json={"value": []}))
    out = c.query_freebusy(["a@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T23:00:00Z")
    assert out["a@x.com"]["errors"] == ["missing_in_response"]


def test_graph_query_freebusy_empty_scheduleitems_no_view_is_confirmed_free():
    # Review fix #3: scheduleItems present but empty, and no availabilityView
    # either, means Graph read the schedule and confirmed nothing — busy: [],
    # NOT an error (distinct from the id being absent entirely).
    c = make_client(lambda req: httpx.Response(200, json={"value": [
        {"scheduleId": "a@x.com", "scheduleItems": []},
    ]}))
    out = c.query_freebusy(["a@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T23:00:00Z")
    assert out["a@x.com"] == {"busy": []}


def test_graph_query_freebusy_no_schedule_detail_at_all_is_errors():
    # Neither scheduleItems nor availabilityView present on an id that DID
    # come back in the response — worker's final else, "no_schedule_detail".
    c = make_client(lambda req: httpx.Response(200, json={"value": [
        {"scheduleId": "a@x.com"},
    ]}))
    out = c.query_freebusy(["a@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T23:00:00Z")
    assert out["a@x.com"]["errors"] == ["no_schedule_detail"]


def test_graph_query_freebusy_availability_view_fallback_when_no_schedule_items():
    # Review fix #3: availability-only sharing / cross-tenant / personal
    # mailboxes omit or empty scheduleItems but carry a coarse
    # availabilityView string (0 free, 4 workingElsewhere free, else busy),
    # at 30-min granularity, floored to the nearest 30-min boundary from
    # window.start (mirrors microsoft-calendar-provider.ts exactly).
    c = make_client(lambda req: httpx.Response(200, json={"value": [
        {"scheduleId": "a@x.com", "availabilityView": "0022400"},
    ]}))
    # window.start is already on a 30-min boundary (10:00), so slot i starts
    # at 10:00 + i*30min. Slot 0='0' free, 1='0' free, 2='2' busy, 3='2' busy,
    # 4='4' workingElsewhere (free), 5='0' free, 6='0' free.
    out = c.query_freebusy(["a@x.com"], "2026-07-06T10:00:00Z", "2026-07-06T13:30:00Z")
    assert out["a@x.com"]["busy"] == [
        {"start": "2026-07-06T11:00:00+00:00", "end": "2026-07-06T11:30:00+00:00"},
        {"start": "2026-07-06T11:30:00+00:00", "end": "2026-07-06T12:00:00+00:00"},
    ]


def test_graph_query_freebusy_availability_view_floors_to_thirty_minute_boundary():
    # window.start at 10:15 (not on a 30-min boundary) must floor to 10:00
    # before indexing into the view — otherwise every slot's reported time
    # shifts by up to 30 minutes (the exact bug the worker's comment warns
    # about).
    c = make_client(lambda req: httpx.Response(200, json={"value": [
        {"scheduleId": "a@x.com", "availabilityView": "02"},
    ]}))
    out = c.query_freebusy(["a@x.com"], "2026-07-06T10:15:00Z", "2026-07-06T11:00:00Z")
    # Slot 0 (10:00-10:30, floored) is '0' free; slot 1 (10:30-11:00) is '2'
    # busy, and window.end (11:00) exactly matches the slot's natural end so
    # no clamping is visible here — see the next test for clamping.
    assert out["a@x.com"]["busy"] == [
        {"start": "2026-07-06T10:30:00+00:00", "end": "2026-07-06T11:00:00+00:00"},
    ]


def test_graph_query_freebusy_availability_view_clamps_trailing_slot_to_window_end():
    c = make_client(lambda req: httpx.Response(200, json={"value": [
        {"scheduleId": "a@x.com", "availabilityView": "2"},
    ]}))
    out = c.query_freebusy(["a@x.com"], "2026-07-06T10:00:00Z", "2026-07-06T10:10:00Z")
    assert out["a@x.com"]["busy"] == [
        {"start": "2026-07-06T10:00:00+00:00", "end": "2026-07-06T10:10:00+00:00"},
    ]


def test_graph_query_freebusy_recognised_msa_error_code_never_raises():
    # Review fix #4: ONLY a recognisable personal-mailbox-shaped error
    # degrades to `errors` for every requested email — real code TBC live by
    # WP4.3; MailboxNotEnabledForRESTAPI/ErrorAccessDenied are the documented
    # best guesses (internal design notes WP4).
    c = make_client(lambda req: httpx.Response(
        400, json={"error": {"code": "MailboxNotEnabledForRESTAPI", "message": "not supported"}}))
    out = c.query_freebusy(["a@x.com", "b@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T23:00:00Z")
    assert "errors" in out["a@x.com"] and "errors" in out["b@x.com"]


def test_graph_query_freebusy_unrecognised_400_raises():
    # Review fix #4 (SHOULD-FIX): a broken request (malformed body here)
    # must NOT be laundered into every attendee looking "invisible" — that
    # would let 2B/M2 pass for the wrong reason. Only the recognised MSA
    # error shape degrades; anything else raises.
    c = make_client(lambda req: httpx.Response(
        400, json={"error": {"code": "ErrorInvalidRequest", "message": "malformed body"}}))
    with pytest.raises(Exception):
        c.query_freebusy(["a@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T23:00:00Z")


def test_graph_query_freebusy_401_raises():
    c = make_client(lambda req: httpx.Response(401, json={"error": {"code": "InvalidAuthenticationToken"}}))
    with pytest.raises(Exception):
        c.query_freebusy(["a@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T23:00:00Z")


def test_graph_query_freebusy_400_with_no_error_body_raises():
    # No recognisable error code at all (empty/malformed body) must raise,
    # not silently degrade.
    c = make_client(lambda req: httpx.Response(400, text="not json"))
    with pytest.raises(Exception):
        c.query_freebusy(["a@x.com"], "2026-07-06T00:00:00Z", "2026-07-06T23:00:00Z")


def test_google_rsvp_method_delegates_to_rsvp_invite():
    attendees = [{"email": "attendee@x", "responseStatus": "needsAction"}]
    c = lib.CalendarClient(FakeScheduler())
    seen = []
    def handler(req: httpx.Request):
        if req.method == "GET":
            return httpx.Response(200, json={"attendees": attendees})
        seen.append(json.loads(req.content))
        return httpx.Response(200, json={})
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    c.rsvp("evt-1", "attendee@x", "accepted")
    assert seen[0]["attendees"][0]["responseStatus"] == "accepted"


def test_graph_rsvp_polls_by_icaluid_then_posts_accept(monkeypatch):
    monkeypatch.setattr(lib.time, "sleep", lambda s: None)
    calls = []
    responses = iter([
        httpx.Response(200, json={"value": []}),               # not landed yet
        httpx.Response(200, json={"value": [{"id": "attendee-copy-1"}]}),
        httpx.Response(200, json={}),                           # the accept POST
    ])
    def handler(req: httpx.Request):
        calls.append(req)
        return next(responses)
    c = make_client(handler)
    c.rsvp("uid-123", "attendee@x", "accepted")
    filter_call = calls[0]
    assert filter_call.url.path.endswith("/me/events")
    assert "iCalUId eq 'uid-123'" in filter_call.url.params["$filter"]
    accept_call = calls[-1]
    assert accept_call.url.path.endswith("/me/events/attendee-copy-1/accept")
    # Review fix #1 (BLOCKING): sendResponse MUST be True. Unlike Google's
    # sendUpdates=none PATCH (which changes state without generating a
    # message), Graph's RSVP action IS the response message — with
    # sendResponse:false Graph applies no response at all and the
    # organiser's copy keeps status.response == "none" forever, so
    # wait_for_attendee_accept (and the worker's identify.ts, which reads
    # exactly that field) never sees "accepted".
    assert json.loads(accept_call.content) == {"sendResponse": True}


def test_graph_rsvp_escapes_a_single_quote_in_the_icaluid_filter():
    # Review fix #10: an unescaped `'` in an OData string literal breaks the
    # $filter query (and, worse, is an injection vector) — OData escapes an
    # embedded quote by doubling it.
    calls = []
    def handler(req: httpx.Request):
        calls.append(req)
        if req.url.path.endswith("/me/events"):
            return httpx.Response(200, json={"value": [{"id": "copy-1"}]})
        return httpx.Response(200, json={})
    c = make_client(handler)
    c.rsvp("uid-o'brien-1", "attendee@x", "accepted")
    assert "iCalUId eq 'uid-o''brien-1'" in calls[0].url.params["$filter"]


def test_graph_rsvp_declined_posts_decline_action():
    calls = []
    def handler(req: httpx.Request):
        calls.append(req)
        if req.url.path.endswith("/me/events"):
            return httpx.Response(200, json={"value": [{"id": "copy-1"}]})
        return httpx.Response(200, json={})
    c = make_client(handler)
    c.rsvp("uid-1", "attendee@x", "declined")
    assert calls[-1].url.path.endswith("/me/events/copy-1/decline")


def test_graph_rsvp_unsupported_response_raises_valueerror():
    c = make_client(lambda req: httpx.Response(200, json={"value": []}))
    with pytest.raises(ValueError):
        c.rsvp("uid-1", "attendee@x", "maybe")


def test_graph_rsvp_never_lands_raises_assertion_error(monkeypatch):
    monkeypatch.setattr(lib.time, "sleep", lambda s: None)
    fake_time = iter([0.0, 0.1, 100.0])
    monkeypatch.setattr(lib.time, "monotonic", lambda: next(fake_time))
    c = make_client(lambda req: httpx.Response(200, json={"value": []}))
    with pytest.raises(AssertionError):
        c.rsvp("uid-1", "attendee@x", "accepted", timeout=1.0)


def test_google_set_visibility_freebusyreader_inserts_acl():
    seen = []
    def handler(req: httpx.Request):
        seen.append((req.method, req.url.path, json.loads(req.content) if req.content else None))
        return httpx.Response(200, json={})
    c = lib.CalendarClient(FakeScheduler())
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    c.set_visibility("grantee@x", "freeBusyReader", "owner-label")
    assert seen[0][:2] == ("POST", "/calendar/v3/calendars/primary/acl")
    assert seen[0][2]["role"] == "freeBusyReader"


def test_google_set_visibility_none_deletes_acl():
    seen = []
    def handler(req: httpx.Request):
        seen.append((req.method, req.url.path))
        return httpx.Response(204)
    c = lib.CalendarClient(FakeScheduler())
    c._client = httpx.Client(transport=httpx.MockTransport(handler))
    c.set_visibility("grantee@x", "none", "owner-label")
    assert seen[0] == ("DELETE", "/calendar/v3/calendars/primary/acl/user:grantee@x")


def _perms_page(role: str = "freeBusyRead"):
    # calendarRoleType is a real Graph enum (none/freeBusyRead/limitedRead/
    # read/write/delegate…/custom) — "availabilityOnly" (the old fixture
    # default) is not a member of it (review fix #5).
    return {"value": [
        {"id": "perm-other", "role": "read", "isInsideOrganization": True, "isRemovable": True,
         "emailAddress": {"address": "someone@x.com", "name": "Someone"}},
        {"id": "perm-org-default", "role": role, "isInsideOrganization": True, "isRemovable": False,
         "emailAddress": {"name": "My Organization"}},
    ]}


def test_graph_set_visibility_patches_the_org_default_permission():
    calls = []
    def handler(req: httpx.Request):
        calls.append(req)
        if req.method == "GET":
            return httpx.Response(200, json=_perms_page())
        return httpx.Response(200, json={})
    c = make_client(handler)
    c.set_visibility("ignored-grantee@x", "freeBusyReader", "owner-label")
    patch_call = calls[-1]
    assert patch_call.method == "PATCH"
    assert patch_call.url.path.endswith("/me/calendar/calendarPermissions/perm-org-default")
    assert json.loads(patch_call.content) == {"role": "freeBusyRead"}


def test_graph_set_visibility_none_maps_to_none_role():
    calls = []
    def handler(req: httpx.Request):
        calls.append(req)
        if req.method == "GET":
            return httpx.Response(200, json=_perms_page())
        return httpx.Response(200, json={})
    c = make_client(handler)
    c.set_visibility("ignored@x", "none", "owner-label")
    assert json.loads(calls[-1].content) == {"role": "none"}


def test_graph_set_visibility_403_on_patch_raises_visibility_error():
    def handler(req: httpx.Request):
        if req.method == "GET":
            return httpx.Response(200, json=_perms_page())
        return httpx.Response(403, text="Access denied")
    c = make_client(handler)
    with pytest.raises(lib.VisibilityError):
        c.set_visibility("ignored@x", "freeBusyReader", "owner-label")


def test_graph_set_visibility_403_on_list_raises_visibility_error():
    c = make_client(lambda req: httpx.Response(403, text="Access denied"))
    with pytest.raises(lib.VisibilityError):
        c.set_visibility("ignored@x", "freeBusyReader", "owner-label")


def test_graph_set_visibility_missing_org_default_raises_visibility_error():
    c = make_client(lambda req: httpx.Response(200, json={"value": []}))
    with pytest.raises(lib.VisibilityError):
        c.set_visibility("ignored@x", "freeBusyReader", "owner-label")


# --- org-default matched structurally, not by localised display name --------
# Review fix #5: a tenant can localise "My Organization" to another
# language, so the PRIMARY match is structural — isInsideOrganization is
# True AND (no emailAddress.address OR isRemovable is False) — with the
# English name used only to break a tie among multiple structural matches.

def test_graph_org_default_matched_structurally_even_with_a_localised_name():
    c = make_client(lambda req: httpx.Response(200, json={"value": [
        {"id": "perm-a", "role": "read", "isInsideOrganization": True, "isRemovable": True,
         "emailAddress": {"address": "someone@x.com", "name": "Someone"}},
        {"id": "perm-org-default", "role": "freeBusyRead", "isInsideOrganization": True,
         "isRemovable": False, "emailAddress": {"name": "Ma Organisation"}},  # localised, not "My Organization"
    ]}))
    assert c.list_freebusy_grantees() == ["<org-default>"]


def test_graph_org_default_excludes_entries_outside_the_organization():
    # An external/guest sharing entry with no address could otherwise look
    # structurally similar — isInsideOrganization must be True.
    c = make_client(lambda req: httpx.Response(200, json={"value": [
        {"id": "perm-external", "role": "freeBusyRead", "isInsideOrganization": False,
         "isRemovable": False, "emailAddress": {"name": "My Organization"}},
    ]}))
    with pytest.raises(lib.VisibilityError):
        c.set_visibility("ignored@x", "freeBusyReader", "owner-label")


def test_graph_org_default_requires_no_address_or_isremovable_false():
    # A real person's entry with an address AND isRemovable True never
    # qualifies, even if isInsideOrganization is True.
    c = make_client(lambda req: httpx.Response(200, json={"value": [
        {"id": "perm-person", "role": "read", "isInsideOrganization": True, "isRemovable": True,
         "emailAddress": {"address": "person@x.com", "name": "Person"}},
    ]}))
    with pytest.raises(lib.VisibilityError):
        c.set_visibility("ignored@x", "freeBusyReader", "owner-label")


def test_graph_org_default_address_present_but_not_removable_still_qualifies():
    # "no address OR isRemovable is False" — a non-removable entry with an
    # address still counts (some tenants may shape it this way).
    c = make_client(lambda req: httpx.Response(200, json={"value": [
        {"id": "perm-org-default", "role": "freeBusyRead", "isInsideOrganization": True,
         "isRemovable": False, "emailAddress": {"address": "org@x.com", "name": "Ma Organisation"}},
    ]}))
    assert c.list_freebusy_grantees() == ["<org-default>"]


def test_graph_org_default_ambiguous_structural_matches_use_name_as_tiebreaker():
    calls = []
    def handler(req):
        calls.append(req)
        if req.method == "GET":
            return httpx.Response(200, json={"value": [
                {"id": "perm-decoy", "role": "read", "isInsideOrganization": True, "isRemovable": False,
                 "emailAddress": {"name": "Some Other Default"}},
                {"id": "perm-org-default", "role": "freeBusyRead", "isInsideOrganization": True,
                 "isRemovable": False, "emailAddress": {"name": "My Organization"}},
            ]})
        return httpx.Response(200, json={})
    c2 = make_client(handler)
    c2.set_visibility("ignored@x", "none", "owner-label")
    assert calls[-1].url.path.endswith("/me/calendar/calendarPermissions/perm-org-default")


def test_graph_list_freebusy_grantees_visible_returns_org_default_sentinel():
    c = make_client(lambda req: httpx.Response(200, json=_perms_page(role="freeBusyRead")))
    assert c.list_freebusy_grantees() == ["<org-default>"]


def test_graph_list_freebusy_grantees_none_role_returns_empty():
    c = make_client(lambda req: httpx.Response(200, json=_perms_page(role="none")))
    assert c.list_freebusy_grantees() == []


# --- visibility snapshot/restore (review fix #6) -----------------------------
# Graph's visibility is a single shared org-default field per owner, not an
# additive per-grantee ACL rule the way Google's is — a startup sweep or
# teardown that just sets it to "none" permanently narrows the tenant's real
# sharing default. bin/meeting-smoke.py now captures each owner's role
# BEFORE anything in a run touches it, and restores exactly that value in
# teardown (Google's equivalent is a no-op: its delete-only-what-we-created
# semantics via RunContext.acl_grants already restore exactly, so no
# separate capture is needed there).

def test_graph_snapshot_visibility_reads_the_current_role():
    c = make_client(lambda req: httpx.Response(200, json=_perms_page(role="limitedRead")))
    assert c.snapshot_visibility() == "limitedRead"


def test_graph_snapshot_visibility_no_org_default_entry_is_none_role():
    c = make_client(lambda req: httpx.Response(200, json={"value": []}))
    assert c.snapshot_visibility() == "none"


def test_graph_restore_visibility_patches_back_the_exact_snapshotted_role():
    # Unlike set_visibility (which only distinguishes "none" from
    # "freeBusyRead" for the two states scenarios need), restore must patch
    # back the EXACT original role — e.g. "limitedRead" — not silently
    # coarsen a tenant's real default to "freeBusyRead".
    calls = []
    def handler(req: httpx.Request):
        calls.append(req)
        if req.method == "GET":
            return httpx.Response(200, json=_perms_page(role="limitedRead"))
        return httpx.Response(200, json={})
    c = make_client(handler)
    c.restore_visibility("limitedRead")
    patch_call = calls[-1]
    assert patch_call.method == "PATCH"
    assert patch_call.url.path.endswith("/me/calendar/calendarPermissions/perm-org-default")
    assert json.loads(patch_call.content) == {"role": "limitedRead"}


def test_graph_restore_visibility_none_snapshot_is_a_noop():
    calls = []
    c = make_client(lambda req: (calls.append(req), httpx.Response(200, json={}))[1])
    c.restore_visibility(None)
    assert calls == []


def test_google_snapshot_and_restore_visibility_are_noops():
    c = lib.CalendarClient(FakeScheduler())
    calls = []
    c._client = httpx.Client(transport=httpx.MockTransport(
        lambda req: (calls.append(req), httpx.Response(200, json={}))[1]))
    assert c.snapshot_visibility() is None
    c.restore_visibility("anything")
    assert calls == []  # never makes a network call — Google's acl_grants tracking already restores exactly


def test_visibility_error_and_aclscopeerror_are_the_same_class():
    # WP4: AclScopeError renamed to the provider-neutral VisibilityError, kept
    # as a plain alias so meeting-smoke.py's `except AclScopeError` catches a
    # Graph VisibilityError identically (mirrors GmailScopeError/MailScopeError).
    assert lib.AclScopeError is lib.VisibilityError
    with pytest.raises(lib.AclScopeError):
        raise lib.VisibilityError("x")
    with pytest.raises(lib.VisibilityError):
        raise lib.AclScopeError("x")


def test_rsvp_as_attendee_uses_the_plain_event_id_for_google():
    calls = []
    class FakeGoogleCal(lib.CalendarClient):
        def __init__(self):
            pass
        def rsvp(self, event_id, self_email, response, timeout=30.0):
            calls.append(("rsvp", event_id, self_email, response))
    organiser = FakeGoogleCal()
    attendee = FakeGoogleCal()
    lib.rsvp_as_attendee(organiser, attendee, "evt-123", "att@x", "accepted")
    assert calls == [("rsvp", "evt-123", "att@x", "accepted")]


def test_rsvp_as_attendee_resolves_icaluid_for_graph():
    calls = []
    class FakeOrganiserCal(lib.GraphCalendarClient):
        def __init__(self):
            pass
        def get_event_icaluid(self, event_id):
            calls.append(("icaluid_lookup", event_id))
            return "uid-resolved"
    class FakeAttendeeCal(lib.GraphCalendarClient):
        def __init__(self):
            pass
        def rsvp(self, ical_uid, self_email, response, timeout=30.0):
            calls.append(("rsvp", ical_uid, self_email, response))
    lib.rsvp_as_attendee(FakeOrganiserCal(), FakeAttendeeCal(), "graph-evt-1", "att@x", "accepted")
    assert calls == [
        ("icaluid_lookup", "graph-evt-1"),
        ("rsvp", "uid-resolved", "att@x", "accepted"),
    ]


def test_check_whoami_body_matching_email_and_provider_is_no_error_no_warning():
    body = {"email": "a@x.example", "provider": "microsoft"}
    assert lib.check_whoami_body(body, "a@x.example", "microsoft", "A") == (None, None)


def test_check_whoami_body_provider_mismatch_names_both():
    body = {"email": "a@x.example", "provider": "google"}
    err, warning = lib.check_whoami_body(body, "a@x.example", "microsoft", "A")
    assert warning is None
    assert err is not None and "google" in err and "microsoft" in err


def test_check_whoami_body_case_only_email_difference_is_a_specific_failure():
    body = {"email": "A@X.EXAMPLE", "provider": "google"}
    err, warning = lib.check_whoami_body(body, "a@x.example", "google", "B")
    assert warning is None
    assert err is not None and "B_EXPECTED_EMAIL" in err


def test_check_whoami_body_without_provider_is_a_warning_not_an_error():
    body = {"email": "a@x.example"}
    err, warning = lib.check_whoami_body(body, "a@x.example", "microsoft", "A")
    assert err is None
    assert warning is not None and "provider" in warning


# --- provider factory + done-colour defaults ---------------------------------

def test_make_calendar_client_by_provider():
    assert isinstance(lib.make_calendar_client(FakeScheduler(), "google"), lib.CalendarClient)
    assert isinstance(lib.make_calendar_client(FakeScheduler(), "microsoft"), lib.GraphCalendarClient)
    with pytest.raises(ValueError):
        lib.make_calendar_client(FakeScheduler(), "icloud")


def test_done_marking_per_provider(monkeypatch):
    monkeypatch.delenv("SMOKE_DONE_COLOR_ID", raising=False)
    g = lib.DoneMarking.for_provider("google")
    assert (g.done, g.undone) == ("11", "5")
    m = lib.DoneMarking.for_provider("microsoft")
    assert (m.done, m.undone) == ("Optical Done", "")
    with pytest.raises(ValueError):
        lib.DoneMarking.for_provider("icloud")


def test_done_marking_env_override_wins_for_done_only(monkeypatch):
    monkeypatch.setenv("SMOKE_DONE_COLOR_ID", "7")
    g = lib.DoneMarking.for_provider("google")
    assert (g.done, g.undone) == ("7", "5")


# --- D1 helper targets the env's binding, not a hardcoded scheduler-dev -------

# A non-default [env.<name>] block, to prove the env is a parameter.
_OTHER_ENV = "staging"


def test_dev_d1_command_is_env_parameterised():
    d = lib.DevD1(repo_root=pathlib.Path("/repo"), env_name=_OTHER_ENV)
    cmd = d._cmd("SELECT 1")
    assert cmd[:4] == ["npx", "wrangler", "d1", "execute"]
    assert "DB" in cmd and "--env" in cmd and cmd[cmd.index("--env") + 1] == _OTHER_ENV
    assert "scheduler-dev" not in cmd
    default = lib.DevD1(repo_root=pathlib.Path("/repo"))._cmd("SELECT 1")
    assert default[default.index("--env") + 1] == "dev"


def test_smoke_dbs_are_allowed_targets_and_prod_never_is():
    lib.assert_dev_db(lib.DEV_DB_ID)
    with pytest.raises(SystemExit):
        lib.assert_dev_db(lib.PROD_DB_ID)


# --- regression-smoke.py wiring ----------------------------------------------

def _load_regsmoke():
    spec = importlib.util.spec_from_file_location(
        "regsmoke", pathlib.Path(__file__).parent / "regression-smoke.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_regsmoke_provider_flag_defaults_to_google(monkeypatch):
    monkeypatch.delenv("SMOKE_PROVIDER", raising=False)
    rs = _load_regsmoke()
    assert rs.parse_args([]).provider == "google"
    assert rs.parse_args(["--provider", "microsoft"]).provider == "microsoft"
    monkeypatch.setenv("SMOKE_PROVIDER", "microsoft")
    assert _load_regsmoke().parse_args([]).provider == "microsoft"
    # WP2 review finding 6: SMOKE_PROVIDER="" (unset-but-exported) must not
    # bypass --provider's `choices` validation by becoming the literal
    # argparse default.
    monkeypatch.setenv("SMOKE_PROVIDER", "")
    assert _load_regsmoke().parse_args([]).provider == "google"


def test_regsmoke_single_marking_object_drives_every_level(monkeypatch):
    monkeypatch.delenv("SMOKE_DONE_COLOR_ID", raising=False)
    rs = _load_regsmoke()
    # No per-level colour constants survive — one MARKING, set by provider.
    for name in ("DONE_COLOR_ID", "_L6_UNDONE_COLOR_ID", "_L7_UNDONE_COLOR_ID", "apply_provider_defaults"):
        assert not hasattr(rs, name), name
    # regression-smoke loads its own _smoke_lib copy, so compare fields, not class identity.
    rs.set_marking("microsoft")
    assert (rs.MARKING.done, rs.MARKING.undone) == ("Optical Done", "")
    rs.set_marking("google")
    assert (rs.MARKING.done, rs.MARKING.undone) == ("11", "5")


def test_regsmoke_recolor_delegates_to_client():
    rs = _load_regsmoke()
    seen = []
    class Cal:
        def recolor_event(self, event_id, color_id):
            seen.append((event_id, color_id))
    rs.recolor_event(Cal(), "e1", "Optical Done")
    assert seen == [("e1", "Optical Done")]


def test_regsmoke_smoke_dbs_allowed_and_d1_read_env(monkeypatch):
    rs = _load_regsmoke()
    assert lib.DEV_DB_ID in rs.ALLOWED_DEV_DB_IDS
    assert lib.PROD_DB_ID not in rs.ALLOWED_DEV_DB_IDS
    monkeypatch.delenv("SMOKE_WRANGLER_ENV", raising=False)
    cmd = rs._d1_read_task_cmd("abc")
    assert cmd[cmd.index("--env") + 1] == "dev" and "DB" in cmd
    monkeypatch.setenv("SMOKE_WRANGLER_ENV", _OTHER_ENV)
    cmd = rs._d1_read_task_cmd("abc")
    assert cmd[cmd.index("--env") + 1] == _OTHER_ENV and "DB" in cmd


def test_reset_smoke_env_has_provider_flag(monkeypatch):
    monkeypatch.delenv("SMOKE_PROVIDER", raising=False)
    spec = importlib.util.spec_from_file_location(
        "resetsmoke", pathlib.Path(__file__).parent / "reset-smoke-env.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    assert mod.build_parser().parse_args([]).provider == "google"
    assert mod.build_parser().parse_args(["--provider", "microsoft"]).provider == "microsoft"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
