'use client';

// ============================================================
// WhatsAppLinesPanel — Settings → WhatsApp
//
// Replaces the old single "WhatsApp connection" panel. An account can
// now own more than one WhatsApp line (Sales, Support, a branch
// number…), each with its own credentials/WABA. This is the list +
// "Add line" entry point; the actual credentials form is the existing
// WhatsAppConfig component, reused per-line (see its lineId prop).
//
// Who can see what: same tier as the old panel (any member reads, only
// admin+ can add/edit/delete — enforced server-side by the
// whatsapp_lines RLS policies, mirrored here for the UI itself via
// canEditSettings).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfig } from './whatsapp-config';
import type { WhatsAppLine } from '@/types';

export function WhatsAppLinesPanel() {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();
  const { accountId, accountRole, loading: authLoading, profileLoading } = useAuth();
  const canManage = accountRole ? canEditSettings(accountRole) : false;

  const [lines, setLines] = useState<WhatsAppLine[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 'list' | an existing line's id (edit) | 'new' (create)
  const [view, setView] = useState<'list' | 'new' | string>('list');

  const loadLines = useCallback(async (acctId: string) => {
    const { data, error } = await supabase
      .from('whatsapp_lines')
      .select('*')
      .eq('account_id', acctId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    if (error) {
      console.error('Failed to load WhatsApp lines:', error);
      toast.error(t('toastLoadFailed'));
      setLines([]);
      return;
    }
    setLines((data ?? []) as WhatsAppLine[]);
  }, [supabase, t]);

  useEffect(() => {
    if (authLoading || profileLoading || !accountId) return;
    void loadLines(accountId);
  }, [authLoading, profileLoading, accountId, loadLines]);

  async function handleDelete(line: WhatsAppLine) {
    if (!confirm(t('deleteLineConfirm', { name: line.name }))) return;
    setDeletingId(line.id);
    try {
      const res = await fetch(`/api/whatsapp/config?line_id=${line.id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('toastDeleteFailed'));
        return;
      }
      toast.success(t('toastDeleted'));
      if (accountId) await loadLines(accountId);
    } catch (err) {
      console.error('Delete line error:', err);
      toast.error(t('toastDeleteFailed'));
    } finally {
      setDeletingId(null);
    }
  }

  if (view === 'new') {
    return (
      <WhatsAppConfig
        onBack={() => setView('list')}
        onSaved={() => setView('list')}
      />
    );
  }
  if (view !== 'list') {
    return (
      <WhatsAppConfig
        lineId={view}
        onBack={() => setView('list')}
        onSaved={() => setView('list')}
        onDeleted={() => setView('list')}
      />
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('linesTitle')}
        description={t('linesDesc')}
        action={
          canManage ? (
            <Button onClick={() => setView('new')}>
              <Plus className="size-4" />
              {t('addLine')}
            </Button>
          ) : undefined
        }
      />

      {lines === null ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : lines.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm font-medium text-foreground">{t('noLinesYet')}</p>
            <p className="max-w-sm text-xs text-muted-foreground">{t('noLinesHint')}</p>
            {canManage && (
              <Button onClick={() => setView('new')} className="mt-1">
                <Plus className="size-4" />
                {t('addLine')}
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {lines.map((line) => (
                <li
                  key={line.id}
                  className="flex items-center gap-3 px-4 py-3.5 sm:px-6"
                >
                  <span
                    aria-hidden
                    className={`size-2 shrink-0 rounded-full ${
                      line.status === 'connected' ? 'bg-emerald-500' : 'bg-amber-500'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {line.name}
                      </span>
                      {line.is_default && (
                        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                          {t('defaultBadge')}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {line.phone_number_id}
                      {' · '}
                      {line.registered_at ? t('lineRegisteredShort') : t('lineNotRegisteredShort')}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setView(line.id)}
                        aria-label={t('editLineAria', { name: line.name })}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleDelete(line)}
                        disabled={deletingId === line.id}
                        aria-label={t('deleteLineAria', { name: line.name })}
                        className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                      >
                        {deletingId === line.id ? (
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

      <p className="mt-3 text-xs text-muted-foreground">{t('lineAccessHint')}</p>
    </section>
  );
}
