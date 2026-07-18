-- ============================================================
-- 040_ai_gemini_provider.sql — add Gemini as a third AI provider
--
-- ai_configs.provider and ai_usage_log.provider were each declared
-- with an inline, unnamed `CHECK (provider IN ('openai', 'anthropic'))`
-- (029_ai_reply.sql:49, 033_ai_reply_polish.sql:64) — Postgres named
-- those constraints `<table>_provider_check` by convention. Widen both
-- to also allow 'gemini'. No data migration needed: existing rows are
-- untouched, this only widens what's allowed going forward.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));
