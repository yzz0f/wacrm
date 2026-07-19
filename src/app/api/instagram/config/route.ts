import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { encrypt } from '@/lib/whatsapp/encryption'
import { checkPlanLimit } from '@/lib/billing/limits'

// ============================================================
// Instagram account CRUD — parallel to
// src/app/api/whatsapp/config/route.ts, substantially simpler: no
// Meta verification/register/subscribe step exists for the manual-
// entry Instagram connection model chosen for this sub-project (see
// the design spec) — WhatsApp's two-phase register+PIN flow has no
// Instagram equivalent.
// ============================================================

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * GET /api/instagram/config?account_id=<uuid>
 *
 * Health check for the settings panel — `account_id` optional
 * (omitting it targets the account's default Instagram account).
 * No Meta ping (unlike the WhatsApp equivalent) — there's no
 * registration state to verify here, only "is a row saved".
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ connected: false })
    }
    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ connected: false })
    }

    const igAccountId = new URL(request.url).searchParams.get('account_id')
    const query = igAccountId
      ? supabase.from('instagram_accounts').select('id, status').eq('id', igAccountId).eq('account_id', accountId)
      : supabase.from('instagram_accounts').select('id, status').eq('account_id', accountId).eq('is_default', true)
    const { data } = await query.maybeSingle()

    return NextResponse.json({ connected: !!data, status: data?.status ?? null })
  } catch (error) {
    console.error('Error in Instagram config GET:', error)
    return NextResponse.json({ connected: false })
  }
}

/**
 * POST /api/instagram/config
 *
 * Body: { id?, create?, name, instagram_business_account_id, page_id,
 * access_token, verify_token? }. Same create/update precedence as
 * the WhatsApp route: `id` present -> update that row; `create: true`
 * -> always insert a new one; neither -> 0 accounts creates the
 * first (becomes default), 1 account updates it, 2+ is ambiguous (400).
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })
    }

    const body = await request.json()
    const { id, create, name, instagram_business_account_id, page_id, access_token, verify_token } = body

    if (!access_token || !instagram_business_account_id || !page_id) {
      return NextResponse.json(
        { error: 'access_token, instagram_business_account_id, and page_id are required' },
        { status: 400 },
      )
    }

    // Same reasoning as the WhatsApp route's phone_number_id claim
    // check (issue #136) — one Instagram business account can only
    // ever belong to one account on this instance, or the webhook's
    // 0/1/N-row resolution breaks.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('instagram_accounts')
      .select('account_id')
      .eq('instagram_business_account_id', instagram_business_account_id)
      .neq('account_id', accountId)
      .maybeSingle()
    if (claimedError) {
      console.error('Error checking instagram_business_account_id ownership:', claimedError)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }
    if (claimed) {
      return NextResponse.json(
        { error: 'This Instagram account is already linked to another account on this instance.' },
        { status: 409 },
      )
    }

    let existing: { id: string } | null = null
    if (id) {
      const { data } = await supabase
        .from('instagram_accounts')
        .select('id')
        .eq('id', id)
        .eq('account_id', accountId)
        .maybeSingle()
      if (!data) {
        return NextResponse.json({ error: 'Instagram account not found' }, { status: 404 })
      }
      existing = data
    } else if (create) {
      existing = null
    } else {
      const { data: accountRows, error: listError } = await supabase
        .from('instagram_accounts')
        .select('id')
        .eq('account_id', accountId)
      if (listError) {
        console.error('Error listing Instagram accounts:', listError)
        return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
      }
      if (accountRows && accountRows.length > 1) {
        return NextResponse.json(
          { error: 'This account has more than one Instagram account — specify id.' },
          { status: 400 },
        )
      }
      existing = accountRows?.[0] ?? null
    }

    if (!existing) {
      const limitCheck = await checkPlanLimit(supabase, accountId, 'lines')
      if (!limitCheck.allowed) {
        return NextResponse.json(
          { error: `Your plan allows up to ${limitCheck.limit} connected channel(s). Upgrade to add more.` },
          { status: 402 },
        )
      }
    }

    const baseRow = {
      instagram_business_account_id,
      page_id,
      access_token: encrypt(access_token),
      ...(typeof verify_token === 'string' && verify_token.trim() ? { verify_token: encrypt(verify_token.trim()) } : {}),
      status: 'connected' as const,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('instagram_accounts')
        .update(baseRow)
        .eq('id', existing.id)
      if (updateError) {
        console.error('Error updating instagram_accounts:', updateError)
        return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
      }
    } else {
      const { count: existingCount } = await supabase
        .from('instagram_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)

      const { error: insertError } = await supabase
        .from('instagram_accounts')
        .insert({
          account_id: accountId,
          user_id: user.id,
          name: typeof name === 'string' && name.trim() ? name.trim() : 'Instagram',
          is_default: !existingCount,
          ...baseRow,
        })
      if (insertError) {
        console.error('Error inserting instagram_accounts:', insertError)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true, saved: true })
  } catch (error) {
    console.error('Error in Instagram config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/instagram/config?account_id=<uuid>
 *
 * Refuses to delete an account with active conversations — same
 * guard shape as the WhatsApp route's line delete.
 */
export async function DELETE(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })
    }

    const igAccountId = new URL(request.url).searchParams.get('account_id')
    const query = igAccountId
      ? supabase.from('instagram_accounts').select('id').eq('id', igAccountId).eq('account_id', accountId)
      : supabase.from('instagram_accounts').select('id').eq('account_id', accountId).eq('is_default', true)
    const { data: target, error: targetError } = await query.maybeSingle()

    if (targetError) {
      console.error('Error resolving Instagram account to delete:', targetError)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }
    if (!target) {
      return NextResponse.json({ error: 'Instagram account not found' }, { status: 404 })
    }

    const { count } = await supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('instagram_account_id', target.id)
    if (count && count > 0) {
      return NextResponse.json(
        { error: 'This account has active conversations. Close them first before disconnecting.' },
        { status: 409 },
      )
    }

    const { error: deleteError } = await supabase
      .from('instagram_accounts')
      .delete()
      .eq('id', target.id)
    if (deleteError) {
      console.error('Error deleting instagram_accounts:', deleteError)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in Instagram config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
