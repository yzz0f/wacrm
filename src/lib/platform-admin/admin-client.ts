import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for /api/platform-admin/* routes.
// Mirrors src/lib/ai/admin-client.ts, src/lib/flows/admin-client.ts and
// src/lib/automations/admin-client.ts — these routes read/write across
// every account on the instance, which is exactly what RLS is designed
// to prevent for a normal user, so they bypass it deliberately via the
// service role. Authorization is enforced by requirePlatformAdmin()
// (src/lib/platform-admin/auth.ts) before any of these routes touch
// this client, not by RLS.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
