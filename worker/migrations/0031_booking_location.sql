-- 0031_booking_location.sql — booker-selected meeting type.
--
-- The booker now chooses how the meeting happens, from a set the owner
-- constrains, and supplies a phone number or a place where the kind needs one.
-- Both columns are nullable: every row written before this migration predates
-- the choice, and backfilling them would invent an answer nobody gave.
ALTER TABLE bookings ADD COLUMN location_kind   TEXT;
ALTER TABLE bookings ADD COLUMN location_detail TEXT;

-- config_booking_page.body is JSON, so the config change needs no DDL — but the
-- '__default__' row still holds the old {"mode","detail"} object written by
-- 0030. loadBookingPage merges shallowly, so leaving it would let the legacy
-- shape override the new default for every user. json_set replaces just that
-- key and leaves the rest of the body alone.
UPDATE config_booking_page
   SET body = json_set(
         body,
         '$.location',
         json('{"modes":[{"kind":"meet"},{"kind":"phone"},{"kind":"in_person"}]}')
       )
 WHERE owner_subject = '__default__';
