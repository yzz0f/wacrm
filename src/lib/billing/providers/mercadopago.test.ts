import { createHmac } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { mercadoPagoProvider } from './mercadopago'
import { BillingProviderError } from './types'

const SECRET = 'test-webhook-secret'

function signedHeaders(dataId: string, ts = String(Date.now())): Headers {
  const requestId = 'req-123'
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`
  const v1 = createHmac('sha256', SECRET).update(manifest).digest('hex')
  return new Headers({
    'x-signature': `ts=${ts},v1=${v1}`,
    'x-request-id': requestId,
  })
}

function urlWithDataId(dataId: string): URL {
  return new URL(`https://example.com/api/billing/webhook?data.id=${dataId}&type=subscription_preapproval`)
}

beforeEach(() => {
  vi.stubEnv('MERCADOPAGO_WEBHOOK_SECRET', SECRET)
  vi.stubEnv('MERCADOPAGO_ACCESS_TOKEN', 'test-token')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('mercadoPagoProvider.handleWebhookEvent — signature verification', () => {
  it('throws on a missing signature header', async () => {
    await expect(
      mercadoPagoProvider.handleWebhookEvent(
        { type: 'subscription_preapproval', data: { id: 'abc123' } },
        new Headers(),
        '',
        urlWithDataId('abc123'),
      ),
    ).rejects.toBeInstanceOf(BillingProviderError)
  })

  it('throws on an invalid signature', async () => {
    const headers = signedHeaders('abc123')
    // Tamper: sign for a different data.id than what's in the URL.
    await expect(
      mercadoPagoProvider.handleWebhookEvent(
        { type: 'subscription_preapproval', data: { id: 'different-id' } },
        headers,
        '',
        urlWithDataId('different-id'),
      ),
    ).rejects.toBeInstanceOf(BillingProviderError)
  })

  it('accepts a validly signed request and returns null for a cancelled-lookup miss', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const headers = signedHeaders('abc123')
    const result = await mercadoPagoProvider.handleWebhookEvent(
      { type: 'subscription_preapproval', data: { id: 'abc123' } },
      headers,
      '',
      urlWithDataId('abc123'),
    )
    // Signature passed; the follow-up GET failed (mocked not-ok), so
    // the handler returns null rather than throwing.
    expect(result).toBeNull()
  })

  it('maps an authorized preapproval with a decodable reference to payment_confirmed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'sub-1',
          status: 'authorized',
          external_reference: 'account-1:plan-1',
        }),
      }),
    )
    const headers = signedHeaders('abc123')
    const result = await mercadoPagoProvider.handleWebhookEvent(
      { type: 'subscription_preapproval', data: { id: 'abc123' } },
      headers,
      '',
      urlWithDataId('abc123'),
    )
    expect(result).toMatchObject({
      type: 'payment_confirmed',
      accountId: 'account-1',
      planId: 'plan-1',
      externalSubscriptionId: 'sub-1',
    })
  })

  it('returns null for an unrecognized webhook type', async () => {
    const headers = signedHeaders('abc123')
    const result = await mercadoPagoProvider.handleWebhookEvent(
      { type: 'unknown_topic', data: { id: 'abc123' } },
      headers,
      '',
      new URL('https://example.com/api/billing/webhook?data.id=abc123&type=unknown_topic'),
    )
    expect(result).toBeNull()
  })
})
