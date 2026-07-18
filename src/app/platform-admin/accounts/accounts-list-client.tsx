'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

interface AccountRow {
  id: string;
  name: string;
  ownerEmail: string | null;
  status: 'active' | 'suspended' | 'pending_deletion';
  memberCount: number;
  hasWhatsappLine: boolean;
  createdAt: string;
}

const STATUS_VARIANT: Record<AccountRow['status'], 'default' | 'destructive' | 'secondary'> = {
  active: 'default',
  suspended: 'destructive',
  pending_deletion: 'secondary',
};

export function AccountsListClient() {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch('/api/platform-admin/accounts')
      .then((res) => res.json())
      .then((data) => setAccounts(data.accounts ?? []))
      .catch(() => setAccounts([]));
  }, []);

  // Client-side filter over the already-loaded list — same pattern
  // as the other roster/search views in this app (no server round
  // trip per keystroke).
  const filtered = useMemo(() => {
    if (!accounts) return [];
    const q = search.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.ownerEmail ?? '').toLowerCase().includes(q),
    );
  }, [accounts, search]);

  return (
    <div className="flex flex-col gap-5">
      <SettingsPanelHead
        title="Accounts"
        description="Every account on this instance."
      />

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or owner email…"
          className="pl-9"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {accounts === null ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No accounts match.</div>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{a.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {a.ownerEmail ?? '—'} · {a.memberCount} member{a.memberCount === 1 ? '' : 's'}
                      {a.hasWhatsappLine ? '' : ' · no WhatsApp connected'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Badge variant={STATUS_VARIANT[a.status]}>{a.status}</Badge>
                    <Link
                      href={`/platform-admin/accounts/${a.id}`}
                      className="text-sm font-medium text-primary hover:text-primary/80"
                    >
                      View
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
