// ============================================================
// Provider-agnostic billing interface. Everything downstream of a
// checkout/webhook talks to this, never to a provider's raw shape —
// swapping MercadoPago for another provider later (Stripe, once
// Chile is a supported seller country — see the design spec) means
// writing a new file here, not touching routes/UI/cron.
//
// Mirrors src/lib/ai/providers/ (one adapter per provider, a single
// dispatch point) — with a single provider today, dispatch is just
// importing the adapter directly; a switch isn't needed until a
// second one exists.
// ============================================================

export interface BillingProvider {
  /** Start (or change) a subscription; returns the URL to redirect the browser to. */
  createCheckout(args: {
    accountId: string
    planId: string
    planKey: string
    planName: string
    priceClpMonthly: number
  }): Promise<{ checkoutUrl: string }>

  /**
   * Verify + translate a raw webhook delivery into a normalized event.
   * Returns null for deliveries that don't map to anything we act on
   * (e.g. an unrelated topic) — callers should 200 and no-op, not error.
   */
  handleWebhookEvent(payload: unknown, headers: Headers, rawBody: string, url: URL): Promise<BillingEvent | null>
}

export type BillingEvent =
  | { type: 'payment_confirmed'; accountId: string; planId: string; externalSubscriptionId: string; periodEnd: string }
  | { type: 'payment_failed'; externalSubscriptionId: string }
  | { type: 'subscription_canceled'; externalSubscriptionId: string }

export class BillingProviderError extends Error {
  readonly status: number
  constructor(message: string, status = 502) {
    super(message)
    this.name = 'BillingProviderError'
    this.status = status
  }
}
