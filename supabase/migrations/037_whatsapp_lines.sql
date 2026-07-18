-- ============================================================
-- 037_whatsapp_lines.sql — Multi-number per account
--
-- Renames whatsapp_config's role into whatsapp_lines: an account
-- can now own more than one WhatsApp number ("line"), each with its
-- own credentials/WABA. whatsapp_config itself is left in place
-- (still the source of truth) until every call site has migrated —
-- see docs/superpowers/plans/2026-07-18-multi-number-lines-plan.md
-- Fase 10 for the DROP TABLE step.
--
-- What this migration does
--   1. Creates whatsapp_lines (same shape as whatsapp_config today,
--      plus `name` and `is_default`), RLS identical to
--      whatsapp_config's existing policies.
--   2. Copies every existing whatsapp_config row into whatsapp_lines
--      as that account's single, default line.
--   3. Adds nullable `line_id` to conversations, message_templates,
--      broadcasts (backfilled from the account's one migrated line)
--      and to automations, flows (left NULL — "applies to all
--      lines", the documented default).
--   4. Creates line_access (per-line allow-list for agent/viewer
--      roles) and backfills one row per existing agent/viewer
--      profile × their account's migrated line, so nobody loses
--      access to what they already saw.
--   5. Adds can_access_line(), a SECURITY DEFINER helper that
--      owners/admins always pass, and agent/viewer only pass with an
--      explicit line_access row (deny-by-default for new lines).
--   6. Extends conversations'/messages' RLS to also require
--      can_access_line(line_id) for agent/viewer roles.
--
-- What this migration does NOT do
--   - Does NOT set line_id NOT NULL yet (Fase 10, after every call
--     site is confirmed migrated).
--   - Does NOT drop whatsapp_config (Fase 10).
--   - Does NOT touch is_account_member() itself — can_access_line()
--     is an additive helper that calls it, so the ~13 unrelated
--     tables that already call is_account_member() are unaffected.
--
-- Idempotent — safe to run multiple times, same conventions as 017.
-- ============================================================

-- ============================================================
-- WHATSAPP_LINES
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Sender-of-record for inserts that need a NOT NULL user_id FK
  -- (contacts, conversations) when a message arrives on this line.
  -- Carried over from whatsapp_config — still actively read by the
  -- webhook (see processMessage's configOwnerUserId param).
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Línea principal',
  phone_number_id TEXT NOT NULL,
  waba_id TEXT,
  access_token TEXT NOT NULL,
  verify_token TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  connected_at TIMESTAMPTZ,
  registered_at TIMESTAMPTZ,
  subscribed_apps_at TIMESTAMPTZ,
  last_registration_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (phone_number_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_lines_account ON whatsapp_lines(account_id);

-- Index supports the "find all numbers awaiting registration" query
-- — carried over from 015_whatsapp_config_registration.sql.
CREATE INDEX IF NOT EXISTS idx_whatsapp_lines_registered_at
  ON whatsapp_lines (registered_at)
  WHERE registered_at IS NULL;

-- Exactly one default line per account. Postgres has no
-- CREATE UNIQUE INDEX IF NOT EXISTS ... guard issue here (index
-- creation already supports IF NOT EXISTS, unlike ADD CONSTRAINT).
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_lines_one_default_per_account
  ON whatsapp_lines(account_id)
  WHERE is_default;

ALTER TABLE whatsapp_lines ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_lines;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_lines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Same tier as whatsapp_config today (settings-class: admin+ writes,
-- any member reads).
DROP POLICY IF EXISTS whatsapp_lines_select ON whatsapp_lines;
DROP POLICY IF EXISTS whatsapp_lines_insert ON whatsapp_lines;
DROP POLICY IF EXISTS whatsapp_lines_update ON whatsapp_lines;
DROP POLICY IF EXISTS whatsapp_lines_delete ON whatsapp_lines;
CREATE POLICY whatsapp_lines_select ON whatsapp_lines FOR SELECT USING (is_account_member(account_id));
CREATE POLICY whatsapp_lines_insert ON whatsapp_lines FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY whatsapp_lines_update ON whatsapp_lines FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY whatsapp_lines_delete ON whatsapp_lines FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- DATA MIGRATION — one whatsapp_config row becomes one default line
--
-- Idempotent via NOT EXISTS on phone_number_id (already UNIQUE, so
-- this also naturally no-ops on re-run).
-- ============================================================
INSERT INTO whatsapp_lines (
  account_id, user_id, name, phone_number_id, waba_id, access_token,
  verify_token, status, is_default, connected_at, registered_at,
  subscribed_apps_at, last_registration_error, created_at, updated_at
)
SELECT
  wc.account_id, wc.user_id, 'Línea principal', wc.phone_number_id, wc.waba_id,
  wc.access_token, wc.verify_token, wc.status, true, wc.connected_at,
  wc.registered_at, wc.subscribed_apps_at, wc.last_registration_error,
  wc.created_at, wc.updated_at
FROM whatsapp_config wc
WHERE NOT EXISTS (
  SELECT 1 FROM whatsapp_lines wl WHERE wl.phone_number_id = wc.phone_number_id
);

-- ============================================================
-- line_id ON conversations / message_templates / broadcasts
--
-- Nullable for now (Fase 10 applies NOT NULL after every call site
-- is confirmed migrated). Backfilled here from the account's single
-- migrated line — every existing account has exactly one at this
-- point in the migration.
-- ============================================================
ALTER TABLE conversations      ADD COLUMN IF NOT EXISTS line_id UUID REFERENCES whatsapp_lines(id);
ALTER TABLE message_templates  ADD COLUMN IF NOT EXISTS line_id UUID REFERENCES whatsapp_lines(id);
ALTER TABLE broadcasts         ADD COLUMN IF NOT EXISTS line_id UUID REFERENCES whatsapp_lines(id);

-- automations/flows: nullable, no backfill — NULL means "applies to
-- all lines of the account", which is the documented default and
-- matches every existing row's current (line-less) behaviour exactly.
ALTER TABLE automations ADD COLUMN IF NOT EXISTS line_id UUID REFERENCES whatsapp_lines(id);
ALTER TABLE flows       ADD COLUMN IF NOT EXISTS line_id UUID REFERENCES whatsapp_lines(id);

UPDATE conversations c
SET line_id = wl.id
FROM whatsapp_lines wl
WHERE wl.account_id = c.account_id
  AND wl.is_default
  AND c.line_id IS NULL;

UPDATE message_templates t
SET line_id = wl.id
FROM whatsapp_lines wl
WHERE wl.account_id = t.account_id
  AND wl.is_default
  AND t.line_id IS NULL;

UPDATE broadcasts b
SET line_id = wl.id
FROM whatsapp_lines wl
WHERE wl.account_id = b.account_id
  AND wl.is_default
  AND b.line_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_line       ON conversations(line_id);
CREATE INDEX IF NOT EXISTS idx_message_templates_line   ON message_templates(line_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_line           ON broadcasts(line_id);
CREATE INDEX IF NOT EXISTS idx_automations_line          ON automations(line_id);
CREATE INDEX IF NOT EXISTS idx_flows_line                ON flows(line_id);

-- ============================================================
-- LINE_ACCESS — per-line allow-list for agent/viewer roles
--
-- owner/admin never consult this table (bypass via
-- is_account_member(..., 'admin') inside can_access_line() below).
-- A profile with zero rows for a given line does not see it — the
-- one exception is the migration backfill immediately below, which
-- grants every existing agent/viewer access to the line their
-- account already had, so nobody's access regresses on upgrade day.
-- ============================================================
CREATE TABLE IF NOT EXISTS line_access (
  line_id UUID NOT NULL REFERENCES whatsapp_lines(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (line_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_line_access_profile ON line_access(profile_id);

ALTER TABLE line_access ENABLE ROW LEVEL SECURITY;

-- Managed by account admins only — same tier as whatsapp_lines
-- itself. Resolves the line's account_id via a join since line_access
-- has no account_id column of its own (avoids denormalising it).
DROP POLICY IF EXISTS line_access_select ON line_access;
DROP POLICY IF EXISTS line_access_modify ON line_access;
CREATE POLICY line_access_select ON line_access FOR SELECT USING (
  EXISTS (SELECT 1 FROM whatsapp_lines wl WHERE wl.id = line_access.line_id AND is_account_member(wl.account_id))
);
CREATE POLICY line_access_modify ON line_access FOR ALL USING (
  EXISTS (SELECT 1 FROM whatsapp_lines wl WHERE wl.id = line_access.line_id AND is_account_member(wl.account_id, 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM whatsapp_lines wl WHERE wl.id = line_access.line_id AND is_account_member(wl.account_id, 'admin'))
);

-- Backfill: every current agent/viewer of a migrated account gets
-- access to that account's (single, default) line.
INSERT INTO line_access (line_id, profile_id)
SELECT wl.id, p.id
FROM profiles p
JOIN whatsapp_lines wl ON wl.account_id = p.account_id AND wl.is_default
WHERE p.account_role IN ('agent', 'viewer')
ON CONFLICT (line_id, profile_id) DO NOTHING;

-- ============================================================
-- can_access_line() — SECURITY DEFINER, mirrors is_account_member's
-- shape but adds line-level granularity for agent/viewer roles only.
--
-- Deliberately NOT a modification of is_account_member() itself —
-- that function is called by ~13 tables with no concept of "line";
-- changing its signature would touch all of them. This is an
-- additive helper that calls it, keeping the blast radius to just
-- conversations/messages (the only tables with per-line RLS).
-- ============================================================
CREATE OR REPLACE FUNCTION can_access_line(target_line_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- owner/admin: always, regardless of line_access.
    is_account_member(
      (SELECT account_id FROM whatsapp_lines WHERE id = target_line_id),
      'admin'
    )
    OR
    -- agent/viewer: only with an explicit line_access row.
    EXISTS (
      SELECT 1
      FROM line_access la
      JOIN profiles p ON p.id = la.profile_id
      WHERE la.line_id = target_line_id
        AND p.user_id = auth.uid()
    );
$$;

ALTER FUNCTION can_access_line(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_access_line(UUID) TO authenticated, service_role;

-- ============================================================
-- RLS — conversations / messages gain line-level granularity
--
-- Re-runnable: drop-then-recreate, same idiom as 017.
-- account-level membership is still required (is_account_member) —
-- can_access_line() only narrows further for agent/viewer, it never
-- widens access beyond the account.
--
-- `line_id IS NULL OR can_access_line(line_id)`: line_id is still
-- nullable at this point in the rollout (Fase 10 sets NOT NULL once
-- every call site is confirmed migrated). Treating NULL as
-- unrestricted avoids a transition window where rows backfilled out
-- of order become invisible to agents/viewers before Fase 10 lands.
-- ============================================================
DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_insert ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;

CREATE POLICY conversations_select ON conversations FOR SELECT USING (
  is_account_member(account_id, 'admin')
  OR (is_account_member(account_id, 'viewer') AND (line_id IS NULL OR can_access_line(line_id)))
);
CREATE POLICY conversations_insert ON conversations FOR INSERT WITH CHECK (
  is_account_member(account_id, 'admin')
  OR (is_account_member(account_id, 'agent') AND (line_id IS NULL OR can_access_line(line_id)))
);
CREATE POLICY conversations_update ON conversations FOR UPDATE USING (
  is_account_member(account_id, 'admin')
  OR (is_account_member(account_id, 'agent') AND (line_id IS NULL OR can_access_line(line_id)))
);
CREATE POLICY conversations_delete ON conversations FOR DELETE USING (
  is_account_member(account_id, 'admin')
  OR (is_account_member(account_id, 'agent') AND (line_id IS NULL OR can_access_line(line_id)))
);

DROP POLICY IF EXISTS messages_select ON messages;
DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND (
        is_account_member(c.account_id, 'admin')
        OR (is_account_member(c.account_id, 'viewer') AND (c.line_id IS NULL OR can_access_line(c.line_id)))
      )
  )
);
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND (
        is_account_member(c.account_id, 'admin')
        OR (is_account_member(c.account_id, 'agent') AND (c.line_id IS NULL OR can_access_line(c.line_id)))
      )
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND (
        is_account_member(c.account_id, 'admin')
        OR (is_account_member(c.account_id, 'agent') AND (c.line_id IS NULL OR can_access_line(c.line_id)))
      )
  )
);
-- Service-role webhook inserts (Meta deliveries) bypass RLS as before.
