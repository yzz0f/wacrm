import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message'
import {
  sendInstagramMessageToConversation,
  SendInstagramMessageError,
  VALID_INSTAGRAM_MESSAGE_TYPES,
} from '@/lib/instagram/send-instagram-message'

// The dashboard's outbound-send endpoint. It owns auth, per-user rate
// limiting, and the two ways the UI targets a thread — an existing
// `conversation_id` (inbox) or a `contact_id` (Contact detail →
// find-or-create the conversation). The actual Meta plumbing (validate
// → send → persist → pause flows) lives in the shared
// `sendMessageToConversation` core, which the public `/api/v1/messages`
// endpoint reuses. This route is a thin adapter: resolve the
// conversation, delegate, then map `SendMessageError` back onto the
// dashboard's internal `{ error }` shape.
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Resolve the caller's account_id. Every downstream lookup
    // (conversation, whatsapp_lines, message_templates) is account-
    // scoped post-multi-user, so the previous `user_id` filters
    // returned nothing for teammates who didn't author the row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      // `conversation_id` targets an existing thread (inbox). `contact_id`
      // lets a caller initiate from a contact that may have no conversation
      // yet (Contact detail → Send template) — we find-or-create one below.
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      interactive_payload,
      reply_to_message_id,
    } = body

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 }
      )
    }

    // Validate the message shape up front — before the contact_id path
    // finds-or-creates a conversation — so an invalid payload 400s
    // without leaving an orphan empty conversation behind.
    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        interactivePayload: interactive_payload,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    // Resolve the target conversation. With `conversation_id` we load the
    // existing thread; with `contact_id` we find-or-create one for the
    // contact so a business-initiated template send (Contact detail view)
    // reuses the shared send core below.
    let conversationId: string | null = null

    // Resolved alongside conversationId so the single dispatch point
    // below (WhatsApp vs Instagram) doesn't need a second round trip.
    let conversationChannel: { line_id: string | null; instagram_account_id: string | null } | null = null

    if (conversationIdInput) {
      const { data, error: convError } = await supabase
        .from('conversations')
        .select('id, line_id, instagram_account_id')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single()

      if (convError || !data) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        )
      }
      conversationId = data.id
      conversationChannel = { line_id: data.line_id, instagram_account_id: data.instagram_account_id }
    } else {
      // contact_id path: verify the contact is in this account first so a
      // caller can't open a conversation against someone else's contact.
      const { data: contactRow, error: contactErr } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .maybeSingle()

      if (contactErr || !contactRow) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        )
      }

      // This path only ever creates a WhatsApp conversation — it's the
      // "Contact detail → Send template" flow, and templates have no
      // Instagram equivalent in this sub-project (out of scope).
      const resolved = await findOrCreateConversation(
        supabase,
        accountId,
        user.id,
        contact_id
      )
      if (!resolved) {
        return NextResponse.json(
          { error: 'Failed to open a conversation for this contact' },
          { status: 500 }
        )
      }
      conversationId = resolved.id
      conversationChannel = { line_id: resolved.lineId, instagram_account_id: null }
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    // Single dispatch point: a conversation belongs to exactly one
    // channel account (line_id XOR instagram_account_id, enforced by
    // the one_channel_account CHECK — 043_instagram_foundation.sql).
    // Not scattered across other call sites — this is the only place
    // a dashboard-initiated send decides which channel to use.
    if (conversationChannel?.instagram_account_id) {
      if (!(VALID_INSTAGRAM_MESSAGE_TYPES as readonly string[]).includes(message_type)) {
        return NextResponse.json(
          { error: `message_type "${message_type}" is not supported on Instagram` },
          { status: 400 },
        )
      }
      try {
        const result = await sendInstagramMessageToConversation(supabase, accountId, {
          conversationId,
          messageType: message_type,
          contentText: content_text,
          mediaUrl: media_url,
        })

        return NextResponse.json({
          success: true,
          message_id: result.messageId,
          instagram_message_id: result.instagramMessageId,
        })
      } catch (err) {
        if (err instanceof SendInstagramMessageError) {
          return NextResponse.json({ error: err.message }, { status: err.status })
        }
        throw err
      }
    }

    // Delegate to the shared send core (validates, sends to Meta with
    // phone-variant retry, persists, pauses active flow runs). Its
    // `SendMessageError` carries a machine code + HTTP status; the
    // dashboard maps it to the internal `{ error }` shape.
    try {
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId,
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        filename,
        templateName: template_name,
        templateLanguage: template_language,
        templateParams: template_params,
        templateMessageParams: template_message_params,
        interactivePayload: interactive_payload,
        replyToMessageId: reply_to_message_id,
      })

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        )
      }
      throw err
    }
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    )
  }
}

type SendSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * Return the contact's conversation id (+ its line_id) in this
 * account, creating one if it doesn't exist yet. Mirrors the
 * webhook's find-or-create so an inbound-then-outbound (or
 * outbound-first) sequence converges on a single thread per contact.
 * Runs under the caller's RLS — the conversations_insert policy
 * requires account agent membership, which the caller already is.
 *
 * Fixed a pre-existing bug found while wiring up Instagram send
 * dispatch: this insert never set `line_id`, which has been a NOT-
 * NULL-violating 500 on every contact_id-initiated send since
 * conversations.line_id went NOT NULL (038_whatsapp_lines_finalize.sql)
 * — this code path predates that migration and was apparently never
 * exercised since. Now resolves the account's default line the same
 * way resolveConversationByPhone does (src/lib/whatsapp/resolve-
 * conversation.ts) and stamps it.
 */
async function findOrCreateConversation(
  supabase: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<{ id: string; lineId: string } | null> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id, line_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (existing) return { id: existing.id, lineId: existing.line_id }

  const { data: defaultLine } = await supabase
    .from('whatsapp_lines')
    .select('id')
    .eq('account_id', accountId)
    .eq('is_default', true)
    .maybeSingle()

  if (!defaultLine) {
    console.error('No default WhatsApp line for account:', accountId)
    return null
  }

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      line_id: defaultLine.id,
    })
    .select('id')
    .single()

  if (error) {
    console.error('Error creating conversation for contact send:', error.message)
    return null
  }

  return { id: created.id, lineId: defaultLine.id }
}
