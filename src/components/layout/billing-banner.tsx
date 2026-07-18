'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Clock } from 'lucide-react';

interface Subscription {
  subscribed: boolean;
  billingStatus: 'trialing' | 'active' | 'past_due' | 'canceled' | null;
  trialEndsAt?: string | null;
}

function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}

/**
 * Trial/past-due banner, same visual language as ai-thread-banner.tsx
 * and impersonation-banner.tsx. One fetch on mount (not per render) —
 * same reasoning as those two. Renders nothing for 'active' — a
 * healthy subscription needs no persistent nag — and nothing for
 * 'canceled' (accounts.status handles the actual access block by
 * then; no billing-status-having account = billing not set up on
 * this install, also renders nothing).
 */
export function BillingBanner() {
  const [sub, setSub] = useState<Subscription | null>(null);
  // Computed once alongside the fetch, not at render time — Date.now()
  // is impure and the React Compiler flags calling it directly in the
  // component body (same reasoning as ImpersonationBanner's countdown,
  // which ticks via its own effect instead of recomputing on render).
  const [trialDaysLeft, setTrialDaysLeft] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/billing/subscription')
      .then((res) => res.json())
      .then((data: Subscription) => {
        setSub(data);
        setTrialDaysLeft(data.trialEndsAt ? daysUntil(data.trialEndsAt) : null);
      })
      .catch(() => setSub(null));
  }, []);

  if (!sub?.subscribed || !sub.billingStatus) return null;

  if (sub.billingStatus === 'trialing' && trialDaysLeft !== null) {
    const daysLeft = trialDaysLeft;
    return (
      <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-3 py-2 text-xs sm:px-4">
        <Clock className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 font-medium text-foreground">
          Your trial ends in {daysLeft} day{daysLeft === 1 ? '' : 's'}.
        </span>
        <Link
          href="/settings?tab=billing"
          className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted"
        >
          Add payment method
        </Link>
      </div>
    );
  }

  if (sub.billingStatus === 'past_due') {
    return (
      <div className="flex items-center gap-3 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs sm:px-4">
        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 font-medium text-foreground">
          Payment pending — your account will be suspended if this isn&apos;t resolved.
        </span>
        <Link
          href="/settings?tab=billing"
          className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted"
        >
          Resolve payment
        </Link>
      </div>
    );
  }

  return null;
}
