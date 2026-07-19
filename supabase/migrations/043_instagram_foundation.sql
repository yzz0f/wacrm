-- ============================================================
-- 043_instagram_foundation.sql — Instagram DM support (foundation)
--
-- Sub-proyecto 1 of 4 of the Instagram effort (see
-- docs/superpowers/specs/2026-07-19-instagram-foundation-design.md).
-- Adds the schema needed for a second channel type alongside
-- WhatsApp: contact identity that doesn't require a phone number,
-- an instagram_accounts table (modeled on whatsapp_lines,
-- 037_whatsapp_lines.sql), and a conversations column pair that lets
-- a thread belong to exactly one channel account of either type.
--
-- What this migration does
--   1. contacts.phone becomes nullable; adds `platform` (whatsapp |
--      instagram, default 'whatsapp' for backfill) and `external_id`
--      (the IGSID for an Instagram contact; NULL for WhatsApp
--      contacts, which keep using `phone`). New partial unique index
--      dedupes Instagram contacts by (account_id, platform,
--      external_id) — does NOT touch idx_contacts_account_phone_
--      normalized (022_contact_phone_dedup.sql), which keeps
--      deduping WhatsApp contacts by phone exactly as before.
--   2. instagram_accounts — one row per connected Instagram
--      business account, same shape/RLS tier as whatsapp_lines.
--   3. conversations.line_id — NOT NULL since
--      038_whatsapp_lines_finalize.sql — is relaxed back to nullable,
--      and a nullable instagram_account_id sibling is added. A CHECK
--      constraint enforces exactly one of the two is set: a
--      conversation belongs to exactly one channel account, of
--      either type. The account_id/contact_id/line_id dedup unique
--      index (037_whatsapp_lines.sql) is widened to include
--      instagram_account_id so it keeps working with either column
--      populated.
--
-- What this migration does NOT touch
--   - is_account_member(), can_access_line() — untouched.
--   - idx_contacts_account_phone_normalized — untouched; WhatsApp
--     contact dedup is unaffected.
--   - Templates, broadcasts, automations, Flows, AI auto-reply for
--     Instagram — out of scope for this sub-project (2-4 handle
--     those), nothing here wires into any of them.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- CONTACTS: platform + external_id, phone becomes nullable
-- ============================================================
ALTER TABLE contacts
  ALTER COLUMN phone DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (platform IN ('whatsapp', 'instagram')),
  ADD COLUMN IF NOT EXISTS external_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_platform_external_id
  ON contacts (account_id, platform, external_id)
  WHERE external_id IS NOT NULL;

-- ============================================================
-- INSTAGRAM_ACCOUNTS
-- ============================================================
CREATE TABLE IF NOT EXISTS instagram_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Sender-of-record for inserts that need a NOT NULL user_id FK
  -- (contacts, conversations) when a DM arrives on this account —
  -- same reasoning as whatsapp_lines.user_id (037_whatsapp_lines.sql).
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Instagram',
  instagram_business_account_id TEXT NOT NULL,
  -- Instagram Messaging requires the IG business account to be
  -- linked to a Facebook Page; the webhook subscription lives at
  -- the Page level, not the IG account directly.
  page_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  connected_at TIMESTAMPTZ,
  registered_at TIMESTAMPTZ,
  subscribed_apps_at TIMESTAMPTZ,
  last_registration_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_accounts_ig_business_id
  ON instagram_accounts (instagram_business_account_id);

ALTER TABLE instagram_accounts ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON instagram_accounts;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Same tier as whatsapp_lines: settings-class, admin+ writes, any
-- member reads.
DROP POLICY IF EXISTS instagram_accounts_select ON instagram_accounts;
DROP POLICY IF EXISTS instagram_accounts_insert ON instagram_accounts;
DROP POLICY IF EXISTS instagram_accounts_update ON instagram_accounts;
DROP POLICY IF EXISTS instagram_accounts_delete ON instagram_accounts;
CREATE POLICY instagram_accounts_select ON instagram_accounts FOR SELECT USING (is_account_member(account_id));
CREATE POLICY instagram_accounts_insert ON instagram_accounts FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY instagram_accounts_update ON instagram_accounts FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY instagram_accounts_delete ON instagram_accounts FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- CONVERSATIONS: instagram_account_id sibling to line_id
-- ============================================================
ALTER TABLE conversations
  ALTER COLUMN line_id DROP NOT NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS instagram_account_id UUID REFERENCES instagram_accounts(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'one_channel_account'
  ) THEN
    ALTER TABLE conversations ADD CONSTRAINT one_channel_account CHECK (
      (line_id IS NOT NULL AND instagram_account_id IS NULL) OR
      (line_id IS NULL AND instagram_account_id IS NOT NULL)
    );
  END IF;
END $$;

-- Widen the dedup unique index (037_whatsapp_lines.sql) so it keeps
-- working with either line_id or instagram_account_id populated —
-- exactly one is non-null per row, so this is equivalent to the old
-- constraint for WhatsApp rows and adds the same guarantee for
-- Instagram rows.
DROP INDEX IF EXISTS idx_conversations_account_contact_line;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_channel
  ON conversations (account_id, contact_id, line_id, instagram_account_id);
