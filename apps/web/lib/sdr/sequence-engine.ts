/**
 * SDR sequence engine — tracks per-prospect touches, enforces 2-3 touch max,
 * schedules follow-ups, and persists inbound reply records.
 *
 * All DB access uses the `pg` Pool with parameterized queries ($1, $2, …).
 * Tables are created lazily via ensureSchema() which is idempotent.
 */

import { Pool } from "pg";

// ── DDL ──────────────────────────────────────────────────────────────────────

const SDR_DDL = `
CREATE TABLE IF NOT EXISTS sdr_campaigns (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text        NOT NULL,
  status              text        NOT NULL DEFAULT 'active',
  max_touches         integer     NOT NULL DEFAULT 3,
  touch_interval_hours integer    NOT NULL DEFAULT 48,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sdr_campaigns_status
  ON sdr_campaigns(status);

CREATE TABLE IF NOT EXISTS sdr_prospects (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid        NOT NULL REFERENCES sdr_campaigns(id),
  email       text        NOT NULL,
  first_name  text,
  last_name   text,
  company     text,
  title       text,
  status      text        NOT NULL DEFAULT 'active',
  suppressed  boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sdr_prospects_campaign
  ON sdr_prospects(campaign_id);
CREATE INDEX IF NOT EXISTS idx_sdr_prospects_email
  ON sdr_prospects(email);

CREATE TABLE IF NOT EXISTS sdr_sequence_touches (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id  uuid        NOT NULL REFERENCES sdr_prospects(id),
  campaign_id  uuid        NOT NULL REFERENCES sdr_campaigns(id),
  touch_number integer     NOT NULL,
  touch_type   text        NOT NULL,
  scheduled_at timestamptz NOT NULL,
  sent_at      timestamptz,
  status       text        NOT NULL DEFAULT 'pending',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sdr_touches_prospect
  ON sdr_sequence_touches(prospect_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_sdr_touches_pending
  ON sdr_sequence_touches(status, scheduled_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS sdr_inbound_replies (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id      uuid        REFERENCES sdr_prospects(id),
  campaign_id      uuid        REFERENCES sdr_campaigns(id),
  from_email       text        NOT NULL,
  subject          text,
  body             text        NOT NULL,
  classification   text,
  confidence       real,
  reasoning        text,
  dispatched_action text,
  raw_payload      jsonb,
  received_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sdr_replies_campaign
  ON sdr_inbound_replies(campaign_id);
CREATE INDEX IF NOT EXISTS idx_sdr_replies_classification
  ON sdr_inbound_replies(classification);
`;

// ── Pool singleton ────────────────────────────────────────────────────────────

let _pool: Pool | null = null;
let _schemaEnsured = false;

export function getPool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  }
  return _pool;
}

export async function ensureSchema(pool: Pool): Promise<void> {
  if (_schemaEnsured) return;
  await pool.query(SDR_DDL);
  _schemaEnsured = true;
}

// ── Row types ─────────────────────────────────────────────────────────────────

export interface CampaignRow {
  id: string;
  name: string;
  status: string;
  max_touches: number;
  touch_interval_hours: number;
  created_at: Date;
  updated_at: Date;
}

export interface ProspectRow {
  id: string;
  campaign_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  status: string;
  suppressed: boolean;
  created_at: Date;
}

export interface TouchRow {
  id: string;
  prospect_id: string;
  campaign_id: string;
  touch_number: number;
  touch_type: string;
  scheduled_at: Date;
  sent_at: Date | null;
  status: string;
}

export interface ReplyRow {
  id: string;
  prospect_id: string | null;
  campaign_id: string | null;
  from_email: string;
  subject: string | null;
  body: string;
  classification: string | null;
  confidence: number | null;
  reasoning: string | null;
  dispatched_action: string | null;
  received_at: Date;
}

// ── Prospect helpers ──────────────────────────────────────────────────────────

export async function findProspectByEmail(
  email: string,
  pool: Pool
): Promise<ProspectRow | null> {
  const res = await pool.query<ProspectRow>(
    `SELECT id, campaign_id, email, first_name, last_name, company, title, status, suppressed, created_at
     FROM sdr_prospects
     WHERE email = $1 AND suppressed = false
     ORDER BY created_at DESC
     LIMIT 1`,
    [email]
  );
  return res.rows[0] ?? null;
}

export async function suppressProspect(
  prospectId: string,
  pool: Pool
): Promise<void> {
  await pool.query(
    `UPDATE sdr_prospects
     SET suppressed = true, status = 'unsubscribed', updated_at = now()
     WHERE id = $1`,
    [prospectId]
  );
}

// ── Touch helpers ─────────────────────────────────────────────────────────────

