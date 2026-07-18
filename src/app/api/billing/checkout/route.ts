import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/billing/admin-client'
import { mercadoPagoProvider } from '@/lib/billing/providers/mercadopago'
import { BillingProviderError } from '@/lib/billing/providers/types'

/**
 * POST /api/billing/checkout
 *
 * Admin+ starts (or changes to) a plan. Body: { plan_key: 'pro' | 'business' }.
 * Returns a checkoutUrl the browser redirects to — MercadoPago hosts
 * the actual payment form, this route never touches card data.
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin')

    const body = await request.json().catch(() => null)
    const planKey = body?.plan_key
    if (planKey !== 'pro' && planKey !== 'business') {
      return NextResponse.json({ error: 'plan_key must be "pro" or "business"' }, { status: 400 })
    }

    const admin = supabaseAdmin()
    const { data: plan, error: planErr } = await admin
      .from('plans')
      .select('id, name, price_clp_monthly')
      .eq('key', planKey)
      .eq('is_active', true)
      .maybeSingle()
    if (planErr || !plan) {
      return NextResponse.json({ error: 'Unknown plan' }, { status: 400 })
    }

    const { checkoutUrl } = await mercadoPagoProvider.createCheckout({
      accountId,
      planId: plan.id,
      planKey,
      planName: plan.name,
      priceClpMonthly: plan.price_clp_monthly,
    })

    return NextResponse.json({ checkoutUrl })
  } catch (err) {
    if (err instanceof BillingProviderError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
