'use client';

import { useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';

interface Status {
  active: boolean;
  expiresAt?: string;
  accountName?: string | null;
}

/**
 * Persistent banner shown for the duration of a support impersonation
 * session — same visual language as Inbox's `aiBanner`
 * (src/components/inbox/ai-thread-banner.tsx). Fetches its status
 * once on mount rather than on every render (same reasoning as that
 * component's per-account status cache): a countdown re-render every
 * second must not trigger a new request each time.
 */
export function ImpersonationBanner() {
  const [status, setStatus] = useState<Status | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const endingRef = useRef(false);

  useEffect(() => {
    fetch('/api/impersonation/status')
      .then((res) => res.json())
      .then(setStatus)
      .catch(() => setStatus({ active: false }));
  }, []);

  const endImpersonation = async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    setBusy(true);
    try {
      const res = await fetch('/api/impersonation/end', { method: 'POST' });
      const data = await res.json();
      window.location.href = data.redirectUrl || '/login';
    } catch {
      window.location.href = '/login';
    }
  };

  useEffect(() => {
    if (!status?.active || !status.expiresAt) return;
    const expiresAt = new Date(status.expiresAt).getTime();

    const tick = () => {
      const remaining = expiresAt - Date.now();
      setRemainingMs(remaining);
      if (remaining <= 0) {
        endImpersonation();
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [status?.active, status?.expiresAt]);

  if (!status?.active) return null;

  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');

  return (
    <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs sm:px-4">
      <div className="min-w-0 flex-1">
        <span className="font-medium text-foreground">
          Acting as {status.accountName ?? 'this account'} — {mm}:{ss} remaining
        </span>
      </div>
      <button
        type="button"
        onClick={endImpersonation}
        disabled={busy}
        className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
      >
        <LogOut className="h-3 w-3" />
        Exit
      </button>
    </div>
  );
}
