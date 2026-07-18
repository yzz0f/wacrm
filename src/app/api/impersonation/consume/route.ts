import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

import { createClient } from '@/lib/supabase/server'

const SESSION_ID_COOKIE = 'impersonation_session_id'
const IMPERSONATION_MINUTES = 30

/**
 * Landing point for an impersonation redirect from the admin host.
 * Runs on the MAIN app host — `verifyOtp` here is what actually
 * writes the session cookies the dashboard needs, since cookies set
 * by `/api/platform-admin/.../impersonate` (a different origin)
 * could never reach this host. See that route's file comment for
 * the full reasoning.
 *
 * `token_hash` is single-use (Supabase invalidates it after the
 * first successful verifyOtp), so a stale/replayed link fails
 * naturally rather than needing extra bookkeeping here.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const tokenHash = url.searchParams.get('token_hash')
  const sessionId = url.searchParams.get('session_id')

  if (!tokenHash || !sessionId) {
    return NextResponse.redirect(new URL('/login?error=invalid_impersonation_link', url))
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'magiclink',
  })

  if (error || !data.session) {
    console.error('[impersonation/consume] verifyOtp error:', error)
    return NextResponse.redirect(new URL('/login?error=impersonation_failed', url))
  }

  const cookieStore = await cookies()
  cookieStore.set(SESSION_ID_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: IMPERSONATION_MINUTES * 60,
  })

  return NextResponse.redirect(new URL('/dashboard', url))
}
