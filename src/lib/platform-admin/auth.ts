// ============================================================
// Auth guard for /api/platform-admin/* routes.
//
// Mirrors src/lib/auth/account.ts's requireRole() shape (throw a
// typed error, let the route map it via toErrorResponse), but the
// check is a flat boolean (profiles.is_platform_admin) rather than
// an account-role hierarchy — platform admin is orthogonal to
// whatever role the caller holds in their own ordinary account.
// ============================================================

import { createClient } from '@/lib/supabase/server'
import { UnauthorizedError, ForbiddenError } from '@/lib/auth/account'

export interface PlatformAdminContext {
  userId: string
  profileId: string
}

/**
 * Resolve the caller via the normal SSR (anon-key) client — not the
 * service-role client — so this only ever confirms "who is making
 * this request", never reads across accounts itself.
 *
 * Throws `UnauthorizedError` with no session, `ForbiddenError` when
 * the caller's profile has `is_platform_admin = false`.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient()

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) {
    throw new UnauthorizedError()
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('id, is_platform_admin')
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) {
    console.error('[requirePlatformAdmin] profile fetch error:', error)
    throw new ForbiddenError('Could not load platform admin context')
  }
  if (!data || !data.is_platform_admin) {
    throw new ForbiddenError('Platform admin access required')
  }

  return { userId: user.id, profileId: data.id }
}
