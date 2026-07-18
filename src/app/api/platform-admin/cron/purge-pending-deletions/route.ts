import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/platform-admin/admin-client'

const GRACE_PERIOD_DAYS = 30

/**
 * Hard-deletes every account still `pending_deletion` after the
 * 30-day grace period. `ON DELETE CASCADE` on every child table's
 * `account_id` FK (established since 017_account_sharing.sql)
 * handles the rest — this route only ever deletes `accounts` rows.
 *
 * Same shared-secret cron auth as /api/automations/cron and
 * /api/flows/cron — copied, not reinvented, so every scheduled
 * route in this app is protected the same way. Schedule externally
 * (Vercel Cron / any pinger) hitting this URL with the
 * `x-cron-secret` header, or via `pg_cron` if your Supabase hosting
 * supports it — daily is plenty given the 30-day window.
 */
export async function GET(request: Request) {
  const expected = process.env.PLATFORM_ADMIN_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const cutoff = new Date(Date.now() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const admin = supabaseAdmin()
  const { data: purged, error } = await admin
    .from('accounts')
    .delete()
    .eq('status', 'pending_deletion')
    .lt('deletion_requested_at', cutoff)
    .select('id')

  if (error) {
    console.error('[platform-admin/cron/purge-pending-deletions] delete error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ purged: purged?.length ?? 0 })
}
