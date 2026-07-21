import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getInstagramReachableContacts } from '@/lib/instagram/reachable-audience'

/**
 * GET /api/instagram/reachable-audience?instagram_account_id=<uuid>
 *
 * Backs the New Instagram broadcast page's recipient picker — the
 * contacts a broadcast can actually reach right now (see
 * getInstagramReachableContacts for why this can't be computed from
 * conversations.last_message_at alone).
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const instagramAccountId = new URL(request.url).searchParams.get('instagram_account_id')
    if (!instagramAccountId) {
      return NextResponse.json({ error: 'instagram_account_id is required' }, { status: 400 })
    }

    const contacts = await getInstagramReachableContacts(supabase, accountId, instagramAccountId)
    return NextResponse.json({ contacts })
  } catch (err) {
    return toErrorResponse(err)
  }
}
