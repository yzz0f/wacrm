import type { SupabaseClient } from '@supabase/supabase-js'
import type { Contact } from '@/types'

const WINDOW_HOURS = 24

/**
 * Contacts on `instagramAccountId` reachable by a broadcast right
 * now: those with at least one inbound message (`sender_type =
 * 'customer'`) within the last 24 hours — Instagram's messaging
 * window. Deliberately does NOT use `conversations.last_message_at`,
 * which updates on outbound sends too (see
 * src/app/api/instagram/webhook/route.ts and
 * src/lib/instagram/send-instagram-message.ts) — an agent replying
 * would incorrectly "extend" the window if that column were used.
 *
 * Three round trips rather than one embedded-join query: keeps each
 * step simple and avoids PostgREST embed/schema-cache pitfalls
 * already documented elsewhere in this codebase (see the comment on
 * getCurrentAccount in src/lib/auth/account.ts).
 */
export async function getInstagramReachableContacts(
  db: SupabaseClient,
  accountId: string,
  instagramAccountId: string,
): Promise<Contact[]> {
  const { data: conversations } = await db
    .from('conversations')
    .select('id, contact_id')
    .eq('account_id', accountId)
    .eq('instagram_account_id', instagramAccountId)

  if (!conversations || conversations.length === 0) return []

  const conversationIds = conversations.map((c) => c.id as string)
  const cutoff = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString()

  const { data: recentInbound } = await db
    .from('messages')
    .select('conversation_id')
    .in('conversation_id', conversationIds)
    .eq('sender_type', 'customer')
    .gte('created_at', cutoff)

  if (!recentInbound || recentInbound.length === 0) return []

  const reachableConvIds = new Set(recentInbound.map((m) => m.conversation_id as string))
  const contactIds = [
    ...new Set(
      conversations
        .filter((c) => reachableConvIds.has(c.id as string))
        .map((c) => c.contact_id as string),
    ),
  ]
  if (contactIds.length === 0) return []

  const { data: contacts } = await db
    .from('contacts')
    .select('*')
    .in('id', contactIds)

  return (contacts ?? []) as Contact[]
}
