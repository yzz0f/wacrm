import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  sendInstagramText,
  sendInstagramMedia,
  isOutsideMessagingWindowError,
  MetaInstagramApiError,
} from './meta-instagram-api'

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return { ok: false, status, json: async () => json } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('sendInstagramText', () => {
  it('posts to /me/messages with the recipient + text body and returns the message id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ recipient_id: 'igsid-1', message_id: 'mid.123' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendInstagramText({
      pageAccessToken: 'page-token',
      recipientId: 'igsid-1',
      text: 'Hi there',
    })

    expect(result).toEqual({ messageId: 'mid.123' })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/me/messages')
    expect(opts.headers.Authorization).toBe('Bearer page-token')
    const body = JSON.parse(opts.body)
    expect(body).toEqual({ recipient: { id: 'igsid-1' }, message: { text: 'Hi there' } })
  })

  it('throws MetaInstagramApiError with code/error_subcode on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(400, { error: { message: 'window closed', code: 10, error_subcode: 2534022 } }),
      ),
    )

    await expect(
      sendInstagramText({ pageAccessToken: 'x', recipientId: 'igsid-1', text: 'hi' }),
    ).rejects.toMatchObject({ code: 10, errorSubcode: 2534022 })
  })
})

describe('sendInstagramMedia', () => {
  it('posts an attachment payload with the media kind + url', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ recipient_id: 'igsid-1', message_id: 'mid.456' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendInstagramMedia({
      pageAccessToken: 'page-token',
      recipientId: 'igsid-1',
      mediaKind: 'image',
      mediaUrl: 'https://example.com/photo.jpg',
    })

    expect(result).toEqual({ messageId: 'mid.456' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.message.attachment).toEqual({
      type: 'image',
      payload: { url: 'https://example.com/photo.jpg' },
    })
  })
})

describe('isOutsideMessagingWindowError', () => {
  it('identifies the 24-hour-window rejection shape', () => {
    const err = new MetaInstagramApiError('window closed', 10, 2534022)
    expect(isOutsideMessagingWindowError(err)).toBe(true)
  })

  it('returns false for a different error code', () => {
    const err = new MetaInstagramApiError('invalid token', 190, 460)
    expect(isOutsideMessagingWindowError(err)).toBe(false)
  })

  it('returns false for a non-MetaInstagramApiError', () => {
    expect(isOutsideMessagingWindowError(new Error('generic'))).toBe(false)
  })
})
