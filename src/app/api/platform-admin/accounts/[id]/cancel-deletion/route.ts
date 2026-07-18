import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { requirePlatformAdmin } from '@/lib/platform-admin/auth'
import { supabaseAdmin } from '@/lib/platform-admin/admin-client'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePlatformAdmin()
    const admin = supabaseAdmin()
    const { id } = await params

    const { data, error } = await admin
      .from('accounts')
      .update({ status: 'active', deletion_requested_at: null })
      .eq('id', id)
      .select('id, status')
      .maybeSingle()

    if (error) {
      console.error('[platform-admin/accounts/:id/cancel-deletion] update error:', error)
      return NextResponse.json({ error: 'Failed to cancel deletion' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }

    return NextResponse.json({ account: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
