'use client';

// ============================================================
// New Instagram broadcast — deliberately a single simple page, not
// a multi-step wizard like /broadcasts/new. WhatsApp's 4-step wizard
// (template → audience → personalize → schedule/send) is built
// around per-recipient template variables and media headers, neither
// of which apply here: an Instagram broadcast is free text, the same
// message for everyone, sent only to contacts reachable within the
// 24-hour messaging window. Threading channel conditionals through
// that wizard would add real complexity for zero benefit — see the
// plan's Fase 0 for the same reasoning applied to the send core.
// ============================================================

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Send } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Contact } from '@/types';

export default function NewInstagramBroadcastPage() {
  const router = useRouter();
  const { instagramAccounts } = useAuth();

  const [instagramAccountId, setInstagramAccountId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [messageText, setMessageText] = useState('');
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (instagramAccountId !== null || instagramAccounts.length === 0) return;
    const defaultAccount = instagramAccounts.find((a) => a.is_default) ?? instagramAccounts[0];
    setInstagramAccountId(defaultAccount.id);
  }, [instagramAccounts, instagramAccountId]);

  useEffect(() => {
    if (!instagramAccountId) return;
    setContacts(null);
    setSelectedIds(new Set());
    fetch(`/api/instagram/reachable-audience?instagram_account_id=${instagramAccountId}`)
      .then((res) => res.json())
      .then((data) => {
        const list: Contact[] = data.contacts ?? [];
        setContacts(list);
        setSelectedIds(new Set(list.map((c) => c.id)));
      })
      .catch(() => setContacts([]));
  }, [instagramAccountId]);

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSend() {
    if (!instagramAccountId) {
      toast.error('No Instagram account connected.');
      return;
    }
    if (!messageText.trim()) {
      toast.error('Write a message first.');
      return;
    }
    if (selectedIds.size === 0) {
      toast.error('Select at least one recipient.');
      return;
    }
    setSending(true);
    try {
      const res = await fetch('/api/instagram/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || undefined,
          message_text: messageText.trim(),
          instagram_account_id: instagramAccountId,
          contact_ids: Array.from(selectedIds),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to send broadcast.');
        return;
      }
      toast.success(`Sent to ${data.total} recipient(s).`);
      router.push(`/broadcasts/${data.broadcast_id}`);
    } catch (err) {
      console.error('Instagram broadcast send error:', err);
      toast.error('Failed to send broadcast.');
    } finally {
      setSending(false);
    }
  }

  if (instagramAccounts.length === 0) {
    return (
      <div className="mx-auto max-w-2xl py-12 text-center text-sm text-muted-foreground">
        Connect an Instagram account in Settings → Instagram first.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">New Instagram broadcast</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Instagram has no approved-template mechanism — this sends a free-text message to
          contacts who wrote to you in the last 24 hours (Instagram&apos;s messaging window).
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4">
          {instagramAccounts.length > 1 && (
            <div className="space-y-2">
              <Label>Instagram account</Label>
              <Select value={instagramAccountId ?? undefined} onValueChange={(v) => v && setInstagramAccountId(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an account" />
                </SelectTrigger>
                <SelectContent>
                  {instagramAccounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="broadcast-name">Name (internal, optional)</Label>
            <Input id="broadcast-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekend promo" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="broadcast-message">Message</Label>
            <Textarea
              id="broadcast-message"
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              rows={4}
              placeholder="Write the message every recipient will receive…"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>Recipients ({selectedIds.size} selected)</Label>
          </div>
          {contacts === null ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : contacts.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No contacts have messaged this account in the last 24 hours.
            </p>
          ) : (
            <ul className="max-h-72 divide-y divide-border overflow-y-auto">
              {contacts.map((contact) => (
                <li key={contact.id} className="flex items-center gap-3 py-2">
                  <Checkbox
                    checked={selectedIds.has(contact.id)}
                    onCheckedChange={() => toggle(contact.id)}
                  />
                  <span className="text-sm text-foreground">
                    {contact.name || contact.external_id}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={() => router.push('/broadcasts')}>
          Cancel
        </Button>
        <Button onClick={handleSend} disabled={sending}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Send
        </Button>
      </div>
    </div>
  );
}
