/**
 * GET /api/cron/enrich-prospects — cron-driven multi-source prospect enrichment.
 *
 * Pulls ICP-matched companies from Apollo, enriches each with news signals,
 * and stores the result in sdr_prospects.context_payload. Runs on a Vercel
 * cron schedule (vercel.json). Auth: Bearer CRON_SECRET when set, unguarded
 * in dev. maxDuration 90s per CEO latency SLA.
 */

import { NextResponse } from "next/server";
import { runEnrichmentPipeline } from "@/lib/sdr/enrichment-provider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 90;

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

  console.log("[cron] enrich-prospects: starting pipeline");

  try {
    const result = await runEnrichmentPipeline(50);

    console.log(
      `[cron] enrich-prospects: done discovered=${result.discovered} enriched=${result.enriched} failed=${result.failed} ms=${result.durationMs}`,
    );

    return NextResponse.json({
      ok: true,
      discovered: result.discovered,
      enriched: result.enriched,
      failed: result.failed,
      durationMs: result.durationMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron] enrich-prospects: fatal error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
