import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for billing routes (checkout write,
// webhook, cron). Mirrors src/lib/platform-admin/admin-client.ts and
// the other admin-client factories in this codebase.
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
