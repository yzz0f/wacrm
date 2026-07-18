-- ============================================================
-- 041_billing_plans.sql — Billing and plans (foundation)
--
-- Adds real recurring billing on top of the existing platform-admin
-- panel (039_platform_admin.sql): fixed-tier plans, a per-account
-- subscription row, and a billing_status that a cron (later phase)
-- syncs into accounts.status = 'suspended' on unresolved non-payment.
-- Independent of the multi-number-lines and platform-admin-panel
-- sub-projects — reuses accounts.status and is_account_member()
-- without modifying either.
--
-- What this migration does
--   1. `billing_status_enum` ('trialing' | 'active' | 'past_due' |
--      'canceled') + `accounts.billing_status`. Deliberately separate
--      from `accounts.status` ('active' | 'suspended' |
--      'pending_deletion', from 039_platform_admin.sql) — `status` is
--      "can this account use the product right now", `billing_status`
--      is "why" (lets the super-admin panel distinguish a manual
--      suspension from a non-payment one). Neither `is_account_member()`
--      nor `accounts.status` itself is touched here.
--   2. `plans` — seed data for the two paid tiers (Pro, Business), no
--      client-facing CRUD in v1. Price is a placeholder pending a real
--      business decision — see the seed INSERT below.
--   3. `account_subscriptions` — 1:1 with `accounts`, tracks which
--      plan an account is on and its MercadoPago subscription id.
--   4. Redefines `handle_new_user` (017_account_sharing.sql) to also
--      create the trial `account_subscriptions` row atomically with
--      the account/profile it already creates.
--
-- What this migration does NOT touch
--   - `accounts.status`, `is_account_member()`, `can_access_line()` —
--     all untouched; billing_status is read by a later cron/webhook
--     phase that decides when to flip `accounts.status`.
--   - No payment provider calls happen here — this is schema only.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- ACCOUNTS: billing_status
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_status_enum') THEN
    CREATE TYPE billing_status_enum AS ENUM ('trialing', 'active', 'past_due', 'canceled');
  END IF;
END $$;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS billing_status billing_status_enum NOT NULL DEFAULT 'trialing';

-- ============================================================
-- PLANS
-- ============================================================
CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price_clp_monthly INTEGER NOT NULL,
  max_lines INTEGER,     -- NULL = unlimited
  max_agents INTEGER,    -- NULL = unlimited; counts every member (any account_role)
  ai_enabled BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

-- Plans are not sensitive — any authenticated user can read them (a
-- non-member needs to see prices/limits to decide whether to sign
-- up). No client-facing write policy; changes go through a migration
-- or a future admin-only route.
DROP POLICY IF EXISTS plans_select ON plans;
CREATE POLICY plans_select ON plans
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- Seed. price_clp_monthly is a PLACEHOLDER pending a real pricing
-- decision — update via a follow-up migration or direct SQL once
-- decided; the app never hardcodes these numbers, it always reads
-- this table.
INSERT INTO plans (key, name, price_clp_monthly, max_lines, max_agents, ai_enabled, is_active)
VALUES
  ('pro', 'Pro', 0, 3, 10, true, true),
  ('business', 'Business', 0, NULL, NULL, true, true)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- ACCOUNT_SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS account_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id),
  provider TEXT NOT NULL DEFAULT 'mercadopago',
  external_subscription_id TEXT,
  trial_ends_at TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_subscriptions_external_id
  ON account_subscriptions(external_subscription_id);

ALTER TABLE account_subscriptions ENABLE ROW LEVEL SECURITY;

-- SELECT only — every write goes through service-role routes
-- (checkout response, webhook, cron), same reasoning as
-- impersonation_sessions in 039_platform_admin.sql.
DROP POLICY IF EXISTS account_subscriptions_select ON account_subscriptions;
CREATE POLICY account_subscriptions_select ON account_subscriptions
  FOR SELECT
  USING (is_account_member(account_id));

DROP TRIGGER IF EXISTS set_updated_at ON account_subscriptions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON account_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- handle_new_user: also create the trial subscription
--
-- Redefines the trigger function from 017_account_sharing.sql,
-- unchanged except for the new INSERT. Same exception guard as
-- before — a failure here logs a warning and still returns NEW, so
-- a billing hiccup never blocks signup.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
  v_pro_plan_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  SELECT id INTO v_pro_plan_id FROM public.plans WHERE key = 'pro';
  IF v_pro_plan_id IS NOT NULL THEN
    INSERT INTO public.account_subscriptions (account_id, plan_id, trial_ends_at)
    VALUES (v_account_id, v_pro_plan_id, NOW() + INTERVAL '14 days');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
