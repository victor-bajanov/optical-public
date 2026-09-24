-- 0035_booking_cancel_pending.sql — decline auto-cancel grace state.
--
-- Nullable stamp, not a new `status` value: the claim-time overlap guards,
-- `listBookings`, and the poll existence check all key off
-- `status IN ('reserving','confirmed')` (db/bookings.ts), so a pending-cancel
-- booking must stay 'confirmed' and keep blocking its slot until the sweep
-- actually cancels it. NULL means no decline observed (or a since-cleared one).
ALTER TABLE bookings ADD COLUMN cancel_pending_at TEXT;

-- The 5-minute global sweep (listCancelPendingDue) queries this column on
-- every tick; a plain column scan would walk the whole (never-shrinking)
-- table. Partial: almost every row's stamp is NULL.
CREATE INDEX bookings_cancel_pending ON bookings(cancel_pending_at) WHERE cancel_pending_at IS NOT NULL;
