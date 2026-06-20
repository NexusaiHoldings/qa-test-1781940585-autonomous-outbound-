/**
 * SDR pipeline metrics — server-side queries across sdr_campaigns,
 * sdr_prospects, sdr_emails, and sdr_meetings for a given org.
 *
 * Uses buildDb() so pg is handled by the substrate's singleton Pool
 * (already externalized in next.config.js serverComponentsExternalPackages).
 */

import { buildDb } from "@/lib/db";

export interface CampaignMetrics {
  id: string;
  name: string;
  status: string;
  prospectsEnriched: number;
  emailsSent: number;
  openRate: number;
  replyRate: number;
  meetingsBooked: number;
  createdAt: Date;
}

export interface PipelineSummary {
  totalCampaigns: number;
  activeCampaigns: number;
  totalProspectsEnriched: number;
  totalEmailsSent: number;
  overallOpenRate: number;
  overallReplyRate: number;
  totalMeetingsBooked: number;
}

/** Resolve the primary org ID for a user via the substrate org tables. */
export async function getOrgIdForUser(userId: string): Promise<string> {
  const db = buildDb();
  try {
    const rows = await db.query<{ id: string }>(
      `SELECT o.id
       FROM organizations o
       JOIN org_members om ON om.org_id = o.id
       WHERE om.user_id = $1
       ORDER BY o.created_at ASC
       LIMIT 1`,
      userId,
    );
    return rows[0]?.id ?? userId;
  } catch {
    return userId;
  }
}

/**
 * Fetch per-campaign metrics for all campaigns in the given org.
 *
 * Aggregates prospects (enriched count), emails (sent/opened/replied),
 * and meetings in a single JOIN query to keep latency low.
 */
export async function getCampaignMetrics(orgId: string): Promise<CampaignMetrics[]> {
  const db = buildDb();
  try {
    const rows = await db.query<{
      id: string;
      name: string;
      status: string;
      created_at: Date;
      prospects_enriched: string;
      emails_sent: string;
      open_rate: string;
      reply_rate: string;
      meetings_booked: string;
    }>(
      `SELECT
        c.id,
        c.name,
        c.status,
        c.created_at,
        COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'enriched')
          AS prospects_enriched,
        COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('sent','opened','replied'))
          AS emails_sent,
        CASE
          WHEN COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('sent','opened','replied')) = 0
            THEN 0
          ELSE ROUND(
            COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('opened','replied'))::numeric /
            NULLIF(
              COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('sent','opened','replied')),
              0
            )::numeric * 100,
            1
          )
        END AS open_rate,
        CASE
          WHEN COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('sent','opened','replied')) = 0
            THEN 0
          ELSE ROUND(
            COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'replied')::numeric /
            NULLIF(
              COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('sent','opened','replied')),
              0
            )::numeric * 100,
            1
          )
        END AS reply_rate,
        COUNT(DISTINCT m.id) AS meetings_booked
      FROM sdr_campaigns c
      LEFT JOIN sdr_prospects p ON p.campaign_id = c.id
      LEFT JOIN sdr_emails   e ON e.campaign_id = c.id
      LEFT JOIN sdr_meetings m ON m.campaign_id = c.id
      WHERE c.org_id = $1
      GROUP BY c.id, c.name, c.status, c.created_at
      ORDER BY c.created_at DESC`,
      orgId,
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      prospectsEnriched: Number(row.prospects_enriched),
      emailsSent: Number(row.emails_sent),
      openRate: Number(row.open_rate),
      replyRate: Number(row.reply_rate),
      meetingsBooked: Number(row.meetings_booked),
      createdAt: new Date(row.created_at),
    }));
  } catch {
    return [];
  }
}

/** Compute aggregate pipeline summary from per-campaign metrics. */
export async function getPipelineSummary(orgId: string): Promise<PipelineSummary> {
  const campaigns = await getCampaignMetrics(orgId);

  const totalEmailsSent = campaigns.reduce((acc, c) => acc + c.emailsSent, 0);
  const totalOpened = campaigns.reduce(
    (acc, c) => acc + Math.round((c.openRate / 100) * c.emailsSent),
    0,
  );
  const totalReplied = campaigns.reduce(
    (acc, c) => acc + Math.round((c.replyRate / 100) * c.emailsSent),
    0,
  );

  return {
    totalCampaigns: campaigns.length,
    activeCampaigns: campaigns.filter((c) => c.status === "active").length,
    totalProspectsEnriched: campaigns.reduce((acc, c) => acc + c.prospectsEnriched, 0),
    totalEmailsSent,
    overallOpenRate:
      totalEmailsSent > 0
        ? Math.round((totalOpened / totalEmailsSent) * 1000) / 10
        : 0,
    overallReplyRate:
      totalEmailsSent > 0
        ? Math.round((totalReplied / totalEmailsSent) * 1000) / 10
        : 0,
    totalMeetingsBooked: campaigns.reduce((acc, c) => acc + c.meetingsBooked, 0),
  };
}
