/**
 * POST /api/webhooks/calendly — receives Calendly booking confirmations.
 *
 * Verifies the HMAC-SHA256 signature supplied by Calendly in the
 * `Calendly-Webhook-Signature` header, then records new bookings in
 * sdr_booked_meetings via the SDR calendar connector.
 *
 * Required env vars:
 *   CALENDLY_WEBHOOK_SIGNING_KEY — signing secret from Calendly webhook subscription
 *   DATABASE_URL                 — Postgres connection string
 *   CALENDAR_TOKEN_ENCRYPTION_KEY — AES-256 key for token decryption
 *
 * Org resolution order:
 *   1. CALENDLY_DEFAULT_ORG_ID env var (single-tenant shortcut)
 *   2. First org with a Calendly API key configured in sdr_calendar_settings
 */

import { NextResponse } from "next/server";
import { buildDb } from "@/lib/db";
import {
  verifyCalendlySignature,
  processCalendlyWebhook,
} from "@/lib/sdr/calendar-connector";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const webhookKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  if (!webhookKey) {
    console.error("[calendly-webhook] CALENDLY_WEBHOOK_SIGNING_KEY not set");
    return NextResponse.json(
      { error: "webhook not configured" },
      { status: 500 },
    );
  }

  // Read raw body for signature verification — must happen before .json()
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "failed to read request body" }, { status: 400 });
  }

  const sigHeader =
    request.headers.get("Calendly-Webhook-Signature") ?? "";

  if (!verifyCalendlySignature(rawBody, sigHeader, webhookKey)) {
    console.warn("[calendly-webhook] invalid signature");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // ── Resolve which org this booking belongs to ──────────────────────────────
  const orgId = await resolveOrgId();
  if (!orgId) {
    console.warn("[calendly-webhook] no org found with Calendly configured");
    // Return 200 so Calendly doesn't retry; we just have nothing to record.
    return NextResponse.json({ ok: true, skipped: "no_org" });
  }

  // ── Process the event ──────────────────────────────────────────────────────
  try {
    await processCalendlyWebhook(orgId, payload);
  } catch (err) {
    console.error("[calendly-webhook] processCalendlyWebhook error:", err);
    return NextResponse.json(
      { error: "internal processing error" },
      { status: 500 },
    );
  }

  const eventType = payload.event ?? "unknown";
  console.log(`[calendly-webhook] processed event=${eventType} org=${orgId}`);
  return NextResponse.json({ ok: true });
}

/**
 * Resolve the org ID to attribute this webhook to.
 *
 * In a single-tenant deployment CALENDLY_DEFAULT_ORG_ID is the fastest path.
 * Otherwise we look up the first org that has a Calendly API key configured.
 */
async function resolveOrgId(): Promise<string | null> {
  const envOrgId = process.env.CALENDLY_DEFAULT_ORG_ID?.trim();
  if (envOrgId) return envOrgId;

  try {
    const db = buildDb();
    const rows = await db.query<{ org_id: string }>(
      "SELECT org_id FROM sdr_calendar_settings WHERE calendly_api_key_enc IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    );
    return rows[0]?.org_id ?? null;
  } catch (err) {
    console.error("[calendly-webhook] failed to resolve org:", err);
    return null;
  }
}
