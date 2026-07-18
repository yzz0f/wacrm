import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/platform-admin/admin-client'

const SESSION_ID_COOKIE = 'impersonation_session_id'

/**
 * End the current impersonation session. Runs on the main app host,
 * called by the dashboard banner (Fase 6) — either the "Salir"
 * button or the client-side countdown hitting zero.
 *
 * The admin's own session was never touched (it lives on the admin
 * host, a separate origin — see the impersonate/consume routes'
 * comments), so "ending" only needs to sign out this impersonated
 * session and point the browser back at the admin host.
 */
export async function POST() {
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(SESSION_ID_COOKIE)?.value

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  let accountId: string | null = null

  if (sessionId && user) {
    const admin = supabaseAdmin()
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (profile) {
      // target_profile_id match guards against a tampered cookie
      // closing out someone else's impersonation row.
      const { data: closedRow } = await admin
        .from('impersonation_sessions')
        .update({ ended_at: new Date().toISOString() })
        .eq('id', sessionId)
        .eq('target_profile_id', profile.id)
        .is('ended_at', null)
        .select('target_account_id')
        .maybeSingle()
      accountId = closedRow?.target_account_id ?? null
    }
  }

  await supabase.auth.signOut()
  cookieStore.delete(SESSION_ID_COOKIE)

  const adminHost = process.env.PLATFORM_ADMIN_HOST
  const redirectUrl = adminHost
    ? `https://${adminHost}${accountId ? `/accounts/${accountId}` : ''}`
    : null

  return NextResponse.json({ redirectUrl })
}
