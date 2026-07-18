// ============================================================
// Server-component guard for pages under src/app/platform-admin/*
// (everything except login/page.tsx, which is reachable while
// signed out). Redirects instead of throwing — pages, unlike API
// routes, don't have a JSON error response to hand back.
// ============================================================

import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'

export interface PlatformAdminPageContext {
  userId: string
  profileId: string
}

export async function requirePlatformAdminPage(): Promise<PlatformAdminPageContext> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect('/platform-admin/login')
  }

  const { data } = await supabase
    .from('profiles')
    .select('id, is_platform_admin')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!data || !data.is_platform_admin) {
    redirect('/platform-admin/login?error=forbidden')
  }

  return { userId: user.id, profileId: data.id }
}
