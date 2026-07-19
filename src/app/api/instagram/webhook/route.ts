import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { findExistingInstagramContact } from '@/lib/contacts/dedupe-instagram'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// ============================================================
// Instagram DM webhook — Fase 3 of the Instagram foundation
// (docs/superpowers/plans/2026-07-19-instagram-foundation-plan.md).
//
// Deliberately mirrors src/app/api/whatsapp/webhook/route.ts's shape
// (GET challenge, POST + HMAC verify + after(), find-or-create
// contact/conversation, race handling on unique-violation) but does
// NOT call into Flows, automations, or AI auto-reply — those are
// out of scope for this sub-project (2-4 handle them). It also skips
// status-update handling, reactions, and broadcast-reply flagging,
// none of which exist for Instagram yet.
//
// Payload shape: Instagram Messaging webhooks use the Messenger-
// Platform-style `entry[].messaging[]` format (object: "instagram"),
// NOT WhatsApp's `entry[].changes[].value` shape. Verified against
// Meta's public Instagram Messaging API docs at implementation time
// per the plan's guard — re-confirm before relying on this in
// production, same discipline used for the MercadoPago integration.
// ============================================================

export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface InstagramAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | string
  payload: { url?: string }
}

interface InstagramMessage {
  mid: string
  text?: string
  attachments?: InstagramAttachment[]
}

interface InstagramMessagingEvent {
  sender: { id: string }
  recipient: { id: string }
  timestamp: number
  message?: InstagramMessage
}

interface InstagramWebhookEntry {
  id: string
  time: number
  messaging?: InstagramMessagingEvent[]
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
    }

    const { data: accounts, error: fetchError } = await supabaseAdmin()
      .from('instagram_accounts')
      .select('id, verify_token')

    if (fetchError || !accounts) {
      console.error('[instagram/webhook] error fetching accounts for verification:', fetchError)
      return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matched: any = null
    for (const account of accounts) {
      if (!account.verify_token) continue
      try {
        if (decrypt(account.verify_token) === verifyToken) {
          matched = account
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matched) {
      if (isLegacyFormat(matched.verify_token)) {
        void supabaseAdmin()
          .from('instagram_accounts')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matched.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[instagram/webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  } catch (error) {
    console.error('[instagram/webhook] GET verification error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[instagram/webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: InstagramWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Same after()-not-floating-promise reasoning as the WhatsApp
  // webhook (issue #301) — the function can be frozen the instant
  // the response is sent on a serverless platform.
  after(async () => {
    try {
      await processInstagramWebhook(body)
    } catch (error) {
      console.error('[instagram/webhook] processing error:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processInstagramWebhook(body: { entry?: InstagramWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    if (!entry.messaging) continue

    for (const event of entry.messaging) {
      if (!event.message) continue // delivery receipts, read receipts, etc. — not handled yet

      const igBusinessAccountId = event.recipient.id

      const { data: accountRows, error: accountError } = await supabaseAdmin()
        .from('instagram_accounts')
        .select('*')
        .eq('instagram_business_account_id', igBusinessAccountId)

      if (accountError) {
        console.error('[instagram/webhook] error fetching instagram_accounts:', accountError)
        continue
      }
      if (!accountRows || accountRows.length === 0) {
        console.error('[instagram/webhook] no account found for ig business id:', igBusinessAccountId)
        continue
      }
      if (accountRows.length > 1) {
        console.error(
          `[instagram/webhook] multiple accounts (${accountRows.length}) found for ig business id:`,
          igBusinessAccountId,
          '— message dropped.',
        )
        continue
      }

      const account = accountRows[0]

      await processInstagramMessage(
        event,
        account.account_id,
        account.user_id,
        account.id,
      )
    }
  }
}

interface InstagramContactRow {
  id: string
  external_id: string
  name?: string | null
  [key: string]: unknown
}

interface InstagramContactOutcome {
  contact: InstagramContactRow
  wasCreated: boolean
}

async function findOrCreateInstagramContact(
  accountId: string,
  accountOwnerUserId: string,
  igsid: string,
  name: string,
): Promise<InstagramContactOutcome | null> {
  const existing = await findExistingInstagramContact(supabaseAdmin(), accountId, igsid)

  if (existing) {
    if (name && name !== existing.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return { contact: existing, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: accountOwnerUserId,
      platform: 'instagram',
      external_id: igsid,
      phone: null,
      name: name || igsid,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingInstagramContact(supabaseAdmin(), accountId, igsid)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[instagram/webhook] error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateInstagramConversation(
  accountId: string,
  accountOwnerUserId: string,
  contactId: string,
  instagramAccountId: string,
) {
  // Same oldest-first, no-.single() lookup as findOrCreateConversation
  // in the WhatsApp webhook (issue #363) — avoids the duplicate-
  // snowball bug that motivated that pattern there.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('instagram_account_id', instagramAccountId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[instagram/webhook] error finding conversation:', findError)
    return null
  }
  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: accountOwnerUserId,
      contact_id: contactId,
      instagram_account_id: instagramAccountId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('instagram_account_id', instagramAccountId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('[instagram/webhook] error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

/**
 * Content types allowed by the messages.content_type CHECK constraint
 * that this phase's Instagram messages can actually produce — a
 * strict subset of the full WhatsApp list (no location/template/
 * interactive from Instagram in this sub-project).
 */
function mapInstagramContentType(message: InstagramMessage): 'text' | 'image' | 'video' | 'audio' {
  const attachment = message.attachments?.[0]
  if (!attachment) return 'text'
  if (attachment.type === 'image') return 'image'
  if (attachment.type === 'video') return 'video'
  if (attachment.type === 'audio') return 'audio'
  return 'text' // unsupported attachment type (e.g. story reply, file) — fall back
}

async function processInstagramMessage(
  event: InstagramMessagingEvent,
  accountId: string,
  accountOwnerUserId: string,
  instagramAccountId: string,
) {
  const message = event.message
  if (!message) return

  const igsid = event.sender.id
  // Instagram's webhook payload carries no display name for the
  // sender — unlike WhatsApp's `contacts[].profile.name`. Falls back
  // to the IGSID itself; a real name/username lookup (Instagram's
  // /{igsid} Graph API endpoint) is left for a later phase.
  const contactName = igsid

  const contactOutcome = await findOrCreateInstagramContact(accountId, accountOwnerUserId, igsid, contactName)
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateInstagramConversation(
    accountId,
    accountOwnerUserId,
    contactRecord.id,
    instagramAccountId,
  )
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  const contentType = mapInstagramContentType(message)
  const contentText = message.text ?? null
  const mediaUrl = message.attachments?.[0]?.payload?.url ?? null

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.mid,
    status: 'delivered',
    created_at: new Date(event.timestamp).toISOString(),
  })

  if (msgError) {
    console.error('[instagram/webhook] error inserting message:', msgError)
    return
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('[instagram/webhook] error updating conversation:', convError)
  }

  // Deliberately no flagBroadcastReplyIfAny / dispatchInboundToFlows /
  // automations / dispatchInboundToAiReply here — all out of scope
  // for this sub-project (see the file header comment).
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    instagram_message_id: message.mid,
    content_type: contentType,
    text: contentText,
  })
}
