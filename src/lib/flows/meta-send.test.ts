import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  state: {
    contact: null as Record<string, unknown> | null,
    conversation: null as Record<string, unknown> | null,
    igAccount: null as Record<string, unknown> | null,
    messageInserts: [] as Record<string, unknown>[],
    conversationUpdates: [] as Record<string, unknown>[],
  },
}))

vi.mock('./admin-client', () => {
  const { state } = h
  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Record<string, unknown>) => {
        if (table === 'messages') state.messageInserts.push(p)
        return { error: null }
      },
      update: (p: Record<string, unknown>) => {
        if (table === 'conversations') state.conversationUpdates.push(p)
        return { eq: () => Promise.resolve({ error: null }) }
      },
      eq: () => b,
      maybeSingle: () =>
        Promise.resolve({
          data:
            table === 'contacts'
              ? state.contact
              : table === 'conversations'
                ? state.conversation
                : table === 'instagram_accounts'
                  ? state.igAccount
                  : null,
          error: null,
        }),
    }
    return b
  }
  return { supabaseAdmin: () => ({ from: (table: string) => builder(table) }) as unknown as SupabaseClient }
})

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `plain:${v}` }))

const sendInstagramText = vi.fn()
const sendInstagramMedia = vi.fn()
vi.mock('@/lib/instagram/meta-instagram-api', () => ({
  sendInstagramText: (...args: unknown[]) => sendInstagramText(...args),
  sendInstagramMedia: (...args: unknown[]) => sendInstagramMedia(...args),
}))

const { engineSendText, engineSendMedia, engineSendInteractiveButtons } = await import('./meta-send')

describe('flows meta-send — Instagram channel routing', () => {
  it('routes engineSendText to Instagram when the conversation has an instagram_account_id', async () => {
    h.state.contact = { id: 'c-1', phone: null, external_id: 'igsid-1' }
    h.state.conversation = { line_id: null, instagram_account_id: 'ig-1' }
    h.state.igAccount = { id: 'ig-1', access_token: 'enc-token' }
    sendInstagramText.mockResolvedValue({ messageId: 'mid.1' })

    const result = await engineSendText({
      accountId: 'acct',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'c-1',
      text: 'hi there',
    })

    expect(result.whatsapp_message_id).toBe('mid.1')
    expect(sendInstagramText).toHaveBeenCalledWith({
      pageAccessToken: 'plain:enc-token',
      recipientId: 'igsid-1',
      text: 'hi there',
    })
  })

  it('routes engineSendMedia to Instagram, mapping document to file', async () => {
    h.state.contact = { id: 'c-1', phone: null, external_id: 'igsid-1' }
    h.state.conversation = { line_id: null, instagram_account_id: 'ig-1' }
    h.state.igAccount = { id: 'ig-1', access_token: 'enc-token' }
    sendInstagramMedia.mockResolvedValue({ messageId: 'mid.2' })

    const result = await engineSendMedia({
      accountId: 'acct',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'c-1',
      kind: 'document',
      link: 'https://example.com/file.pdf',
    })

    expect(result.whatsapp_message_id).toBe('mid.2')
    expect(sendInstagramMedia).toHaveBeenCalledWith({
      pageAccessToken: 'plain:enc-token',
      recipientId: 'igsid-1',
      mediaKind: 'file',
      mediaUrl: 'https://example.com/file.pdf',
    })
  })

  it('rejects engineSendInteractiveButtons on an Instagram conversation', async () => {
    h.state.contact = { id: 'c-1', phone: null, external_id: 'igsid-1' }
    h.state.conversation = { line_id: null, instagram_account_id: 'ig-1' }

    await expect(
      engineSendInteractiveButtons({
        accountId: 'acct',
        userId: 'user-1',
        conversationId: 'conv-1',
        contactId: 'c-1',
        bodyText: 'Pick one',
        buttons: [{ id: 'a', title: 'A' }],
      }),
    ).rejects.toThrow('Instagram conversations do not support buttons/lists yet')
  })
})
