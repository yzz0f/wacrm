-- ============================================================
-- 044_instagram_broadcasts.sql — Instagram broadcasts (sub-proyecto
-- 2 of 4 of the Instagram effort)
--
-- Instagram has no approved-template mechanism like WhatsApp, so a
-- "broadcast" there is a free-text message attempted only within the
-- 24-hour messaging window. Mirrors the conversations.line_id /
-- instagram_account_id pattern from 043_instagram_foundation.sql.
--
-- What this migration does
--   1. broadcasts.line_id and .template_name — both NOT NULL since
--      earlier migrations — relax to nullable. A broadcast row for
--      Instagram has no line and no template.
--   2. Adds instagram_account_id (nullable FK) and message_text
--      (the free-text body, Instagram-only).
--   3. one_channel_account_broadcast CHECK — exactly one of line_id /
--      instagram_account_id is set, same "belongs to exactly one of
--      N parents" pattern already used on conversations.
--
-- What this migration does NOT touch
--   - broadcast_recipients — its status/error_message columns are
--     already channel-agnostic, no changes needed.
--   - The aggregate-count trigger on broadcasts (sent_count etc.) —
--     untouched, still owns those columns.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE broadcasts
  ALTER COLUMN line_id DROP NOT NULL,
  ALTER COLUMN template_name DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS instagram_account_id UUID REFERENCES instagram_accounts(id),
  ADD COLUMN IF NOT EXISTS message_text TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'one_channel_account_broadcast'
  ) THEN
    ALTER TABLE broadcasts ADD CONSTRAINT one_channel_account_broadcast CHECK (
      (line_id IS NOT NULL AND instagram_account_id IS NULL) OR
      (line_id IS NULL AND instagram_account_id IS NOT NULL)
    );
  END IF;
END $$;
