import type { ReactNode } from 'react';

// Deliberately its own layout, not a wrapper around the normal
// (dashboard) layout — no account switcher, no inbox nav, nothing
// scoped to a single account. Auth/authorization is enforced per
// page via requirePlatformAdminPage(), not here, so the login page
// can render inside this same shell while signed out.
export default function PlatformAdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-3">
        <span className="text-sm font-semibold tracking-tight">wacrm — Platform Admin</span>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
