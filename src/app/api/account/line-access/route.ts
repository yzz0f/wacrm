// ============================================================
// GET/PUT /api/account/line-access
//
// Manages which WhatsApp lines an agent/viewer can see (line_access,
// migration 037). owner/admin never appear here — they bypass
// line-level restriction entirely (see can_access_line() in the
// RLS layer), so this route only concerns itself with agent/viewer
// profiles.
//
// Admin+ only, same tier as everything else that touches
// whatsapp_lines.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";
import type { LineAccess, WhatsAppLine } from "@/types";

/**
 * GET — every line on the account (id + name, for rendering checkbox
 * columns) plus every line_access row for the account's lines (for
 * rendering which boxes are checked).
 */
export async function GET() {
  try {
    const ctx = await requireRole("admin");

    const { data: lines, error: linesError } = await ctx.supabase
      .from("whatsapp_lines")
      .select("id, name, is_default")
      .eq("account_id", ctx.accountId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true });

    if (linesError) {
      console.error("[GET /api/account/line-access] lines error:", linesError);
      return NextResponse.json({ error: "Failed to load lines" }, { status: 500 });
    }

    const lineIds = (lines ?? []).map((l) => l.id as string);
    let access: Pick<LineAccess, "line_id" | "profile_id">[] = [];
    if (lineIds.length > 0) {
      const { data, error: accessError } = await ctx.supabase
        .from("line_access")
        .select("line_id, profile_id")
        .in("line_id", lineIds);
      if (accessError) {
        console.error("[GET /api/account/line-access] access error:", accessError);
        return NextResponse.json({ error: "Failed to load line access" }, { status: 500 });
      }
      access = data ?? [];
    }

    return NextResponse.json({
      lines: (lines ?? []) as Pick<WhatsAppLine, "id" | "name" | "is_default">[],
      access,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PUT — replace one profile's entire set of line_access rows.
 *
 * Body: { profile_id: string, line_ids: string[] }
 *
 * Whole-set replacement (delete then insert) rather than incremental
 * toggle endpoints — simplest to reason about, and the row count per
 * profile is small (bounded by the account's line count).
 */
export async function PUT(request: Request) {
  try {
    const ctx = await requireRole("admin");

    const body = await request.json().catch(() => null);
    const profileId = typeof body?.profile_id === "string" ? body.profile_id : null;
    const lineIds = Array.isArray(body?.line_ids)
      ? body.line_ids.filter((id: unknown): id is string => typeof id === "string")
      : null;

    if (!profileId || !lineIds) {
      return NextResponse.json(
        { error: "profile_id and line_ids are required" },
        { status: 400 },
      );
    }

    // The target profile must belong to this account and be an
    // agent/viewer — owners/admins don't participate in line_access.
    const { data: profile, error: profileError } = await ctx.supabase
      .from("profiles")
      .select("id, account_role")
      .eq("id", profileId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (profileError || !profile) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }
    if (!isAccountRole(profile.account_role) || !["agent", "viewer"].includes(profile.account_role)) {
      return NextResponse.json(
        { error: "Line access only applies to agent/viewer roles" },
        { status: 400 },
      );
    }

    // Every requested line_id must belong to this account — silently
    // dropping unknown ids (rather than 400ing) keeps this route
    // tolerant of a stale client list.
    const { data: accountLines, error: accountLinesError } = await ctx.supabase
      .from("whatsapp_lines")
      .select("id")
      .eq("account_id", ctx.accountId);
    if (accountLinesError) {
      console.error("[PUT /api/account/line-access] lines error:", accountLinesError);
      return NextResponse.json({ error: "Failed to validate lines" }, { status: 500 });
    }
    const validLineIds = new Set((accountLines ?? []).map((l) => l.id as string));
    const targetLineIds: string[] = lineIds.filter((id: string) => validLineIds.has(id));

    const { error: deleteError } = await ctx.supabase
      .from("line_access")
      .delete()
      .eq("profile_id", profileId);
    if (deleteError) {
      console.error("[PUT /api/account/line-access] delete error:", deleteError);
      return NextResponse.json({ error: "Failed to update line access" }, { status: 500 });
    }

    if (targetLineIds.length > 0) {
      const { error: insertError } = await ctx.supabase
        .from("line_access")
        .insert(targetLineIds.map((line_id: string) => ({ line_id, profile_id: profileId })));
      if (insertError) {
        console.error("[PUT /api/account/line-access] insert error:", insertError);
        return NextResponse.json({ error: "Failed to update line access" }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
