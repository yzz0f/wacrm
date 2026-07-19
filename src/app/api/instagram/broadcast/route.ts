import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  createInstagramBroadcast,
  deliverInstagramBroadcast,
  InstagramBroadcastError,
} from '@/lib/instagram/broadcast-instagram-core'

/**
 * POST /api/instagram/broadcast
 *
 * Body: { name?, message_text, instagram_account_id?, contact_ids }.
 * Unlike WhatsApp's dashboard flow (client-orchestrated batching,
 * src/hooks/use-broadcast-sending.ts), this does create + deliver in
 * one request — free-text broadcasts have no per-recipient
 * personalization step to justify the client-side batching, and
 * recipient counts here are bounded by the 24-hour-reachable
 * audience, not WhatsApp's full contact list scale.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ig-broadcast:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json()
    const { name, message_text, instagram_account_id, contact_ids } = body

    let instagramAccountId = instagram_account_id
    if (!instagramAccountId) {
      const { data: defaultAccount } = await supabase
        .from('instagram_accounts')
        .select('id')
        .eq('account_id', accountId)
        .eq('is_default', true)
        .maybeSingle()
      instagramAccountId = defaultAccount?.id
    }
    if (!instagramAccountId) {
      return NextResponse.json({ error: 'No Instagram account configured' }, { status: 400 })
    }

    const plan = await createInstagramBroadcast(supabase, accountId, userId, {
      name,
      messageText: message_text,
      instagramAccountId,
      contactIds: Array.isArray(contact_ids) ? contact_ids : [],
    })

    await deliverInstagramBroadcast(supabase, plan)

    return NextResponse.json({ success: true, broadcast_id: plan.broadcastId, total: plan.planned.length })
  } catch (err) {
    if (err instanceof InstagramBroadcastError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
