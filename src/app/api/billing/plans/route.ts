import { NextResponse } from 'next/server'

import { toErrorResponse, getCurrentAccount } from '@/lib/auth/account'

/** GET /api/billing/plans — every active plan, for the "change plan" picker. */
export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('plans')
      .select('id, key, name, price_clp_monthly, max_lines, max_agents, ai_enabled')
      .eq('is_active', true)
      .order('price_clp_monthly', { ascending: true })

    if (error) {
      console.error('[billing/plans] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load plans' }, { status: 500 })
    }
    return NextResponse.json({ plans: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
