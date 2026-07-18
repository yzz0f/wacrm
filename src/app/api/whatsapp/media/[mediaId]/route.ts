import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

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

    // Resolve the caller's account_id — a teammate fetching media for
    // a conversation in the shared inbox needs the account's line,
    // not their personal (non-existent) row.
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

    // Resolve which line this media belongs to via the message that
    // references it (media_url is stamped as this exact proxy path
    // when the webhook first parses an inbound media message — see
    // src/app/api/whatsapp/webhook/route.ts), then its conversation's
    // line_id. Scoping the conversation lookup to accountId means a
    // teammate can't fetch another account's media by guessing a
    // mediaId.
    const { data: message } = await supabase
      .from('messages')
      .select('conversation_id')
      .eq('media_url', `/api/whatsapp/media/${mediaId}`)
      .maybeSingle()
    let messageLineId: string | undefined
    if (message?.conversation_id) {
      const { data: conversation } = await supabase
        .from('conversations')
        .select('line_id')
        .eq('id', message.conversation_id)
        .eq('account_id', accountId)
        .maybeSingle()
      messageLineId = conversation?.line_id ?? undefined
    }

    // Fetch and decrypt the line's credentials. Falls back to the
    // account's default line when the message lookup above didn't
    // resolve one (e.g. media requested before its message row landed).
    const lineQuery = messageLineId
      ? supabase.from('whatsapp_lines').select('*').eq('id', messageLineId)
      : supabase
          .from('whatsapp_lines')
          .select('*')
          .eq('account_id', accountId)
          .eq('is_default', true)
    const { data: config, error: configError } = await lineQuery.single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
