import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/platform-admin/admin-client'

const SESSION_ID_COOKIE = 'impersonation_session_id'

/**
 * Whether the current session is an active impersonation, and when
 * it expires. Polled once on dashboard-shell mount (Fase 6) — not
 * on every render — so this stays cheap.
 */
export async function GET() {
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(SESSION_ID_COOKIE)?.value
  if (!sessionId) {
    return NextResponse.json({ active: false })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ active: false })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!profile) {
    return NextResponse.json({ active: false })
  }

  const admin = supabaseAdmin()
  const { data: row } = await admin
    .from('impersonation_sessions')
    .select('id, expires_at, target_account_id')
    .eq('id', sessionId)
    .eq('target_profile_id', profile.id)
    .is('ended_at', null)
    .maybeSingle()

  if (!row) {
    return NextResponse.json({ active: false })
  }

  // Plain point lookup by id, not an embedded FK join — see the
  // comment on getCurrentAccount() in src/lib/auth/account.ts for why
  // (PostgREST schema-cache staleness right after a migration adds
  // an FK is a real, previously-hit failure mode in this codebase).
  const { data: account } = await admin
    .from('accounts')
    .select('name')
    .eq('id', row.target_account_id)
    .maybeSingle()

  return NextResponse.json({
    active: true,
    expiresAt: row.expires_at,
    accountName: account?.name ?? null,
  })
}
