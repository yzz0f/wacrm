import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { requirePlatformAdmin } from '@/lib/platform-admin/auth'
import { supabaseAdmin } from '@/lib/platform-admin/admin-client'

const IMPERSONATION_MINUTES = 30

/**
 * Start impersonating an account's owner.
 *
 * This route runs on the admin host (`admin.<domain>`) but the
 * resulting session belongs on the main app host (`<domain>`) — a
 * different origin, so cookies set here would never reach it. Rather
 * than fighting that with a shared cross-subdomain cookie domain
 * (fragile, and it would widen every other session cookie on the
 * app too), we only mint the magic-link token here and hand the
 * browser a URL to the main host's `/api/impersonation/consume`,
 * which performs `verifyOtp` (and therefore sets cookies) on the
 * host that actually needs the session. See Fase 0 of the plan for
 * why `generateLink` + `verifyOtp` are two separate calls in the
 * first place — `generateLink` alone never returns a usable session.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requirePlatformAdmin()
    const db = supabaseAdmin()
    const { id: accountId } = await params

    let reason: string | null = null
    try {
      const body = await request.json()
      if (body && typeof body.reason === 'string') reason = body.reason
    } catch {
      // No body / not JSON — reason is optional.
    }

    const { data: account, error: accountErr } = await db
      .from('accounts')
      .select('id, name, owner_user_id, status')
      .eq('id', accountId)
      .maybeSingle()
    if (accountErr) {
      console.error('[platform-admin/impersonate] account fetch error:', accountErr)
      return NextResponse.json({ error: 'Failed to load account' }, { status: 500 })
    }
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }
    if (account.status !== 'active') {
      return NextResponse.json(
        { error: 'Reactivate the account before impersonating it' },
        { status: 409 },
      )
    }

    const { data: ownerUserResp, error: ownerUserErr } = await db.auth.admin.getUserById(
      account.owner_user_id,
    )
    if (ownerUserErr || !ownerUserResp?.user?.email) {
      console.error('[platform-admin/impersonate] owner lookup error:', ownerUserErr)
      return NextResponse.json({ error: 'Could not resolve account owner' }, { status: 500 })
    }
    const ownerEmail = ownerUserResp.user.email

    const { data: ownerProfile, error: ownerProfileErr } = await db
      .from('profiles')
      .select('id')
      .eq('account_id', accountId)
      .eq('user_id', account.owner_user_id)
      .maybeSingle()
    if (ownerProfileErr || !ownerProfile) {
      console.error('[platform-admin/impersonate] owner profile lookup error:', ownerProfileErr)
      return NextResponse.json({ error: 'Could not resolve account owner profile' }, { status: 500 })
    }

    const { data: linkData, error: linkErr } = await db.auth.admin.generateLink({
      type: 'magiclink',
      email: ownerEmail,
    })
    if (linkErr || !linkData) {
      console.error('[platform-admin/impersonate] generateLink error:', linkErr)
      return NextResponse.json({ error: 'Failed to start impersonation' }, { status: 500 })
    }
    // generateLink's own docs note it "handles the creation of the
    // user" for magiclink — guard against it ever resolving to a
    // *different* user than the owner we looked up, rather than
    // silently impersonating the wrong account. Verified manually
    // against a real Supabase project before this phase ships (see
    // plan Fase 3 anti-pattern guard) — this check stays as a
    // permanent runtime safety net either way.
    if (linkData.user?.id !== account.owner_user_id) {
      console.error(
        '[platform-admin/impersonate] generateLink resolved to unexpected user',
        { expected: account.owner_user_id, got: linkData.user?.id },
      )
      return NextResponse.json({ error: 'Failed to start impersonation' }, { status: 500 })
    }
    const hashedToken = linkData.properties?.hashed_token
    if (!hashedToken) {
      console.error('[platform-admin/impersonate] generateLink returned no hashed_token')
      return NextResponse.json({ error: 'Failed to start impersonation' }, { status: 500 })
    }

    const expiresAt = new Date(Date.now() + IMPERSONATION_MINUTES * 60 * 1000)

    const { data: sessionRow, error: sessionErr } = await db
      .from('impersonation_sessions')
      .insert({
        platform_admin_id: admin.profileId,
        target_account_id: accountId,
        target_profile_id: ownerProfile.id,
        reason,
        expires_at: expiresAt.toISOString(),
      })
      .select('id')
      .single()
    if (sessionErr || !sessionRow) {
      console.error('[platform-admin/impersonate] audit row insert error:', sessionErr)
      return NextResponse.json({ error: 'Failed to start impersonation' }, { status: 500 })
    }

    const mainHost = process.env.NEXT_PUBLIC_APP_HOST
    if (!mainHost) {
      console.error('[platform-admin/impersonate] NEXT_PUBLIC_APP_HOST not configured')
      return NextResponse.json({ error: 'Platform admin panel misconfigured' }, { status: 500 })
    }
    const consumeUrl = new URL(`https://${mainHost}/api/impersonation/consume`)
    consumeUrl.searchParams.set('token_hash', hashedToken)
    consumeUrl.searchParams.set('session_id', sessionRow.id)

    return NextResponse.json({
      accountName: account.name,
      expiresAt: expiresAt.toISOString(),
      redirectUrl: consumeUrl.toString(),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
