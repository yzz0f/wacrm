import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { getInstagramReachableContacts } from './reachable-audience'

function fakeDb(opts: {
  conversations?: { id: string; contact_id: string }[]
  recentInboundConvIds?: string[]
  contacts?: { id: string; name: string }[]
}): SupabaseClient {
  const { conversations = [], recentInboundConvIds = [], contacts = [] } = opts
  const from = (table: string) => {
    if (table === 'conversations') {
      return {
        select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: conversations, error: null }) }) }),
      }
    }
    if (table === 'messages') {
      return {
        select: () => ({
          in: () => ({
            eq: () => ({
              gte: () =>
                Promise.resolve({
                  data: recentInboundConvIds.map((conversation_id) => ({ conversation_id })),
                  error: null,
                }),
            }),
          }),
        }),
      }
    }
    // contacts
    return { select: () => ({ in: () => Promise.resolve({ data: contacts, error: null }) }) }
  }
  return { from } as unknown as SupabaseClient
}

describe('getInstagramReachableContacts', () => {
  it('returns empty when the account has no Instagram conversations', async () => {
    const result = await getInstagramReachableContacts(fakeDb({}), 'acct', 'ig-1')
    expect(result).toEqual([])
  })

  it('returns empty when no conversation has a recent inbound message', async () => {
    const db = fakeDb({
      conversations: [{ id: 'conv-1', contact_id: 'c-1' }],
      recentInboundConvIds: [],
    })
    const result = await getInstagramReachableContacts(db, 'acct', 'ig-1')
    expect(result).toEqual([])
  })

  it('only includes contacts whose conversation had a recent inbound message', async () => {
    const db = fakeDb({
      conversations: [
        { id: 'conv-1', contact_id: 'c-1' },
        { id: 'conv-2', contact_id: 'c-2' },
      ],
      recentInboundConvIds: ['conv-1'],
      contacts: [{ id: 'c-1', name: 'Reachable' }],
    })
    const result = await getInstagramReachableContacts(db, 'acct', 'ig-1')
    expect(result).toEqual([{ id: 'c-1', name: 'Reachable' }])
  })

  it('deduplicates a contact with multiple recent inbound messages', async () => {
    const db = fakeDb({
      conversations: [{ id: 'conv-1', contact_id: 'c-1' }],
      recentInboundConvIds: ['conv-1', 'conv-1'],
      contacts: [{ id: 'c-1', name: 'Reachable' }],
    })
    const result = await getInstagramReachableContacts(db, 'acct', 'ig-1')
    expect(result).toHaveLength(1)
  })
})
