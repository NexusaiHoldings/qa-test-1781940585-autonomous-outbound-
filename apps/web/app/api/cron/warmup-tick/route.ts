/**
 * GET /api/cron/warmup-tick — advances warmup day for all verified sending domains
 * that have an active warmup in progress.
 *
 * Scheduled daily via vercel.json crons. Auth: CRON_SECRET bearer token when set.
 * Each run increments warmup_day by 1 (up to WARMUP_DAYS = 14) for every
 * domain that has warmup active, per industry email warm-up best practice.
 */

import { NextResponse } from "next/server";
import { getActiveWarmupDomains, advanceWarmupDay } from "@/lib/sdr/warmup-scheduler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!cronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  let activeDomains;
  try {
    activeDomains = await getActiveWarmupDomains();
  } catch (err) {
    return NextResponse.json(
      { error: String((err as Error).message) },
      { status: 500 }
    );
  }

  const results: Array<{
    domain_id: string;
    domain: string;
    previous_day: number;
    new_day: number;
    daily_limit: number;
    completed: boolean;
    outcome: string;
  }> = [];

  for (const active of activeDomains) {
    try {
      const updated = await advanceWarmupDay(active.domain_id);
      results.push({
        domain_id: active.domain_id,
        domain: active.domain,
        previous_day: active.warmup_day,
        new_day: updated.warmup_day,
        daily_limit: updated.daily_limit,
        completed: updated.completed,
        outcome: "advanced",
      });
    } catch (err) {
      results.push({
        domain_id: active.domain_id,
        domain: active.domain,
        previous_day: active.warmup_day,
        new_day: active.warmup_day,
        daily_limit: active.daily_limit,
        completed: false,
        outcome: `error: ${String((err as Error).message).slice(0, 200)}`,
      });
    }
  }

  return NextResponse.json({
    processed: results.length,
    results,
    timestamp: new Date().toISOString(),
  });
}
