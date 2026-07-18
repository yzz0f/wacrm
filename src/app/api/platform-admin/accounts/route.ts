import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { requirePlatformAdmin } from '@/lib/platform-admin/auth'
import { supabaseAdmin } from '@/lib/platform-admin/admin-client'

/**
 * List every account on the instance with lightweight aggregate
 * metrics for the platform-admin accounts table. Owner email comes
 * from `auth.admin.listUsers` — `accounts.owner_user_id` is an
 * `auth.users` id, not a `profiles` row, so it isn't reachable from
 * a plain `.select()`.
 */
export async function GET() {
  try {
    await requirePlatformAdmin()
    const admin = supabaseAdmin()

    const { data: accounts, error: accountsErr } = await admin
      .from('accounts')
      .select('id, name, owner_user_id, status, deletion_requested_at, created_at')
      .order('created_at', { ascending: false })
    if (accountsErr) {
      console.error('[platform-admin/accounts] accounts fetch error:', accountsErr)
      return NextResponse.json({ error: 'Failed to load accounts' }, { status: 500 })
    }
    if (!accounts || accounts.length === 0) {
      return NextResponse.json({ accounts: [] })
    }

    const accountIds = accounts.map((a) => a.id)

    const [{ data: memberCounts }, { data: configCounts }] = await Promise.all([
      admin.from('profiles').select('account_id').in('account_id', accountIds),
      admin.from('whatsapp_config').select('account_id').in('account_id', accountIds),
    ])

    const memberCountByAccount = new Map<string, number>()
    for (const row of memberCounts ?? []) {
      const key = row.account_id as string
      memberCountByAccount.set(key, (memberCountByAccount.get(key) ?? 0) + 1)
    }
    const hasWhatsappByAccount = new Set((configCounts ?? []).map((r) => r.account_id as string))

    // Owner emails — one bulk admin call rather than N.
    const ownerIds = new Set(accounts.map((a) => a.owner_user_id))
    const ownerEmailById = new Map<string, string>()
    let page = 1
    while (ownerEmailById.size < ownerIds.size) {
      const { data: page1, error: listErr } = await admin.auth.admin.listUsers({
        page,
        perPage: 1000,
      })
      if (listErr || !page1 || page1.users.length === 0) break
      for (const u of page1.users) {
        if (ownerIds.has(u.id)) ownerEmailById.set(u.id, u.email ?? '')
      }
      if (page1.users.length < 1000) break
      page++
    }

    const result = accounts.map((a) => ({
      id: a.id,
      name: a.name,
      ownerEmail: ownerEmailById.get(a.owner_user_id) ?? null,
      status: a.status,
      deletionRequestedAt: a.deletion_requested_at,
      memberCount: memberCountByAccount.get(a.id) ?? 0,
      hasWhatsappLine: hasWhatsappByAccount.has(a.id),
      createdAt: a.created_at,
    }))

    return NextResponse.json({ accounts: result })
  } catch (err) {
    return toErrorResponse(err)
  }
}
