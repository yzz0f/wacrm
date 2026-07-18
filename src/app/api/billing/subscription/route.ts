import { NextResponse } from 'next/server'

import { toErrorResponse, getCurrentAccount } from '@/lib/auth/account'

/**
 * GET /api/billing/subscription — the caller's account subscription +
 * plan detail, for Settings → Billing. Two plain queries rather than
 * an embedded join — same PostgREST schema-cache caution as the rest
 * of this feature's routes (account_subscriptions is new).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data: account, error: accountErr } = await supabase
      .from('accounts')
      .select('billing_status')
      .eq('id', accountId)
      .maybeSingle()
    if (accountErr) {
      console.error('[billing/subscription] account fetch error:', accountErr)
      return NextResponse.json({ error: 'Failed to load billing status' }, { status: 500 })
    }

    const { data: sub, error: subErr } = await supabase
      .from('account_subscriptions')
      .select('plan_id, trial_ends_at, current_period_end')
      .eq('account_id', accountId)
      .maybeSingle()
    if (subErr) {
      console.error('[billing/subscription] subscription fetch error:', subErr)
      return NextResponse.json({ error: 'Failed to load subscription' }, { status: 500 })
    }
    if (!sub) {
      return NextResponse.json({ subscribed: false, billingStatus: account?.billing_status ?? null })
    }

    const { data: plan } = await supabase
      .from('plans')
      .select('key, name, price_clp_monthly, max_lines, max_agents, ai_enabled')
      .eq('id', sub.plan_id)
      .maybeSingle()

    return NextResponse.json({
      subscribed: true,
      billingStatus: account?.billing_status ?? null,
      trialEndsAt: sub.trial_ends_at,
      currentPeriodEnd: sub.current_period_end,
      plan,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
