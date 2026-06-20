/**
 * Orchestrates multi-source prospect enrichment: Apollo discovery → news fetch → DB store.
 * Processes 50+ leads/day with per-prospect <90s latency SLA.
 */

import { buildDb } from "@/lib/db";
import {
  searchApolloCompanies,
  buildIcpFilterFromEnv,
  type IcpFilter,
} from "./apollo-client";
import { fetchCompanyNews } from "./news-fetcher";

export interface SdrProspect {
  id: string;
  company_name: string;
  domain: string | null;
  industry: string | null;
  employee_count: number | null;
  annual_revenue: number | null;
  country: string | null;
  city: string | null;
  linkedin_url: string | null;
  website_url: string | null;
  enrichment_status: "pending" | "enriched" | "failed";
  context_payload: Record<string, unknown> | null;
  enrichment_error: string | null;
  created_at: string;
  updated_at: string;
  enriched_at: string | null;
}

export interface EnrichmentRun {
  discovered: number;
  enriched: number;
  failed: number;
  durationMs: number;
}

export async function ensureProspectsTable(): Promise<void> {
  const db = buildDb();
  await db.execute(
    `CREATE TABLE IF NOT EXISTS sdr_prospects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_name TEXT NOT NULL,
      domain TEXT,
      industry TEXT,
      employee_count INTEGER,
      annual_revenue BIGINT,
      country TEXT,
      city TEXT,
      linkedin_url TEXT,
      website_url TEXT,
      enrichment_status TEXT NOT NULL DEFAULT 'pending',
      context_payload JSONB,
      enrichment_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      enriched_at TIMESTAMPTZ
    )`,
  );
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS sdr_prospects_domain_idx
     ON sdr_prospects (domain) WHERE domain IS NOT NULL`,
  );
}

async function upsertProspectsFromApollo(
  filter: IcpFilter,
  maxLeads: number,
): Promise<number> {
  const db = buildDb();
  const result = await searchApolloCompanies(
    filter,
    1,
    Math.min(maxLeads, 100),
  );

  let inserted = 0;
  for (const org of result.organizations) {
    if (!org.name) continue;
    const rows = await db.query<{ id: string }>(
      `INSERT INTO sdr_prospects
         (company_name, domain, industry, employee_count, annual_revenue,
          country, city, linkedin_url, website_url, enrichment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       ON CONFLICT (domain) WHERE domain IS NOT NULL DO NOTHING
       RETURNING id`,
      org.name,
      org.primary_domain ?? null,
      org.industry ?? null,
      org.num_employees ?? null,
      org.annual_revenue ?? null,
      org.country ?? null,
      org.city ?? null,
      org.linkedin_url ?? null,
      org.website_url ?? null,
    );
    if (rows.length > 0) inserted++;
  }
  return inserted;
}

async function enrichPendingProspects(
  batchSize: number,
): Promise<{ enriched: number; failed: number }> {
  const db = buildDb();
  const pending = await db.query<SdrProspect>(
    `SELECT * FROM sdr_prospects
     WHERE enrichment_status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    batchSize,
  );

  let enriched = 0;
  let failed = 0;

  for (const prospect of pending) {
    try {
      const news = await fetchCompanyNews(prospect.company_name, 5);
      const contextPayload: Record<string, unknown> = {
        company_name: prospect.company_name,
        industry: prospect.industry,
        employee_count: prospect.employee_count,
        annual_revenue: prospect.annual_revenue,
        country: prospect.country,
        city: prospect.city,
        linkedin_url: prospect.linkedin_url,
        website_url: prospect.website_url,
        domain: prospect.domain,
        news,
        enriched_at: new Date().toISOString(),
      };
      await db.execute(
        `UPDATE sdr_prospects
         SET enrichment_status = 'enriched',
             context_payload = $1,
             enriched_at = NOW(),
             updated_at = NOW(),
             enrichment_error = NULL
         WHERE id = $2`,
        JSON.stringify(contextPayload),
        prospect.id,
      );
      enriched++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.execute(
        `UPDATE sdr_prospects
         SET enrichment_status = 'failed',
             enrichment_error = $1,
             updated_at = NOW()
         WHERE id = $2`,
        msg.slice(0, 500),
        prospect.id,
      );
      failed++;
    }
  }

  return { enriched, failed };
}

export async function runEnrichmentPipeline(
  maxLeads: number = 50,
): Promise<EnrichmentRun> {
  const start = Date.now();
  await ensureProspectsTable();

  const filter = buildIcpFilterFromEnv();

  let discovered = 0;
  try {
    discovered = await upsertProspectsFromApollo(filter, maxLeads);
  } catch (err) {
    console.error(
      "[enrich] Apollo discovery failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  const { enriched, failed } = await enrichPendingProspects(
    Math.min(maxLeads, 50),
  );

  return { discovered, enriched, failed, durationMs: Date.now() - start };
}

export async function listProspects(
  status?: string,
  limit: number = 50,
  offset: number = 0,
): Promise<SdrProspect[]> {
  const db = buildDb();
  if (status) {
    return db.query<SdrProspect>(
      `SELECT * FROM sdr_prospects
       WHERE enrichment_status = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      status,
      limit,
      offset,
    );
  }
  return db.query<SdrProspect>(
    `SELECT * FROM sdr_prospects ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    limit,
    offset,
  );
}

export async function getProspectById(
  id: string,
): Promise<SdrProspect | null> {
  const db = buildDb();
  const rows = await db.query<SdrProspect>(
    `SELECT * FROM sdr_prospects WHERE id = $1`,
    id,
  );
  return rows[0] ?? null;
}

export async function countProspects(status?: string): Promise<number> {
  const db = buildDb();
  if (status) {
    const rows = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM sdr_prospects WHERE enrichment_status = $1`,
      status,
    );
    return parseInt(rows[0]?.count ?? "0", 10);
  }
  const rows = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM sdr_prospects`,
  );
  return parseInt(rows[0]?.count ?? "0", 10);
}
