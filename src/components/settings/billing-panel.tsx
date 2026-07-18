'use client';

// ============================================================
// BillingPanel — Settings → Billing
//
// Shows the account's current plan + billing status, and lets an
// admin+ switch plans via MercadoPago-hosted checkout (no card form
// of our own — see docs/superpowers/specs/2026-07-18-billing-plans-design.md).
// Read-only for agent/viewer, same tier as other Settings panels.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

interface Plan {
  id: string;
  key: string;
  name: string;
  price_clp_monthly: number;
  max_lines: number | null;
  max_agents: number | null;
  ai_enabled: boolean;
}

interface Subscription {
  subscribed: boolean;
  billingStatus: 'trialing' | 'active' | 'past_due' | 'canceled' | null;
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
  plan?: { key: string; name: string } | null;
}

const STATUS_LABEL: Record<string, string> = {
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment overdue',
  canceled: 'Canceled',
};

const STATUS_VARIANT: Record<string, 'default' | 'destructive' | 'secondary'> = {
  trialing: 'secondary',
  active: 'default',
  past_due: 'destructive',
  canceled: 'destructive',
};

function formatClp(amount: number): string {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(amount);
}

// Module-scope helper, not inlined in the component body — the React
// Compiler's escape analysis misclassifies a direct
// `window.location.href = ...` assignment inside a handler called
// from a `.map()`-generated closure as mutating a value "outside the
// component" (a false positive; same navigation pattern is used
// without issue in account-detail-client.tsx, whose handler isn't
// invoked from inside a .map()). Routing the assignment through its
// own function sidesteps the misanalysis.
function redirectTo(url: string) {
  window.location.href = url;
}

export function BillingPanel() {
  const { accountRole } = useAuth();
  const canManage = accountRole ? canEditSettings(accountRole) : false;

  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      fetch('/api/billing/plans').then((r) => r.json()),
      fetch('/api/billing/subscription').then((r) => r.json()),
    ])
      .then(([plansRes, subRes]) => {
        setPlans(plansRes.plans ?? []);
        setSubscription(subRes);
      })
      .catch(() => {
        setPlans([]);
        setSubscription(null);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleChangePlan(planKey: string) {
    setSwitchingTo(planKey);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_key: planKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to start checkout');
        setSwitchingTo(null);
        return;
      }
      redirectTo(data.checkoutUrl);
    } catch {
      toast.error('Failed to start checkout');
      setSwitchingTo(null);
    }
  }

  if (!plans || !subscription) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsPanelHead
        title="Billing"
        description="Your plan and payment status."
      />

      <Card>
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              {subscription.plan?.name ?? 'No plan'}
            </p>
            {subscription.billingStatus === 'trialing' && subscription.trialEndsAt && (
              <p className="text-xs text-muted-foreground">
                Trial ends {new Date(subscription.trialEndsAt).toLocaleDateString()}
              </p>
            )}
            {subscription.billingStatus === 'past_due' && (
              <p className="text-xs text-destructive">
                Payment pending — your account will be suspended if this isn&apos;t resolved.
              </p>
            )}
          </div>
          {subscription.billingStatus && (
            <Badge variant={STATUS_VARIANT[subscription.billingStatus]}>
              {STATUS_LABEL[subscription.billingStatus]}
            </Badge>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <div className="grid gap-4 sm:grid-cols-2">
          {plans.map((plan) => {
            const isCurrent = subscription.plan?.key === plan.key;
            return (
              <Card key={plan.id}>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-foreground">{plan.name}</p>
                    {isCurrent && <CheckCircle2 className="h-4 w-4 text-primary" />}
                  </div>
                  <p className="text-lg font-bold text-foreground">
                    {formatClp(plan.price_clp_monthly)}
                    <span className="text-xs font-normal text-muted-foreground"> /mes</span>
                  </p>
                  <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                    <li>{plan.max_lines ? `${plan.max_lines} líneas de WhatsApp` : 'Líneas de WhatsApp ilimitadas'}</li>
                    <li>{plan.max_agents ? `${plan.max_agents} miembros` : 'Miembros ilimitados'}</li>
                    <li>{plan.ai_enabled ? 'Asistente de IA incluido' : 'Sin asistente de IA'}</li>
                  </ul>
                  <Button
                    size="sm"
                    variant={isCurrent ? 'outline' : 'default'}
                    disabled={isCurrent || switchingTo !== null}
                    onClick={() => handleChangePlan(plan.key)}
                  >
                    {switchingTo === plan.key ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : isCurrent ? (
                      'Plan actual'
                    ) : (
                      'Cambiar a este plan'
                    )}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
