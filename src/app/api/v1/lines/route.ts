// ============================================================
// GET /api/v1/lines — list the account's WhatsApp lines.
//
// Scope-free, same tier as GET /api/v1/me — knowing which lines
// exist (name, phone number, default flag) isn't more sensitive than
// what messages:send/conversations:read keys already imply access
// to, and callers need this to discover valid `line_id` values
// before passing one to POST /api/v1/messages or the `line_id`
// filter on GET /api/v1/conversations. Never returns access_token or
// verify_token — those stay internal.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request);

    const { data, error } = await ctx.supabase
      .from('whatsapp_lines')
      .select('id, name, phone_number_id, status, is_default, registered_at')
      .eq('account_id', ctx.accountId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[api/v1/lines] list error:', error);
      return fail('internal', 'Failed to list lines', 500);
    }

    return ok({ lines: data ?? [] });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
