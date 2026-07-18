import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { requirePlatformAdmin } from '@/lib/platform-admin/auth'
import { supabaseAdmin } from '@/lib/platform-admin/admin-client'

/**
 * Full detail for one account: the account row, its WhatsApp config
 * (if any), member/conversation/message metrics, and its
 * impersonation history — everything the account detail page (Fase 5)
 * needs in one round trip.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePlatformAdmin()
    const admin = supabaseAdmin()
    const { id } = await params

    const { data: account, error: accountErr } = await admin
      .from('accounts')
      .select('id, name, owner_user_id, status, deletion_requested_at, created_at, updated_at')
      .eq('id', id)
      .maybeSingle()
    if (accountErr) {
      console.error('[platform-admin/accounts/:id] account fetch error:', accountErr)
      return NextResponse.json({ error: 'Failed to load account' }, { status: 500 })
    }
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const [
      { data: ownerUser },
      { data: whatsappConfig },
      { count: memberCount },
      { count: conversationCount },
      { count: messageCount30d },
      { data: impersonationHistory },
    ] = await Promise.all([
      admin.auth.admin.getUserById(account.owner_user_id),
      admin
        .from('whatsapp_config')
        .select('id, phone_number_id, waba_id, status, registered_at')
        .eq('account_id', id)
        .maybeSingle(),
      admin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', id),
      admin
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', id),
      admin
        .from('messages')
        .select('id, conversation:conversations!inner(account_id)', { count: 'exact', head: true })
        .eq('conversation.account_id', id)
        .gte('created_at', thirtyDaysAgo),
      admin
        .from('impersonation_sessions')
        .select('id, platform_admin_id, reason, started_at, expires_at, ended_at')
        .eq('target_account_id', id)
        .order('started_at', { ascending: false })
        .limit(20),
    ])

    return NextResponse.json({
      account: {
        id: account.id,
        name: account.name,
        ownerEmail: ownerUser?.user?.email ?? null,
        status: account.status,
        deletionRequestedAt: account.deletion_requested_at,
        createdAt: account.created_at,
        updatedAt: account.updated_at,
      },
      whatsappConfig: whatsappConfig ?? null,
      metrics: {
        memberCount: memberCount ?? 0,
        conversationCount: conversationCount ?? 0,
        messageCount30d: messageCount30d ?? 0,
      },
      impersonationHistory: impersonationHistory ?? [],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
