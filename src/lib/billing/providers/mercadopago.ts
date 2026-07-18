import { createHmac, timingSafeEqual } from 'node:crypto'

import { BillingProviderError, type BillingProvider } from './types'

const MP_API_BASE = 'https://api.mercadopago.com'

function accessToken(): string {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN
  if (!token) throw new BillingProviderError('MERCADOPAGO_ACCESS_TOKEN is not configured', 503)
  return token
}

interface PreapprovalResponse {
  id: string
  init_point?: string
  status?: string
  external_reference?: string
}

/**
 * external_reference carries both the account and the plan being
 * purchased, colon-joined — MercadoPago's preapproval object only
 * has one free-form reference field, and webhook deliveries don't
 * include line-item detail, so this is how the webhook handler
 * later recovers "which account, which plan" from a bare
 * subscription id (see handleWebhookEvent below).
 */
function encodeReference(accountId: string, planId: string): string {
  return `${accountId}:${planId}`
}

function decodeReference(ref: string): { accountId: string; planId: string } | null {
  const [accountId, planId] = ref.split(':')
  if (!accountId || !planId) return null
  return { accountId, planId }
}

/**
 * MercadoPago's recurring-subscription adapter (`/preapproval`).
 * API details verified against MercadoPago's developer docs at
 * implementation time — see the design/plan docs for the exact pages
 * cited. Two things are explicitly flagged for manual sandbox
 * verification before this ships (closeout phase):
 *   1. The exact `x-signature` manifest format (id/request-id/ts) —
 *      implemented per docs below, but MercadoPago's webhook
 *      simulator is the only way to confirm it byte-for-byte.
 *   2. Which webhook `type` values actually fire for a subscription
 *      going from pending → authorized → a recurring charge —
 *      confirmed against docs, not against a live sandbox account.
 */
export const mercadoPagoProvider: BillingProvider = {
  async createCheckout({ accountId, planId, planName, priceClpMonthly }) {
    const backUrl = process.env.NEXT_PUBLIC_SITE_URL
      ? `${process.env.NEXT_PUBLIC_SITE_URL}/settings?tab=billing`
      : undefined

    const res = await fetch(`${MP_API_BASE}/preapproval`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reason: `wacrm — ${planName}`,
        external_reference: encodeReference(accountId, planId),
        back_url: backUrl,
        status: 'pending',
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: priceClpMonthly,
          currency_id: 'CLP',
        },
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new BillingProviderError(`MercadoPago preapproval error (${res.status}): ${detail}`)
    }

    const data = (await res.json()) as PreapprovalResponse
    if (!data.init_point) {
      throw new BillingProviderError('MercadoPago did not return a checkout URL')
    }
    return { checkoutUrl: data.init_point }
  },

  // rawBody unused — MercadoPago's signature manifest is built from
  // id/request-id/ts, not the request body (unlike src/lib/webhooks/sign.ts's
  // own scheme). Kept in the shared interface for providers that do sign
  // the body (e.g. Stripe).
  async handleWebhookEvent(payload, headers, _rawBody, url) {
    if (!verifySignature(headers, url)) {
      throw new BillingProviderError('Invalid webhook signature', 401)
    }

    const body = payload as { type?: string; action?: string; data?: { id?: string } } | null
    const resourceId = body?.data?.id ?? url.searchParams.get('data.id') ?? undefined
    const type = body?.type ?? url.searchParams.get('type') ?? undefined
    if (!resourceId || !type) return null

    if (type === 'subscription_preapproval') {
      const preapproval = await fetchPreapproval(resourceId)
      if (!preapproval) return null
      if (preapproval.status === 'cancelled') {
        return { type: 'subscription_canceled', externalSubscriptionId: preapproval.id }
      }
      if (preapproval.status === 'authorized' && preapproval.external_reference) {
        const ref = decodeReference(preapproval.external_reference)
        if (ref) {
          return {
            type: 'payment_confirmed',
            accountId: ref.accountId,
            planId: ref.planId,
            externalSubscriptionId: preapproval.id,
            // First activation — the real period end lands with the
            // next subscription_authorized_payment event; a month out
            // is a safe initial value so nothing lapses before then.
            periodEnd: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
          }
        }
      }
      return null
    }

    if (type === 'subscription_authorized_payment') {
      const payment = await fetchAuthorizedPayment(resourceId)
      if (!payment) return null
      if (payment.status === 'rejected' || payment.status === 'cancelled') {
        return { type: 'payment_failed', externalSubscriptionId: payment.preapproval_id }
      }
      if (payment.status === 'processed' || payment.status === 'approved') {
        const preapproval = await fetchPreapproval(payment.preapproval_id)
        const ref = preapproval?.external_reference ? decodeReference(preapproval.external_reference) : null
        if (!ref) return null
        return {
          type: 'payment_confirmed',
          accountId: ref.accountId,
          planId: ref.planId,
          externalSubscriptionId: payment.preapproval_id,
          periodEnd: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
        }
      }
      return null
    }

    return null
  },
}

async function fetchPreapproval(id: string): Promise<PreapprovalResponse | null> {
  const res = await fetch(`${MP_API_BASE}/preapproval/${id}`, {
    headers: { Authorization: `Bearer ${accessToken()}` },
  })
  if (!res.ok) return null
  return (await res.json()) as PreapprovalResponse
}

interface AuthorizedPaymentResponse {
  id: string
  preapproval_id: string
  status?: string
}

async function fetchAuthorizedPayment(id: string): Promise<AuthorizedPaymentResponse | null> {
  const res = await fetch(`${MP_API_BASE}/authorized_payments/${id}`, {
    headers: { Authorization: `Bearer ${accessToken()}` },
  })
  if (!res.ok) return null
  return (await res.json()) as AuthorizedPaymentResponse
}

/**
 * `x-signature: ts=<millis>,v1=<hex hmac>` + `x-request-id` header +
 * `data.id` query param, HMAC-SHA256'd as
 * `id:{data.id};request-id:{x-request-id};ts:{ts};` with the webhook
 * secret from MercadoPago's "Your integrations" panel
 * (MERCADOPAGO_WEBHOOK_SECRET). Lowercase data.id first if it's
 * alphanumeric, per MercadoPago's docs.
 */
function verifySignature(headers: Headers, url: URL): boolean {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET
  if (!secret) return false

  const signatureHeader = headers.get('x-signature')
  const requestId = headers.get('x-request-id')
  const dataId = url.searchParams.get('data.id')
  if (!signatureHeader || !requestId || !dataId) return false

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const [k, v] = p.split('=')
      return [k?.trim(), v?.trim()]
    }),
  )
  const ts = parts.ts
  const v1 = parts.v1
  if (!ts || !v1) return false

  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`
  const expected = createHmac('sha256', secret).update(manifest).digest('hex')

  // Constant-time compare; guard against length mismatch (timingSafeEqual
  // throws on unequal-length buffers) — same pattern as
  // src/lib/webhooks/sign.ts.
  if (expected.length !== v1.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1))
}
