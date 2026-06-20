import { buildDb } from "@/lib/db";
import crypto from "node:crypto";

export interface SuppressionEntry {
  id: string;
  org_id: string | null;
  email: string;
  reason: string;
  created_at: string;
}

let _schemaEnsured = false;

async function ensureSchema(): Promise<void> {
  if (_schemaEnsured) return;
  const db = buildDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sdr_unsubscribe_tokens (
      token      TEXT PRIMARY KEY,
      org_id     TEXT,
      email      TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at    TIMESTAMPTZ
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sdr_suppression_list (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id     TEXT,
      email      TEXT NOT NULL,
      reason     TEXT NOT NULL DEFAULT 'manual',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sdr_suppression_unique
    ON sdr_suppression_list (COALESCE(org_id, ''), email)
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_sdr_unsubscribe_tokens_email
    ON sdr_unsubscribe_tokens (email)
  `);
  _schemaEnsured = true;
}

export async function generateUnsubscribeToken(
  email: string,
  orgId: string | null,
): Promise<string> {
  await ensureSchema();
  const db = buildDb();
  const token = crypto.randomBytes(32).toString("hex");
  const normalized = email.toLowerCase().trim();
  await db.execute(
    `INSERT INTO sdr_unsubscribe_tokens (token, org_id, email) VALUES ($1, $2, $3)`,
    token,
    orgId,
    normalized,
  );
  return token;
}

export async function processUnsubscribeToken(
  token: string,
): Promise<{ email: string; orgId: string | null } | null> {
  await ensureSchema();
  const db = buildDb();
  const rows = await db.query<{ email: string; org_id: string | null }>(
    `SELECT email, org_id FROM sdr_unsubscribe_tokens WHERE token = $1`,
    token,
  );
  if (rows.length === 0) return null;
  const { email, org_id } = rows[0];
  await db.execute(
    `UPDATE sdr_unsubscribe_tokens SET used_at = NOW()
     WHERE token = $1 AND used_at IS NULL`,
    token,
  );
  await db.execute(
    `INSERT INTO sdr_suppression_list (org_id, email, reason)
     VALUES ($1, $2, 'unsubscribe')
     ON CONFLICT (COALESCE(org_id, ''), email) DO NOTHING`,
    org_id,
    email,
  );
  return { email, orgId: org_id };
}

export async function isEmailSuppressed(
  email: string,
  orgId: string | null,
): Promise<boolean> {
  await ensureSchema();
  const db = buildDb();
  const normalized = email.toLowerCase().trim();
  const rows = await db.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM sdr_suppression_list
     WHERE email = $1 AND COALESCE(org_id, '') = COALESCE($2, '')`,
    normalized,
    orgId,
  );
  return parseInt(rows[0]?.cnt ?? "0", 10) > 0;
}

export async function listSuppressedEmails(
  orgId: string | null,
  limit = 50,
  offset = 0,
): Promise<{ entries: SuppressionEntry[]; total: number }> {
  await ensureSchema();
  const db = buildDb();
  const countRows = await db.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM sdr_suppression_list
     WHERE COALESCE(org_id, '') = COALESCE($1, '')`,
    orgId,
  );
  const total = parseInt(countRows[0]?.total ?? "0", 10);
  const entries = await db.query<SuppressionEntry>(
    `SELECT id, org_id, email, reason, created_at::text AS created_at
     FROM sdr_suppression_list
     WHERE COALESCE(org_id, '') = COALESCE($1, '')
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    orgId,
    limit,
    offset,
  );
  return { entries, total };
}

export async function addToSuppressionList(
  email: string,
  orgId: string | null,
  reason = "manual",
): Promise<SuppressionEntry> {
  await ensureSchema();
  const db = buildDb();
  const normalized = email.toLowerCase().trim();
  const rows = await db.query<SuppressionEntry>(
    `INSERT INTO sdr_suppression_list (org_id, email, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (COALESCE(org_id, ''), email) DO UPDATE SET reason = EXCLUDED.reason
     RETURNING id, org_id, email, reason, created_at::text AS created_at`,
    orgId,
    normalized,
    reason,
  );
  return rows[0];
}

export async function removeFromSuppressionList(
  id: string,
  orgId: string | null,
): Promise<boolean> {
  await ensureSchema();
  const db = buildDb();
  const rows = await db.query<{ id: string }>(
    `DELETE FROM sdr_suppression_list
     WHERE id = $1 AND COALESCE(org_id, '') = COALESCE($2, '')
     RETURNING id`,
    id,
    orgId,
  );
  return rows.length > 0;
}
