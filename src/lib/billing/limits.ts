import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Plan-limit enforcement. Purely preventive — a downgrade never
// deletes or disables anything already over the new limit
// (grandfathered), it only blocks creating MORE while over.
// ============================================================

export interface PlanLimitCheck {
  allowed: boolean
  /** null = unlimited on this dimension. */
  limit: number | null
  current: number
}

type LimitDimension = 'lines' | 'members'

/**
 * Check whether `accountId` can create one more of `dimension`
 * without exceeding its plan's limit. Fails open (allowed: true) if
 * the account has no subscription row or plan lookup fails — billing
 * being unset/broken should never block core product usage for an
 * account that predates this feature or hit a transient DB error.
 */
export async function checkPlanLimit(
  db: SupabaseClient,
  accountId: string,
  dimension: LimitDimension,
): Promise<PlanLimitCheck> {
  const { data: sub } = await db
    .from('account_subscriptions')
    .select('plan_id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!sub) return { allowed: true, limit: null, current: 0 }

  const { data: plan } = await db
    .from('plans')
    .select('max_lines, max_agents')
    .eq('id', sub.plan_id)
    .maybeSingle()
  if (!plan) return { allowed: true, limit: null, current: 0 }

  const limit = dimension === 'lines' ? plan.max_lines : plan.max_agents
  if (limit === null) return { allowed: true, limit: null, current: 0 }

  // 'lines' is a combined channel-account count — WhatsApp lines and
  // Instagram accounts share one plan limit (migration 043), not a
  // separate dimension each.
  let current: number
  if (dimension === 'lines') {
    const [{ count: lineCount }, { count: igCount }] = await Promise.all([
      db.from('whatsapp_lines').select('id', { count: 'exact', head: true }).eq('account_id', accountId),
      db.from('instagram_accounts').select('id', { count: 'exact', head: true }).eq('account_id', accountId),
    ])
    current = (lineCount ?? 0) + (igCount ?? 0)
  } else {
    const { count } = await db
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    current = count ?? 0
  }

  return { allowed: current < limit, limit, current }
}
