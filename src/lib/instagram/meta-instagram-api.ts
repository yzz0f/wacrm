/**
 * Meta Instagram Messaging API helpers — parallel to
 * src/lib/whatsapp/meta-api.ts, not built on top of it (no shared
 * send abstraction exists in this codebase to implement against —
 * confirmed during the Fase 0 discovery of the implementation plan).
 *
 * Uses the Page-linked flow (`POST /me/messages` with the connected
 * Facebook Page's access token), matching the manual-entry connection
 * model chosen for Instagram (instagram_accounts.page_id +
 * .access_token) — the same shape WhatsApp's manual token entry uses.
 * Named-parameter functions, same reasoning as meta-api.ts's own
 * comment: positional args have caused real swapped-argument bugs
 * here before.
 *
 * Verified against Meta's public Instagram Messaging API docs at
 * implementation time (Messenger Platform's Instagram send-message
 * docs, which the Page-linked flow shares). Two things are NOT
 * officially documented and are flagged for empirical confirmation
 * before this ships (see Fase 8 of the plan):
 *   1. The exact error code/subcode Meta returns when a send falls
 *      outside the 24-hour messaging window (community-sourced only:
 *      code 10, error_subcode 2534022 — not on an official docs page).
 *   2. Whether the Page-linked `/me/messages` endpoint is still the
 *      recommended integration path vs. the newer Instagram-Login
 *      flow (`graph.instagram.com/<IG_ID>/messages` with an IG user
 *      token) — the manual-entry UI in this sub-project assumes
 *      Page-linked, matching WhatsApp Cloud API's own manual-token
 *      pattern, but Meta may steer new integrations elsewhere.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export interface MetaInstagramSendResult {
  messageId: string
}

interface MetaErrorResponse {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string }
}

/** True for the (community-sourced, not officially documented — see
 *  file header) 24-hour-window rejection shape. */
export function isOutsideMessagingWindowError(err: unknown): boolean {
  if (!(err instanceof MetaInstagramApiError)) return false
  return err.code === 10 && err.errorSubcode === 2534022
}

export class MetaInstagramApiError extends Error {
  readonly code?: number
  readonly errorSubcode?: number
  constructor(message: string, code?: number, errorSubcode?: number) {
    super(message)
    this.name = 'MetaInstagramApiError'
    this.code = code
    this.errorSubcode = errorSubcode
  }
}

async function throwMetaInstagramError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  let code: number | undefined
  let errorSubcode: number | undefined
  try {
    const data = (await response.json()) as MetaErrorResponse
    if (data.error?.message) message = data.error.message
    code = data.error?.code
    errorSubcode = data.error?.error_subcode
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new MetaInstagramApiError(message, code, errorSubcode)
}

export interface SendInstagramTextArgs {
  pageAccessToken: string
  recipientId: string
  text: string
}

export async function sendInstagramText(args: SendInstagramTextArgs): Promise<MetaInstagramSendResult> {
  const { pageAccessToken, recipientId, text } = args
  const url = `${META_API_BASE}/me/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pageAccessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  })
  if (!response.ok) {
    await throwMetaInstagramError(response, `Meta Instagram API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.message_id }
}

export type InstagramMediaKind = 'image' | 'video' | 'audio' | 'file'

export interface SendInstagramMediaArgs {
  pageAccessToken: string
  recipientId: string
  mediaKind: InstagramMediaKind
  mediaUrl: string
}

export async function sendInstagramMedia(args: SendInstagramMediaArgs): Promise<MetaInstagramSendResult> {
  const { pageAccessToken, recipientId, mediaKind, mediaUrl } = args
  const url = `${META_API_BASE}/me/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pageAccessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: mediaKind,
          payload: { url: mediaUrl },
        },
      },
    }),
  })
  if (!response.ok) {
    await throwMetaInstagramError(response, `Meta Instagram API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.message_id }
}
