import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/billing/admin-client'
import { mercadoPagoProvider } from '@/lib/billing/providers/mercadopago'
import { BillingProviderError, type BillingEvent } from '@/lib/billing/providers/types'

/**
 * POST /api/billing/webhook
 *
 * Public — MercadoPago calls this directly, there's no user session.
 * Signature verification (inside the adapter) is the only auth. Every
 * handler below is an absolute SET keyed by a stable id, not an
 * increment/toggle, so replaying the same event twice — which
 * MercadoPago's own docs say it does when a response doesn't arrive
 * within 22s — converges to the same state instead of double-applying
 * an effect.
 */
export async function POST(request: Request) {
  const rawBody = await request.text()
  let payload: unknown = null
  try {
    payload = rawBody ? JSON.parse(rawBody) : null
  } catch {
    // Some MercadoPago notifications arrive as query-string-only pings
    // with no body — handled below via the URL, not an error.
  }

  const url = new URL(request.url)

  let event: BillingEvent | null
  try {
    event = await mercadoPagoProvider.handleWebhookEvent(payload, request.headers, rawBody, url)
  } catch (err) {
    if (err instanceof BillingProviderError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('[billing/webhook] handler error:', err)
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }

  if (!event) return NextResponse.json({ ok: true })

  const admin = supabaseAdmin()

  try {
    if (event.type === 'payment_confirmed') {
      await admin
        .from('account_subscriptions')
        .update({
          plan_id: event.planId,
          external_subscription_id: event.externalSubscriptionId,
          current_period_end: event.periodEnd,
        })
        .eq('account_id', event.accountId)

      // Only clear accounts.status back to 'active' when the current
      // suspension was caused by billing (billing_status was
      // 'past_due') — never override a suspension the super-admin
      // panel set manually for an unrelated reason.
      const { data: account } = await admin
        .from('accounts')
        .select('status, billing_status')
        .eq('id', event.accountId)
        .maybeSingle()

      const update: Record<string, string> = { billing_status: 'active' }
      if (account?.status === 'suspended' && account.billing_status === 'past_due') {
        update.status = 'active'
      }
      await admin.from('accounts').update(update).eq('id', event.accountId)
    }

    if (event.type === 'payment_failed') {
      const accountId = await resolveAccountId(admin, event.externalSubscriptionId)
      if (accountId) {
        await admin.from('accounts').update({ billing_status: 'past_due' }).eq('id', accountId)
      }
    }

    if (event.type === 'subscription_canceled') {
      const accountId = await resolveAccountId(admin, event.externalSubscriptionId)
      if (accountId) {
        await admin.from('accounts').update({ billing_status: 'canceled' }).eq('id', accountId)
      }
    }
  } catch (err) {
    console.error('[billing/webhook] apply error:', err)
    // 500 so MercadoPago retries — see the idempotency note above,
    // it's safe to let it.
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

async function resolveAccountId(
  admin: ReturnType<typeof supabaseAdmin>,
  externalSubscriptionId: string,
): Promise<string | null> {
  const { data } = await admin
    .from('account_subscriptions')
    .select('account_id')
    .eq('external_subscription_id', externalSubscriptionId)
    .maybeSingle()
  return data?.account_id ?? null
}
