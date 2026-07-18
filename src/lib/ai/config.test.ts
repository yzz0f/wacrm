import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

import { loadAiConfig } from './config'

// Table-aware: ai_configs returns `row`; account_subscriptions/plans
// return null by default (no subscription row = billing not set up
// on this install = never gates AI access), unless overridden.
function dbReturning(
  row: Record<string, unknown> | null,
  opts: { subscription?: Record<string, unknown> | null; plan?: Record<string, unknown> | null } = {},
): SupabaseClient {
  const { subscription = null, plan = null } = opts
  const from = (table: string) => {
    const data = table === 'ai_configs' ? row : table === 'account_subscriptions' ? subscription : plan
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data, error: null }),
    }
    return chain
  }
  return { from } as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
}

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })
})

describe('loadAiConfig plan gate', () => {
  it('returns null when the account plan has ai_enabled = false', async () => {
    const db = dbReturning(ROW, {
      subscription: { plan_id: 'plan-1' },
      plan: { ai_enabled: false },
    })
    expect(await loadAiConfig(db, 'acct', { requireActive: false })).toBeNull()
  })

  it('returns the config when the plan has ai_enabled = true', async () => {
    const db = dbReturning(ROW, {
      subscription: { plan_id: 'plan-1' },
      plan: { ai_enabled: true },
    })
    const config = await loadAiConfig(db, 'acct', { requireActive: false })
    expect(config).not.toBeNull()
  })

  it('never gates when there is no subscription row (billing not set up)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
  })
})
