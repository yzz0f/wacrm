// ============================================================
// Instagram broadcast core — parallel to
// src/lib/whatsapp/broadcast-core.ts, but the simpler server-side
// pattern only (see the plan's Fase 0 for why: WhatsApp's dashboard
// wizard uses a client-orchestrated flow to support per-recipient
// template variables at scale; Instagram broadcasts in this phase
// are free-text with no per-recipient personalization, so there's
// nothing that flow's complexity buys here).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { sendInstagramText, isOutsideMessagingWindowError } from './meta-instagram-api'
import { decrypt } from '@/lib/whatsapp/encryption'

export class InstagramBroadcastError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'InstagramBroadcastError'
    this.code = code
    this.status = status
  }
}

export interface CreateInstagramBroadcastParams {
  name?: string | null
  messageText: string
  instagramAccountId: string
  contactIds: string[]
}

interface PlannedRecipient {
  recipientRowId: string
  contactId: string
  externalId: string
}

export interface InstagramBroadcastPlan {
  broadcastId: string
  messageText: string
  pageAccessToken: string
  planned: PlannedRecipient[]
}

const MAX_RECIPIENTS = 1000

/**
 * Validate + persist an Instagram broadcast. Throws
 * {@link InstagramBroadcastError} on bad input / missing account /
 * a DB failure — nothing is sent in this phase.
 */
export async function createInstagramBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateInstagramBroadcastParams,
): Promise<InstagramBroadcastPlan> {
  const { name, messageText, instagramAccountId, contactIds } = params

  if (!messageText || !messageText.trim()) {
    throw new InstagramBroadcastError('bad_request', 'message_text is required', 400)
  }
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    throw new InstagramBroadcastError('bad_request', 'contact_ids must be a non-empty array', 400)
  }
  if (contactIds.length > MAX_RECIPIENTS) {
    throw new InstagramBroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request`,
      400,
    )
  }

  const { data: igAccount, error: igAccountError } = await db
    .from('instagram_accounts')
    .select('id, access_token')
    .eq('id', instagramAccountId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (igAccountError || !igAccount) {
    throw new InstagramBroadcastError('instagram_not_configured', 'Instagram account not found', 400)
  }
  const pageAccessToken = decrypt(igAccount.access_token)

  // Only contacts that actually belong to this account and carry an
  // Instagram external_id are sendable — defends against a caller
  // passing a WhatsApp contact id.
  const { data: contacts, error: contactsError } = await db
    .from('contacts')
    .select('id, external_id')
    .eq('account_id', accountId)
    .eq('platform', 'instagram')
    .in('id', contactIds)
  if (contactsError) {
    console.error('[broadcast-instagram-core] contacts fetch error:', contactsError)
    throw new InstagramBroadcastError('internal', 'Failed to resolve recipients', 500)
  }
  const sendable = (contacts ?? []).filter((c) => c.external_id)
  if (sendable.length === 0) {
    throw new InstagramBroadcastError('bad_request', 'No valid Instagram recipients', 400)
  }

  const { data: broadcast, error: bErr } = await db
    .from('broadcasts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      instagram_account_id: instagramAccountId,
      name: name || 'Instagram broadcast',
      message_text: messageText,
      status: 'sending',
      total_recipients: sendable.length,
    })
    .select('id')
    .single()
  if (bErr || !broadcast) {
    console.error('[broadcast-instagram-core] create broadcast error:', bErr)
    throw new InstagramBroadcastError('internal', 'Failed to create broadcast', 500)
  }

  const { data: recipientRows, error: rErr } = await db
    .from('broadcast_recipients')
    .insert(sendable.map((c) => ({ broadcast_id: broadcast.id, contact_id: c.id, status: 'pending' as const })))
    .select('id, contact_id')
  if (rErr || !recipientRows) {
    console.error('[broadcast-instagram-core] create recipients error:', rErr)
    throw new InstagramBroadcastError('internal', 'Failed to create broadcast', 500)
  }

  const byContact = new Map(sendable.map((c) => [c.id, c.external_id as string]))
  const planned: PlannedRecipient[] = recipientRows.map((row) => ({
    recipientRowId: row.id as string,
    contactId: row.contact_id as string,
    externalId: byContact.get(row.contact_id as string)!,
  }))

  return { broadcastId: broadcast.id, messageText, pageAccessToken, planned }
}

/**
 * Fan out an {@link InstagramBroadcastPlan}. Best-effort per
 * recipient — one failure never aborts the rest. No phone-variant
 * retry (an IGSID has no format variants, unlike a phone number).
 *
 * Per-status count columns on `broadcasts` are trigger-owned (same
 * as WhatsApp's broadcast-core.ts) — only the terminal `status` is
 * written here.
 */
export async function deliverInstagramBroadcast(
  db: SupabaseClient,
  plan: InstagramBroadcastPlan,
): Promise<void> {
  let sentCount = 0

  for (const recipient of plan.planned) {
    try {
      await sendInstagramText({
        pageAccessToken: plan.pageAccessToken,
        recipientId: recipient.externalId,
        text: plan.messageText,
      })
      sentCount++
      await db
        .from('broadcast_recipients')
        .update({ status: 'sent', sent_at: new Date().toISOString(), error_message: null })
        .eq('id', recipient.recipientRowId)
    } catch (error) {
      const message = isOutsideMessagingWindowError(error)
        ? 'Outside the 24-hour messaging window'
        : error instanceof Error
          ? error.message
          : 'Unknown error'
      await db
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: message })
        .eq('id', recipient.recipientRowId)
    }
  }

  await db
    .from('broadcasts')
    .update({ status: sentCount > 0 ? 'sent' : 'failed', updated_at: new Date().toISOString() })
    .eq('id', plan.broadcastId)
}
