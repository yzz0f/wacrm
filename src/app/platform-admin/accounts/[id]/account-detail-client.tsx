'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface AccountDetail {
  account: {
    id: string;
    name: string;
    ownerEmail: string | null;
    status: 'active' | 'suspended' | 'pending_deletion';
    billingStatus: 'trialing' | 'active' | 'past_due' | 'canceled' | null;
    deletionRequestedAt: string | null;
    createdAt: string;
  };
  whatsappLines: { id: string; name: string; phone_number_id: string; status: string; registered_at: string | null }[];
  billing: { planName: string | null; trialEndsAt: string | null; currentPeriodEnd: string | null } | null;
  metrics: { memberCount: number; conversationCount: number; messageCount30d: number };
  impersonationHistory: {
    id: string;
    reason: string | null;
    started_at: string;
    expires_at: string;
    ended_at: string | null;
  }[];
}

const STATUS_VARIANT: Record<AccountDetail['account']['status'], 'default' | 'destructive' | 'secondary'> = {
  active: 'default',
  suspended: 'destructive',
  pending_deletion: 'secondary',
};

const BILLING_STATUS_VARIANT: Record<string, 'default' | 'destructive' | 'secondary'> = {
  trialing: 'secondary',
  active: 'default',
  past_due: 'destructive',
  canceled: 'destructive',
};

export function AccountDetailClient({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/platform-admin/accounts/${accountId}`)
      .then((res) => res.json())
      .then((data) => setDetail(data))
      .catch(() => setError('Failed to load account'));
  }, [accountId]);

  useEffect(() => {
    load();
  }, [load]);

  async function runAction(path: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/platform-admin/accounts/${accountId}/${path}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Action failed');
        return;
      }
      load();
    } finally {
      setBusy(false);
    }
  }

  async function handleImpersonate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/platform-admin/accounts/${accountId}/impersonate`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed to start impersonation');
        setBusy(false);
        return;
      }
      window.location.href = data.redirectUrl;
    } catch {
      setError('Failed to start impersonation');
      setBusy(false);
    }
  }

  if (!detail) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  const { account, whatsappLines, billing, metrics, impersonationHistory } = detail;

  return (
    <div className="flex flex-col gap-6">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        onClick={() => router.push('/platform-admin/accounts')}
      >
        ← Back to accounts
      </Button>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-foreground">{account.name}</h1>
            <Badge variant={STATUS_VARIANT[account.status]}>{account.status}</Badge>
            {account.billingStatus && (
              <Badge variant={BILLING_STATUS_VARIANT[account.billingStatus]}>{account.billingStatus}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{account.ownerEmail ?? '—'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || account.status !== 'active'}
            onClick={handleImpersonate}
          >
            <ShieldAlert className="h-4 w-4" />
            Act as owner
          </Button>
          {account.status === 'active' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => runAction('suspend')}
            >
              Suspend
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => runAction('reactivate')}
            >
              Reactivate
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <MetricCard label="Members" value={metrics.memberCount} />
        <MetricCard label="Conversations" value={metrics.conversationCount} />
        <MetricCard label="Messages (30d)" value={metrics.messageCount30d} />
        <MetricCard
          label="WhatsApp lines"
          value={
            whatsappLines.length === 0
              ? 'None connected'
              : `${whatsappLines.length} (${whatsappLines.filter((l) => l.registered_at).length} registered)`
          }
        />
        <MetricCard label="Plan" value={billing?.planName ?? 'No plan'} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Impersonation history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {impersonationHistory.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No impersonation sessions yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {impersonationHistory.map((h) => (
                <li key={h.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div>
                    <p className="text-foreground">{h.reason || 'Support access'}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(h.started_at).toLocaleString()}
                      {h.ended_at ? ` · ended ${new Date(h.ended_at).toLocaleString()}` : ' · in progress'}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm text-red-400">Danger zone</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          {account.status === 'pending_deletion' ? (
            <>
              <p className="text-sm text-muted-foreground">
                Deletion requested {account.deletionRequestedAt ? new Date(account.deletionRequestedAt).toLocaleDateString() : ''} —
                purges automatically after the grace period.
              </p>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => runAction('cancel-deletion')}>
                Cancel deletion
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Marks the account for deletion after a grace period. Reversible until then.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="text-red-400 hover:text-red-400"
                disabled={busy}
                onClick={() => runAction('request-deletion')}
              >
                Request deletion
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-lg font-semibold text-foreground">{value}</span>
      </CardContent>
    </Card>
  );
}
