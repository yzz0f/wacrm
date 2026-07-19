import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  createInstagramBroadcast,
  deliverInstagramBroadcast,
  InstagramBroadcastError,
} from './broadcast-instagram-core'

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}
function errResponse(status: number, json: unknown): Response {
  return { ok: false, status, json: async () => json } as unknown as Response
}

function fakeDb(): { db: SupabaseClient; recipientUpdates: Record<string, unknown>[]; broadcastUpdates: Record<string, unknown>[] } {
  const recipientUpdates: Record<string, unknown>[] = []
  const broadcastUpdates: Record<string, unknown>[] = []

  const from = (table: string) => {
    if (table === 'instagram_accounts') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'ig-1', access_token: 'enc-token' }, error: null }) }),
          }),
        }),
      }
    }
    if (table === 'contacts') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              in: () =>
                Promise.resolve({
                  data: [
                    { id: 'c-1', external_id: 'igsid-1' },
                    { id: 'c-2', external_id: 'igsid-2' },
                  ],
                  error: null,
                }),
            }),
          }),
        }),
      }
    }
    if (table === 'broadcasts') {
      return {
        insert: () => ({
          select: () => ({ single: () => Promise.resolve({ data: { id: 'broadcast-1' }, error: null }) }),
        }),
        update: (payload: Record<string, unknown>) => {
          broadcastUpdates.push(payload)
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    }
    if (table === 'broadcast_recipients') {
      return {
        insert: () => ({
          select: () =>
            Promise.resolve({
              data: [
                { id: 'rec-1', contact_id: 'c-1' },
                { id: 'rec-2', contact_id: 'c-2' },
              ],
              error: null,
            }),
        }),
        update: (payload: Record<string, unknown>) => {
          recipientUpdates.push(payload)
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    }
    throw new Error(`unexpected table: ${table}`)
  }

  return { db: { from } as unknown as SupabaseClient, recipientUpdates, broadcastUpdates }
}

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `plain:${v}` }))

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('createInstagramBroadcast', () => {
  it('rejects an empty message', async () => {
    const { db } = fakeDb()
    await expect(
      createInstagramBroadcast(db, 'acct', 'user-1', {
        messageText: '',
        instagramAccountId: 'ig-1',
        contactIds: ['c-1'],
      }),
    ).rejects.toBeInstanceOf(InstagramBroadcastError)
  })

  it('rejects an empty recipient list', async () => {
    const { db } = fakeDb()
    await expect(
      createInstagramBroadcast(db, 'acct', 'user-1', {
        messageText: 'hi',
        instagramAccountId: 'ig-1',
        contactIds: [],
      }),
    ).rejects.toBeInstanceOf(InstagramBroadcastError)
  })

  it('creates the broadcast + recipient rows for valid input', async () => {
    const { db } = fakeDb()
    const plan = await createInstagramBroadcast(db, 'acct', 'user-1', {
      messageText: 'hello everyone',
      instagramAccountId: 'ig-1',
      contactIds: ['c-1', 'c-2'],
    })
    expect(plan.broadcastId).toBe('broadcast-1')
    expect(plan.planned).toHaveLength(2)
    expect(plan.pageAccessToken).toBe('plain:enc-token')
  })
})

describe('deliverInstagramBroadcast', () => {
  it('marks recipients sent on success and the broadcast sent overall', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ recipient_id: 'igsid-1', message_id: 'mid.1' })),
    )
    const { db, recipientUpdates, broadcastUpdates } = fakeDb()
    await deliverInstagramBroadcast(db, {
      broadcastId: 'broadcast-1',
      messageText: 'hi',
      pageAccessToken: 'tok',
      planned: [{ recipientRowId: 'rec-1', contactId: 'c-1', externalId: 'igsid-1' }],
    })
    expect(recipientUpdates[0]).toMatchObject({ status: 'sent' })
    expect(broadcastUpdates[0]).toMatchObject({ status: 'sent' })
  })

  it('marks a failure with the outside-window message when that error occurs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(400, { error: { message: 'window closed', code: 10, error_subcode: 2534022 } })),
    )
    const { db, recipientUpdates, broadcastUpdates } = fakeDb()
    await deliverInstagramBroadcast(db, {
      broadcastId: 'broadcast-1',
      messageText: 'hi',
      pageAccessToken: 'tok',
      planned: [{ recipientRowId: 'rec-1', contactId: 'c-1', externalId: 'igsid-1' }],
    })
    expect(recipientUpdates[0]).toMatchObject({
      status: 'failed',
      error_message: 'Outside the 24-hour messaging window',
    })
    expect(broadcastUpdates[0]).toMatchObject({ status: 'failed' })
  })
})
