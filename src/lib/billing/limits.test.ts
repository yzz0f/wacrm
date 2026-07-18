import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { checkPlanLimit } from './limits'

function fakeDb(opts: {
  subscription?: { plan_id: string } | null
  plan?: { max_lines: number | null; max_agents: number | null } | null
  count?: number | null
}): SupabaseClient {
  const { subscription = null, plan = null, count = 0 } = opts
  const from = (table: string) => {
    if (table === 'account_subscriptions') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: subscription, error: null }) }) }) }
    }
    if (table === 'plans') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: plan, error: null }) }) }) }
    }
    // whatsapp_lines / profiles count query
    return { select: () => ({ eq: () => Promise.resolve({ count, error: null }) }) }
  }
  return { from } as unknown as SupabaseClient
}

describe('checkPlanLimit', () => {
  it('allows when there is no subscription row (billing not set up)', async () => {
    const result = await checkPlanLimit(fakeDb({}), 'acct', 'lines')
    expect(result).toEqual({ allowed: true, limit: null, current: 0 })
  })

  it('allows when the plan has an unlimited (null) limit', async () => {
    const db = fakeDb({
      subscription: { plan_id: 'plan-1' },
      plan: { max_lines: null, max_agents: null },
    })
    const result = await checkPlanLimit(db, 'acct', 'lines')
    expect(result.allowed).toBe(true)
    expect(result.limit).toBeNull()
  })

  it('blocks when current count has reached the plan limit', async () => {
    const db = fakeDb({
      subscription: { plan_id: 'plan-1' },
      plan: { max_lines: 3, max_agents: 10 },
      count: 3,
    })
    const result = await checkPlanLimit(db, 'acct', 'lines')
    expect(result).toEqual({ allowed: false, limit: 3, current: 3 })
  })

  it('allows when current count is under the plan limit', async () => {
    const db = fakeDb({
      subscription: { plan_id: 'plan-1' },
      plan: { max_lines: 3, max_agents: 10 },
      count: 2,
    })
    const result = await checkPlanLimit(db, 'acct', 'lines')
    expect(result).toEqual({ allowed: true, limit: 3, current: 2 })
  })

  it('checks the members dimension against max_agents and the profiles table', async () => {
    const db = fakeDb({
      subscription: { plan_id: 'plan-1' },
      plan: { max_lines: 3, max_agents: 10 },
      count: 10,
    })
    const result = await checkPlanLimit(db, 'acct', 'members')
    expect(result).toEqual({ allowed: false, limit: 10, current: 10 })
  })
})
