import { promises as dnsPromises } from "dns";
import { buildDb } from "@/lib/db";

export interface SendingDomain {
  id: string;
  org_id: string;
  domain: string;
  dkim_selector: string;
  spf_verified: boolean;
  dkim_verified: boolean;
  dmarc_verified: boolean;
  domain_verified: boolean;
  warmup_day: number;
  warmup_started_at: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DnsRecord {
  verified: boolean;
  record: string | null;
  expected_host: string;
  error?: string;
}

export interface DomainVerificationResult {
  spf: DnsRecord;
  dkim: DnsRecord;
  dmarc: DnsRecord;
  domain_verified: boolean;
}

export interface DeliverabilityMetrics {
  emails_sent: number;
  bounces: number;
  spam_complaints: number;
  inbox_placement_score: number;
  bounce_rate: number;
  spam_rate: number;
  date_range_days: number;
}

async function ensureTables(): Promise<void> {
  const db = buildDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sdr_sending_domains (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      dkim_selector TEXT NOT NULL DEFAULT 'default',
      spf_verified BOOLEAN NOT NULL DEFAULT false,
      dkim_verified BOOLEAN NOT NULL DEFAULT false,
      dmarc_verified BOOLEAN NOT NULL DEFAULT false,
      domain_verified BOOLEAN NOT NULL DEFAULT false,
      warmup_day INTEGER NOT NULL DEFAULT 0,
      warmup_started_at TIMESTAMPTZ,
      last_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(org_id, domain)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sdr_deliverability_metrics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      domain_id UUID NOT NULL REFERENCES sdr_sending_domains(id) ON DELETE CASCADE,
      metric_date DATE NOT NULL DEFAULT CURRENT_DATE,
      emails_sent INTEGER NOT NULL DEFAULT 0,
      bounces INTEGER NOT NULL DEFAULT 0,
      spam_complaints INTEGER NOT NULL DEFAULT 0,
      inbox_placement_score FLOAT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(domain_id, metric_date)
    )
  `);
}

export async function getSendingDomains(orgId: string): Promise<SendingDomain[]> {
  await ensureTables();
  const db = buildDb();
  return db.query<SendingDomain>(
    `SELECT * FROM sdr_sending_domains WHERE org_id = $1 ORDER BY created_at DESC`,
    orgId
  );
}

export async function getSendingDomain(domainId: string): Promise<SendingDomain | null> {
  await ensureTables();
  const db = buildDb();
  const rows = await db.query<SendingDomain>(
    `SELECT * FROM sdr_sending_domains WHERE id = $1`,
    domainId
  );
  return rows[0] ?? null;
}

export async function upsertSendingDomain(
  orgId: string,
  domain: string,
  dkimSelector: string = "default"
): Promise<SendingDomain> {
  await ensureTables();
  const db = buildDb();
  const rows = await db.query<SendingDomain>(
    `INSERT INTO sdr_sending_domains (org_id, domain, dkim_selector)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id, domain) DO UPDATE SET
       dkim_selector = EXCLUDED.dkim_selector,
       updated_at = NOW()
     RETURNING *`,
    orgId,
    domain,
    dkimSelector
  );
  return rows[0];
}

export async function deleteSendingDomain(domainId: string): Promise<void> {
  await ensureTables();
  const db = buildDb();
  await db.execute(`DELETE FROM sdr_sending_domains WHERE id = $1`, domainId);
}

async function lookupTxtRecords(host: string): Promise<string[]> {
  try {
    const results = await dnsPromises.resolveTxt(host);
    return results.map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}

export async function checkDnsRecords(
  domain: string,
  dkimSelector: string
): Promise<DomainVerificationResult> {
  const spfRecords = await lookupTxtRecords(domain);
  const spfRecord = spfRecords.find((r) => r.startsWith("v=spf1")) ?? null;
  const spf: DnsRecord = {
    verified: spfRecord !== null,
    record: spfRecord,
    expected_host: domain,
  };

  const dkimHost = `${dkimSelector}._domainkey.${domain}`;
  const dkimRecords = await lookupTxtRecords(dkimHost);
  const dkimRecord = dkimRecords.find((r) => r.includes("v=DKIM1")) ?? null;
  const dkim: DnsRecord = {
    verified: dkimRecord !== null,
    record: dkimRecord,
    expected_host: dkimHost,
  };

  const dmarcHost = `_dmarc.${domain}`;
  const dmarcRecords = await lookupTxtRecords(dmarcHost);
  const dmarcRecord = dmarcRecords.find((r) => r.startsWith("v=DMARC1")) ?? null;
  const dmarc: DnsRecord = {
    verified: dmarcRecord !== null,
    record: dmarcRecord,
    expected_host: dmarcHost,
  };

  return {
    spf,
    dkim,
    dmarc,
    domain_verified: spf.verified && dkim.verified && dmarc.verified,
  };
}

export async function verifyAndUpdateDomain(
  domainId: string
): Promise<DomainVerificationResult> {
  await ensureTables();
  const sendingDomain = await getSendingDomain(domainId);
  if (!sendingDomain) throw new Error(`Domain ${domainId} not found`);

  const result = await checkDnsRecords(sendingDomain.domain, sendingDomain.dkim_selector);

  const db = buildDb();
  await db.execute(
    `UPDATE sdr_sending_domains
     SET spf_verified = $2, dkim_verified = $3, dmarc_verified = $4,
         domain_verified = $5, last_verified_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    domainId,
    result.spf.verified,
    result.dkim.verified,
    result.dmarc.verified,
    result.domain_verified
  );

  return result;
}