export async function getProspectTouchCount(
  prospectId: string,
  campaignId: string,
  pool: Pool
): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM sdr_sequence_touches
     WHERE prospect_id = $1
       AND campaign_id = $2
       AND status = 'sent'`,
    [prospectId, campaignId]
  );
  return parseInt(res.rows[0]?.count ?? "0", 10);
}

export async function canSendNextTouch(
  prospectId: string,
  campaignId: string,
  pool: Pool
): Promise<boolean> {
  const prospectRes = await pool.query<{ suppressed: boolean }>(
    `SELECT suppressed FROM sdr_prospects WHERE id = $1`,
    [prospectId]
  );
  if (!prospectRes.rows[0] || prospectRes.rows[0].suppressed) return false;

  const campaignRes = await pool.query<{
    max_touches: number;
    touch_interval_hours: number;
  }>(
    `SELECT max_touches, touch_interval_hours
     FROM sdr_campaigns
     WHERE id = $1 AND status = 'active'`,
    [campaignId]
  );
  const campaign = campaignRes.rows[0];
  if (!campaign) return false;

  const touchCount = await getProspectTouchCount(prospectId, campaignId, pool);
  if (touchCount >= campaign.max_touches) return false;

  const lastTouchRes = await pool.query<{ sent_at: Date }>(
    `SELECT sent_at
     FROM sdr_sequence_touches
     WHERE prospect_id = $1
       AND campaign_id = $2
       AND status = 'sent'
     ORDER BY sent_at DESC
     LIMIT 1`,
    [prospectId, campaignId]
  );

  if (lastTouchRes.rows.length > 0 && lastTouchRes.rows[0].sent_at) {
    const hoursSinceLast =
      (Date.now() - new Date(lastTouchRes.rows[0].sent_at).getTime()) /
      (1000 * 60 * 60);
    if (hoursSinceLast < campaign.touch_interval_hours) return false;
  }

  return true;
}

export async function recordTouch(
  prospectId: string,
  campaignId: string,
  touchType: string,
  touchNumber: number,
  pool: Pool
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sdr_sequence_touches
       (prospect_id, campaign_id, touch_number, touch_type, scheduled_at, sent_at, status)
     VALUES ($1, $2, $3, $4, now(), now(), 'sent')
     RETURNING id`,
    [prospectId, campaignId, touchNumber, touchType]
  );
  return res.rows[0].id;
}

export async function markTouchSent(
  touchId: string,
  pool: Pool
): Promise<void> {
  await pool.query(
    `UPDATE sdr_sequence_touches
     SET status = 'sent', sent_at = now()
     WHERE id = $1`,
    [touchId]
  );
}

export async function markTouchSkipped(
  touchId: string,
  pool: Pool
): Promise<void> {
  await pool.query(
    `UPDATE sdr_sequence_touches
     SET status = 'skipped'
     WHERE id = $1`,
    [touchId]
  );
}

export async function scheduleFollowUp(
  prospectId: string,
  campaignId: string,
  touchType: string,
  pool: Pool
): Promise<void> {
  const touchCount = await getProspectTouchCount(prospectId, campaignId, pool);

  const campaignRes = await pool.query<{
    max_touches: number;
    touch_interval_hours: number;
  }>(
    `SELECT max_touches, touch_interval_hours
     FROM sdr_campaigns
     WHERE id = $1`,
    [campaignId]
  );
  const campaign = campaignRes.rows[0];
  if (!campaign || touchCount >= campaign.max_touches) return;

  const scheduledAt = new Date(
    Date.now() + campaign.touch_interval_hours * 60 * 60 * 1000
  );

  await pool.query(
    `INSERT INTO sdr_sequence_touches
       (prospect_id, campaign_id, touch_number, touch_type, scheduled_at, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [prospectId, campaignId, touchCount + 1, touchType, scheduledAt]
  );
}

export async function getPendingTouches(pool: Pool): Promise<TouchRow[]> {
  const res = await pool.query<TouchRow>(
    `SELECT st.id, st.prospect_id, st.campaign_id,
            st.touch_number, st.touch_type,
            st.scheduled_at, st.sent_at, st.status
     FROM sdr_sequence_touches st
     JOIN sdr_prospects sp ON sp.id = st.prospect_id
     WHERE st.status = 'pending'
       AND st.scheduled_at <= now()
       AND sp.suppressed = false
     ORDER BY st.scheduled_at ASC
     LIMIT 50`
  );
  return res.rows;
}

// ── Reply persistence ─────────────────────────────────────────────────────────

export async function saveReply(
  fromEmail: string,
  subject: string | null,
  body: string,
  prospectId: string | null,
  campaignId: string | null,
  classification: string,
  confidence: number,
  reasoning: string,
  dispatchedAction: string,
  rawPayload: Record<string, unknown>,
  pool: Pool
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sdr_inbound_replies
       (from_email, subject, body, prospect_id, campaign_id,
        classification, confidence, reasoning, dispatched_action, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      fromEmail,
      subject,
      body,
      prospectId,
      campaignId,
      classification,
      confidence,
      reasoning,
      dispatchedAction,
      JSON.stringify(rawPayload),
    ]
  );
  return res.rows[0].id;
}

export async function getRepliesForCampaign(
  campaignId: string,
  pool: Pool
): Promise<ReplyRow[]> {
  const res = await pool.query<ReplyRow>(
    `SELECT ir.id, ir.prospect_id, ir.campaign_id,
            ir.from_email, ir.subject, ir.body,
            ir.classification, ir.confidence, ir.reasoning,
            ir.dispatched_action, ir.received_at
     FROM sdr_inbound_replies ir
     WHERE ir.campaign_id = $1
     ORDER BY ir.received_at DESC
     LIMIT 100`,
    [campaignId]
  );
  return res.rows;
}
