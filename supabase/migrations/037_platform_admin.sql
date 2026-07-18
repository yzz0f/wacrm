-- ============================================================
-- 037_platform_admin.sql — Platform super-admin panel (foundation)
--
-- Adds the schema for an internal super-admin panel that can list
-- every account on the instance, suspend/reactivate/delete them, and
-- impersonate an account owner for support. This is independent of
-- the multi-number-lines work (`whatsapp_lines` etc.) — either can
-- ship without the other.
--
-- What this migration does
--   1. `profiles.is_platform_admin` — flag granting access to
--      `/platform-admin/*`. Does NOT touch `profiles.account_id`;
--      a platform admin still belongs to (at most) one ordinary
--      account like any other user.
--   2. `account_status_enum` ('active' | 'suspended' |
--      'pending_deletion') + `accounts.status` / `deletion_requested_at`.
--   3. `impersonation_sessions` — audit trail of every support
--      impersonation, readable by the impersonated account's own
--      members (transparency) and by the platform admin who ran it.
--   4. Extends `is_account_member()` (017_account_sharing.sql) to
--      additionally require `accounts.status = 'active'`. This
--      propagates "suspended account = blocked everywhere" to every
--      one of the ~15 tables whose policies already call that
--      function, with no per-table policy changes needed.
--
-- What this migration does NOT touch
--   - `can_access_line()` (037_whatsapp_lines.sql on the sibling
--     multi-number branch) — it calls `is_account_member()`
--     internally, so it inherits the `status = 'active'` gate for
--     free once that branch merges. Not modified directly here.
--   - No UI, no API routes — those are later phases of this plan.
--   - Granting `is_platform_admin` to any real user — that's a
--     manual one-off. Run by hand against the target user's row:
--       UPDATE profiles SET is_platform_admin = true
--       WHERE user_id = '<uuid of the internal team member>';
--
-- Idempotent — safe to run multiple times. New columns use
-- IF NOT EXISTS; the type uses a DO $$ guard; the function is
-- CREATE OR REPLACE; the policy is dropped before recreate.
-- ============================================================

-- ============================================================
-- PROFILES: is_platform_admin
-- ============================================================
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- ACCOUNTS: status + deletion_requested_at
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_status_enum') THEN
    CREATE TYPE account_status_enum AS ENUM ('active', 'suspended', 'pending_deletion');
  END IF;
END $$;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS status account_status_enum NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;

-- ============================================================
-- IMPERSONATION_SESSIONS
--
-- One row per support impersonation. `ended_at IS NULL` means the
-- session is still (nominally) open — the actual expiry is time-based
-- (`expires_at`), enforced client-side (Fase 6) and re-checked by the
-- `/api/platform-admin/impersonation/end` route, not by a DB job.
-- ============================================================
CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  platform_admin_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_target_account
  ON impersonation_sessions(target_account_id);

CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_platform_admin
  ON impersonation_sessions(platform_admin_id);

ALTER TABLE impersonation_sessions ENABLE ROW LEVEL SECURITY;

-- SELECT only — every write goes through /api/platform-admin/* on the
-- service role, which bypasses RLS entirely. No client-facing
-- INSERT/UPDATE/DELETE policy is defined on purpose.
DROP POLICY IF EXISTS impersonation_sessions_select ON impersonation_sessions;
CREATE POLICY impersonation_sessions_select ON impersonation_sessions
  FOR SELECT
  USING (
    is_account_member(target_account_id)
    OR platform_admin_id IN (
      SELECT id FROM profiles WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- is_account_member(): require the account to be active
--
-- Same signature/behaviour as 017_account_sharing.sql, plus a
-- status check. Every policy that already calls this function
-- (~15 tables) is blocked automatically for suspended/pending-
-- deletion accounts without touching any of those policies.
-- ============================================================
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND a.status = 'active'
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum) TO authenticated, service_role;