export async function getDeliverabilityMetrics(
  domainId: string,
  days: number = 30
): Promise<DeliverabilityMetrics> {
  await ensureTables();
  const db = buildDb();
  const rows = await db.query<{
    emails_sent: string;
    bounces: string;
    spam_complaints: string;
    inbox_placement_score: string;
  }>(
    `SELECT
       COALESCE(SUM(emails_sent), 0)::bigint AS emails_sent,
       COALESCE(SUM(bounces), 0)::bigint AS bounces,
       COALESCE(SUM(spam_complaints), 0)::bigint AS spam_complaints,
       COALESCE(AVG(NULLIF(inbox_placement_score, 0)), 0)::float AS inbox_placement_score
     FROM sdr_deliverability_metrics
     WHERE domain_id = $1
       AND metric_date >= CURRENT_DATE - ($2 || ' days')::interval`,
    domainId,
    String(days)
  );

  const row = rows[0] ?? {
    emails_sent: "0",
    bounces: "0",
    spam_complaints: "0",
    inbox_placement_score: "0",
  };
  const emailsSent = Number(row.emails_sent);
  const bounces = Number(row.bounces);
  const spamComplaints = Number(row.spam_complaints);
  const inboxScore = Number(row.inbox_placement_score);

  return {
    emails_sent: emailsSent,
    bounces,
    spam_complaints: spamComplaints,
    inbox_placement_score: inboxScore,
    bounce_rate: emailsSent > 0 ? bounces / emailsSent : 0,
    spam_rate: emailsSent > 0 ? spamComplaints / emailsSent : 0,
    date_range_days: days,
  };
}

export async function recordEmailSend(
  domainId: string,
  sent: number,
  bounces: number = 0,
  spamComplaints: number = 0,
  inboxPlacementScore: number = 0
): Promise<void> {
  await ensureTables();
  const db = buildDb();
  await db.execute(
    `INSERT INTO sdr_deliverability_metrics
       (domain_id, metric_date, emails_sent, bounces, spam_complaints, inbox_placement_score)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5)
     ON CONFLICT (domain_id, metric_date) DO UPDATE SET
       emails_sent = sdr_deliverability_metrics.emails_sent + EXCLUDED.emails_sent,
       bounces = sdr_deliverability_metrics.bounces + EXCLUDED.bounces,
       spam_complaints = sdr_deliverability_metrics.spam_complaints + EXCLUDED.spam_complaints,
       inbox_placement_score = CASE
         WHEN EXCLUDED.inbox_placement_score > 0 THEN EXCLUDED.inbox_placement_score
         ELSE sdr_deliverability_metrics.inbox_placement_score
       END,
       updated_at = NOW()`,
    domainId,
    sent,
    bounces,
    spamComplaints,
    inboxPlacementScore
  );
}
