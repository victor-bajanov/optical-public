-- 0004_webhook_channels.sql — extend calendar_sync with Google webhook channel detail.

ALTER TABLE calendar_sync ADD COLUMN channel_resource_id TEXT;
ALTER TABLE calendar_sync ADD COLUMN channel_callback_url TEXT;
