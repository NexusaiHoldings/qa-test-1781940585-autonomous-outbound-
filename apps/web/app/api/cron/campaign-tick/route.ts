/**
 * GET /api/cron/campaign-tick
 *
 * Vercel cron job (runs on a schedule defined in vercel.json).
 * Processes all SDR sequence touches that are past their scheduled_at
 * and enforces the 2-3 touch per prospect maximum.
 *
 * For each due touch:
 *   - Re-checks touch limits and suppression status
 *   - Marks the touch as sent (ESP integration point)
 *   - Skips touches that exceed the campaign's max_touches ceiling
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getPool,
  ensureSchema,
  getPendingTouches,
  canSendNextTouch,
  markTouchSent,
  markTouchSkipped,
} from "@/lib/sdr/sequence-engine";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Vercel cron authenticates via the Authorization header when CRON_SECRET is set.
  // Also accept a bare secret in x-cron-secret for local testing.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization") ?? "";
    const bareSecret = request.headers.get("x-cron-secret") ?? "";
    if (auth !== `Bearer ${cronSecret}` && bareSecret !== cronSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const pool = getPool();

  try {
    await ensureSchema(pool);
  } catch (err) {
    console.error("[campaign-tick] schema setup failed", err);
    return NextResponse.json(
      { error: "Database initialisation failed" },
      { status: 500 }
    );
  }

  const pending = await getPendingTouches(pool);

  const results = {
    total: pending.length,
    sent: 0,
    skipped: 0,
    errors: 0,
  };

  for (const touch of pending) {
    try {
      const eligible = await canSendNextTouch(
        touch.prospect_id,
        touch.campaign_id,
        pool
      );

      if (!eligible) {
        await markTouchSkipped(touch.id, pool);
        results.skipped++;
        continue;
      }

      // Mark as sent. The actual outbound email is dispatched here — an
      // outbound cold-email ESP integration (Resend/SendGrid with a dedicated
      // sending domain) would be called before markTouchSent in production.
      // That ESP integration requires a separate chairman approval (see task
      // brief), so we record the intent and let the sequence state advance.
      await markTouchSent(touch.id, pool);
      results.sent++;
    } catch (err) {
      console.error(
        `[campaign-tick] failed to process touch ${touch.id}`,
        err
      );
      results.errors++;
    }
  }

  return NextResponse.json({ ok: true, ...results, processed_at: new Date().toISOString() });
}
