'use client';

// ============================================================
// InstagramAccountsPanel — Settings → Instagram
//
// Copy of WhatsAppLinesPanel's list+detail pattern (state machine,
// canManage gating, delete confirm) for instagram_accounts. Plain
// English strings, not next-intl — matches the precedent set by
// BillingPanel earlier in this session rather than WhatsApp's fully
// translated panels; can be localized later like everything else was.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { InstagramConfig } from './instagram-config';
import type { InstagramAccount } from '@/types';

export function InstagramAccountsPanel() {
  const supabase = createClient();
  const { accountId, accountRole, loading: authLoading, profileLoading } = useAuth();
  const canManage = accountRole ? canEditSettings(accountRole) : false;

  const [accounts, setAccounts] = useState<InstagramAccount[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 'list' | an existing account's id (edit) | 'new' (create)
  const [view, setView] = useState<'list' | 'new' | string>('list');

  const loadAccounts = useCallback(async (acctId: string) => {
    const { data, error } = await supabase
      .from('instagram_accounts')
      .select('*')
      .eq('account_id', acctId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    if (error) {
      console.error('Failed to load Instagram accounts:', error);
      toast.error('Failed to load Instagram accounts.');
      setAccounts([]);
      return;
    }
    setAccounts((data ?? []) as InstagramAccount[]);
  }, [supabase]);

  useEffect(() => {
    if (authLoading || profileLoading || !accountId) return;
    void loadAccounts(accountId);
  }, [authLoading, profileLoading, accountId, loadAccounts]);

  async function handleDelete(account: InstagramAccount) {
    if (!confirm(`Disconnect "${account.name}"?`)) return;
    setDeletingId(account.id);
    try {
      const res = await fetch(`/api/instagram/config?account_id=${account.id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to disconnect.');
        return;
      }
      toast.success('Disconnected.');
      if (accountId) await loadAccounts(accountId);
    } catch (err) {
      console.error('Delete Instagram account error:', err);
      toast.error('Failed to disconnect.');
    } finally {
      setDeletingId(null);
    }
  }

  if (view === 'new') {
    return (
      <InstagramConfig
        onBack={() => setView('list')}
        onSaved={() => setView('list')}
      />
    );
  }
  if (view !== 'list') {
    return (
      <InstagramConfig
        accountId={view}
        onBack={() => setView('list')}
        onSaved={() => setView('list')}
        onDeleted={() => setView('list')}
      />
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Instagram"
        description="Connect your Instagram business accounts to receive and reply to DMs from the shared inbox."
        action={
          canManage ? (
            <Button onClick={() => setView('new')}>
              <Plus className="size-4" />
              Add account
            </Button>
          ) : undefined
        }
      />

      {accounts === null ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : accounts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm font-medium text-foreground">No Instagram accounts connected yet.</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Connect an Instagram business account to start receiving DMs in your shared inbox.
            </p>
            {canManage && (
              <Button onClick={() => setView('new')} className="mt-1">
                <Plus className="size-4" />
                Add account
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className="flex items-center gap-3 px-4 py-3.5 sm:px-6"
                >
                  <span
                    aria-hidden
                    className={`size-2 shrink-0 rounded-full ${
                      account.status === 'connected' ? 'bg-emerald-500' : 'bg-amber-500'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {account.name}
                      </span>
                      {account.is_default && (
                        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                          Default
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {account.instagram_business_account_id}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setView(account.id)}
                        aria-label={`Edit ${account.name}`}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleDelete(account)}
                        disabled={deletingId === account.id}
                        aria-label={`Disconnect ${account.name}`}
                        className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                      >
                        {deletingId === account.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
