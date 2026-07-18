import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/billing/admin-client'

const GRACE_PERIOD_DAYS = 3

/**
 * GET /api/billing/cron/check-trials
 *
 * Safety net if a MercadoPago webhook never arrives (see the webhook
 * route's idempotency note — deliveries aren't guaranteed instant or
 * even guaranteed at all if MercadoPago's retries also fail). Runs
 * two sweeps:
 *   1. trialing accounts whose trial_ends_at has passed -> past_due.
 *   2. past_due accounts whose deadline (current_period_end if the
 *      account ever had a period, else trial_ends_at) is more than
 *      GRACE_PERIOD_DAYS old -> accounts.status = 'suspended'.
 *
 * Same shared-secret cron auth as /api/automations/cron and
 * /api/platform-admin/cron/purge-pending-deletions — copied, not
 * reinvented.
 *
 * The two deadline columns are combined in application code, not a
 * single SQL filter — Supabase's query builder has no clean way to
 * express COALESCE(current_period_end, trial_ends_at) as a filter,
 * and account volume here is small enough that fetching + filtering
 * in JS is simpler and just as correct.
 *
 * Reads accounts and account_subscriptions as two separate queries
 * (not an embedded `!inner()` join) — account_subscriptions is a
 * brand-new table as of this same PR, and an embedded join can fail
 * with PGRST200 if PostgREST's schema cache hasn't picked up the new
 * FK yet (see the comment on getCurrentAccount in
 * src/lib/auth/account.ts for the precedent).
 */
export async function GET(request: Request) {
  const expected = process.env.BILLING_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const now = Date.now()

  // ---- Sweep 1: trialing -> past_due ----
  const { data: trialingAccounts } = await admin
    .from('accounts')
    .select('id')
    .eq('billing_status', 'trialing')
  const trialingIds = (trialingAccounts ?? []).map((a) => a.id as string)

  const expiredTrialIds: string[] = []
  if (trialingIds.length > 0) {
    const { data: subs } = await admin
      .from('account_subscriptions')
      .select('account_id, trial_ends_at')
      .in('account_id', trialingIds)
    for (const s of subs ?? []) {
      if (s.trial_ends_at && new Date(s.trial_ends_at).getTime() < now) {
        expiredTrialIds.push(s.account_id as string)
      }
    }
  }

  if (expiredTrialIds.length > 0) {
    await admin.from('accounts').update({ billing_status: 'past_due' }).in('id', expiredTrialIds)
  }

  // ---- Sweep 2: past_due beyond the grace period -> suspended ----
  const { data: pastDueAccounts } = await admin
    .from('accounts')
    .select('id, status')
    .eq('billing_status', 'past_due')
  const notYetSuspended = (pastDueAccounts ?? []).filter((a) => a.status !== 'suspended')

  const graceCutoff = now - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000
  const toSuspendIds: string[] = []
  if (notYetSuspended.length > 0) {
    const { data: subs } = await admin
      .from('account_subscriptions')
      .select('account_id, trial_ends_at, current_period_end')
      .in('account_id', notYetSuspended.map((a) => a.id as string))
    for (const s of subs ?? []) {
      const deadline = s.current_period_end ?? s.trial_ends_at
      if (deadline && new Date(deadline).getTime() < graceCutoff) {
        toSuspendIds.push(s.account_id as string)
      }
    }
  }

  if (toSuspendIds.length > 0) {
    await admin.from('accounts').update({ status: 'suspended' }).in('id', toSuspendIds)
  }

  return NextResponse.json({
    movedToPastDue: expiredTrialIds.length,
    suspended: toSuspendIds.length,
  })
}
