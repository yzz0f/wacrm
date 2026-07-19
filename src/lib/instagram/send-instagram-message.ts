// ============================================================
// Outbound Instagram DM send — parallel to
// src/lib/whatsapp/send-message.ts (sendMessageToConversation), but
// deliberately simpler: no templates (Instagram has no equivalent to
// WhatsApp's approved templates — out of scope for this sub-project),
// no phone-variant retry (an IGSID has no format variants to try).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { sendInstagramText, sendInstagramMedia, type InstagramMediaKind } from './meta-instagram-api'
import { decrypt } from '@/lib/whatsapp/encryption'

export class SendInstagramMessageError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'SendInstagramMessageError'
    this.code = code
    this.status = status
  }
}

export const INSTAGRAM_MEDIA_KINDS = ['image', 'video', 'audio', 'file'] as const
export const VALID_INSTAGRAM_MESSAGE_TYPES = ['text', ...INSTAGRAM_MEDIA_KINDS] as const

export interface SendInstagramMessageParams {
  conversationId: string
  messageType: (typeof VALID_INSTAGRAM_MESSAGE_TYPES)[number]
  contentText?: string | null
  mediaUrl?: string | null
}

export interface SendInstagramMessageResult {
  messageId: string
  instagramMessageId: string
}

/**
 * Send a message in an existing Instagram conversation and persist
 * it. `db` may be RLS-scoped (dashboard) or the service-role client —
 * every query is filtered by `accountId` either way.
 */
export async function sendInstagramMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendInstagramMessageParams,
): Promise<SendInstagramMessageResult> {
  const { conversationId, messageType, contentText, mediaUrl } = params

  if (!conversationId) {
    throw new SendInstagramMessageError('bad_request', 'conversation_id is required', 400)
  }
  if (!(VALID_INSTAGRAM_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendInstagramMessageError('bad_request', `Unsupported message_type "${messageType}"`, 400)
  }
  if (messageType === 'text' && !contentText) {
    throw new SendInstagramMessageError('bad_request', 'content_text is required for text messages', 400)
  }
  if (messageType !== 'text' && !mediaUrl) {
    throw new SendInstagramMessageError('bad_request', `media_url is required for ${messageType} messages`, 400)
  }

  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single()

  if (convError || !conversation) {
    throw new SendInstagramMessageError('not_found', 'Conversation not found', 404)
  }

  const contact = conversation.contact
  if (!contact?.external_id) {
    throw new SendInstagramMessageError('bad_request', 'Contact has no Instagram external_id', 400)
  }

  if (!conversation.instagram_account_id) {
    throw new SendInstagramMessageError('bad_request', 'Conversation has no Instagram account', 400)
  }

  const { data: igAccount, error: igAccountError } = await db
    .from('instagram_accounts')
    .select('*')
    .eq('id', conversation.instagram_account_id)
    .eq('account_id', accountId)
    .maybeSingle()

  if (igAccountError || !igAccount) {
    throw new SendInstagramMessageError('whatsapp_not_configured', 'Instagram account not found', 400)
  }

  const pageAccessToken = decrypt(igAccount.access_token)

  let instagramMessageId: string
  try {
    if (messageType === 'text') {
      const result = await sendInstagramText({
        pageAccessToken,
        recipientId: contact.external_id,
        text: contentText!,
      })
      instagramMessageId = result.messageId
    } else {
      const result = await sendInstagramMedia({
        pageAccessToken,
        recipientId: contact.external_id,
        mediaKind: messageType as InstagramMediaKind,
        mediaUrl: mediaUrl!,
      })
      instagramMessageId = result.messageId
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta error'
    throw new SendInstagramMessageError('meta_error', message, 502)
  }

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: messageType,
      content_text: contentText ?? null,
      media_url: mediaUrl || null,
      message_id: instagramMessageId,
      status: 'sent',
    })
    .select()
    .single()

  if (msgError) {
    console.error('[send-instagram-message] error inserting sent message:', msgError)
    throw new SendInstagramMessageError(
      'db_error',
      `Message sent to Meta but failed to save to DB: ${msgError.message}`,
      500,
    )
  }

  await db
    .from('conversations')
    .update({
      last_message_text: contentText || `[${messageType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  return { messageId: messageRecord.id, instagramMessageId }
}
