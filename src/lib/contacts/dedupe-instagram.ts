import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Instagram-contact lookup, parallel to findExistingContact
 * (src/lib/contacts/dedupe.ts) but simpler: an IGSID is an opaque
 * exact identifier, not a phone number, so there's no fuzzy/suffix
 * matching to do — the partial unique index on
 * (account_id, platform, external_id) added in migration 043 makes
 * this a direct equality lookup.
 */
export interface ExistingInstagramContact {
  id: string
  external_id: string
  name?: string | null
  [key: string]: unknown
}

export async function findExistingInstagramContact(
  db: SupabaseClient,
  accountId: string,
  externalId: string,
): Promise<ExistingInstagramContact | null> {
  const { data, error } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('platform', 'instagram')
    .eq('external_id', externalId)
    .maybeSingle()

  if (error || !data) return null
  return data as ExistingInstagramContact
}
