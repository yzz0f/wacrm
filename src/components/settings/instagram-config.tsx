'use client';

// ============================================================
// InstagramConfig — credentials form embedded by
// InstagramAccountsPanel, one per Instagram business account.
//
// Simplified relative to WhatsAppConfig: no "Registration Status"
// block (no Meta register/subscribe step exists for Instagram
// Messaging's manual-entry connection model) and no webhook-URL
// auto-registration card. Just the credentials form + save/delete.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import type { InstagramAccount } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';

export interface InstagramConfigProps {
  accountId?: string;
  onSaved?: () => void;
  onDeleted?: () => void;
  onBack?: () => void;
}

export function InstagramConfig({ accountId: igAccountId, onSaved, onDeleted, onBack }: InstagramConfigProps = {}) {
  const supabase = createClient();
  const { accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [existing, setExisting] = useState<InstagramAccount | null>(null);

  const [name, setName] = useState('');
  const [businessAccountId, setBusinessAccountId] = useState('');
  const [pageId, setPageId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const fetchExisting = useCallback(async () => {
    if (!igAccountId || !accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from('instagram_accounts')
      .select('*')
      .eq('id', igAccountId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (data) {
      const row = data as InstagramAccount;
      setExisting(row);
      setName(row.name);
      setBusinessAccountId(row.instagram_business_account_id);
      setPageId(row.page_id);
      setAccessToken(MASKED_TOKEN);
      setTokenEdited(false);
    }
    setLoading(false);
  }, [supabase, igAccountId, accountId]);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    void fetchExisting();
  }, [authLoading, profileLoading, fetchExisting]);

  async function handleSave() {
    if (!businessAccountId.trim() || !pageId.trim()) {
      toast.error('Instagram Business Account ID and Page ID are required.');
      return;
    }
    if (!existing && (!accessToken.trim() || !tokenEdited)) {
      toast.error('Access token is required.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/instagram/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: igAccountId,
          create: !igAccountId,
          name: name.trim(),
          instagram_business_account_id: businessAccountId.trim(),
          page_id: pageId.trim(),
          access_token: tokenEdited ? accessToken.trim() : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to save.');
        return;
      }
      toast.success('Instagram account saved.');
      onSaved?.();
    } catch (err) {
      console.error('Instagram config save error:', err);
      toast.error('Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!igAccountId) return;
    if (!confirm('Disconnect this Instagram account?')) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/instagram/config?account_id=${igAccountId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to disconnect.');
        return;
      }
      toast.success('Disconnected.');
      onDeleted?.();
    } catch (err) {
      console.error('Instagram config delete error:', err);
      toast.error('Failed to disconnect.');
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsPanelHead
        title={existing ? 'Edit Instagram account' : 'Connect Instagram account'}
        description="Paste the credentials for an Instagram business account linked to a Facebook Page."
        action={
          onBack ? (
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
          ) : undefined
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Credentials</CardTitle>
          <CardDescription>Get these from Meta for Developers → your app → Instagram Messaging.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ig-name">Name</Label>
            <Input id="ig-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Instagram" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ig-business-account-id">Instagram Business Account ID</Label>
            <Input
              id="ig-business-account-id"
              value={businessAccountId}
              onChange={(e) => setBusinessAccountId(e.target.value)}
              placeholder="e.g. 17841400000000000"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ig-page-id">Facebook Page ID</Label>
            <Input
              id="ig-page-id"
              value={pageId}
              onChange={(e) => setPageId(e.target.value)}
              placeholder="e.g. 100000000000000"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ig-access-token">Page access token</Label>
            <div className="relative">
              <Input
                id="ig-access-token"
                type={showToken ? 'text' : 'password'}
                value={accessToken}
                onChange={(e) => {
                  setAccessToken(e.target.value);
                  setTokenEdited(true);
                }}
                onFocus={() => {
                  if (!tokenEdited && existing) {
                    setAccessToken('');
                    setTokenEdited(true);
                  }
                }}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowToken((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            {existing ? (
              <Button
                variant="ghost"
                onClick={handleDelete}
                disabled={deleting}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                {deleting ? <Loader2 className="size-4 animate-spin" /> : 'Disconnect'}
              </Button>
            ) : (
              <span />
            )}
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : 'Save'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
