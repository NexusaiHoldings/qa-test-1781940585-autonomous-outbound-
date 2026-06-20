import { buildDb } from "@/lib/db";
import { getSendingDomain } from "@/lib/sdr/domain-verifier";

// 14-day warmup schedule: daily send limits per industry best practice.
// Volume roughly doubles every 2 days to build sender reputation gradually.
export const WARMUP_DAILY_LIMITS: number[] = [
  25, 50, 100, 150, 200, 300, 400, 500, 700, 1000, 1500, 2000, 3000, 5000,
];

export const WARMUP_DAYS = 14;

export interface WarmupState {
  domain_id: string;
  domain: string;
  warmup_day: number;
  daily_limit: number;
  completed: boolean;
  warmup_started_at: string | null;
}

export interface SendAllowance {
  allowed: boolean;
  daily_limit: number;
  emails_sent_today: number;
  remaining: number;
}

function dailyLimitForDay(warmupDay: number): number {
  if (warmupDay <= 0) return 0;
  if (warmupDay > WARMUP_DAYS) return WARMUP_DAILY_LIMITS[WARMUP_DAYS - 1];
  return WARMUP_DAILY_LIMITS[warmupDay - 1];
}

export async function getWarmupState(domainId: string): Promise<WarmupState | null> {
  const domain = await getSendingDomain(domainId);
  if (!domain) return null;

  const warmupDay = domain.warmup_day;
  const completed = warmupDay >= WARMUP_DAYS;

  return {
    domain_id: domain.id,
    domain: domain.domain,
    warmup_day: warmupDay,
    daily_limit: dailyLimitForDay(warmupDay),
    completed,
    warmup_started_at: domain.warmup_started_at,
  };
}

export async function getActiveWarmupDomains(): Promise<WarmupState[]> {
  const db = buildDb();
  const rows = await db.query<{
    id: string;
    domain: string;
    warmup_day: number;
    warmup_started_at: string | null;
  }>(
    `SELECT id, domain, warmup_day, warmup_started_at
     FROM sdr_sending_domains
     WHERE domain_verified = true
       AND warmup_day > 0
       AND warmup_day < $1
     ORDER BY warmup_started_at ASC`,
    WARMUP_DAYS
  );

  return rows.map((row) => ({
    domain_id: row.id,
    domain: row.domain,
    warmup_day: row.warmup_day,
    daily_limit: dailyLimitForDay(row.warmup_day),
    completed: row.warmup_day >= WARMUP_DAYS,
    warmup_started_at: row.warmup_started_at,
  }));
}

export async function startWarmup(domainId: string): Promise<WarmupState> {
  const domain = await getSendingDomain(domainId);
  if (!domain) throw new Error(`Domain ${domainId} not found`);
  if (!domain.domain_verified) {
    throw new Error(`Domain ${domain.domain} must be verified before starting warmup`);
  }

  const db = buildDb();
  await db.execute(
    `UPDATE sdr_sending_domains
     SET warmup_day = 1, warmup_started_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    domainId
  );

  return {
    domain_id: domainId,
    domain: domain.domain,
    warmup_day: 1,
    daily_limit: dailyLimitForDay(1),
    completed: false,
    warmup_started_at: new Date().toISOString(),
  };
}

export async function advanceWarmupDay(domainId: string): Promise<WarmupState> {
  const domain = await getSendingDomain(domainId);
  if (!domain) throw new Error(`Domain ${domainId} not found`);

  const currentDay = domain.warmup_day;
  if (currentDay === 0) {
    throw new Error(`Warmup not started for domain ${domain.domain}`);
  }

  const nextDay = Math.min(currentDay + 1, WARMUP_DAYS);
  const completed = nextDay >= WARMUP_DAYS;

  const db = buildDb();
  await db.execute(
    `UPDATE sdr_sending_domains
     SET warmup_day = $2, updated_at = NOW()
     WHERE id = $1`,
    domainId,
    nextDay
  );

  return {
    domain_id: domainId,
    domain: domain.domain,
    warmup_day: nextDay,
    daily_limit: dailyLimitForDay(nextDay),
    completed,
    warmup_started_at: domain.warmup_started_at,
  };
}

export async function checkSendAllowance(
  domainId: string,
  count: number
): Promise<SendAllowance> {
  const state = await getWarmupState(domainId);
  if (!state) throw new Error(`Domain ${domainId} not found`);

  const db = buildDb();
  const rows = await db.query<{ emails_sent: string }>(
    `SELECT COALESCE(emails_sent, 0)::bigint AS emails_sent
     FROM sdr_deliverability_metrics
     WHERE domain_id = $1 AND metric_date = CURRENT_DATE`,
    domainId
  );

  const emailsSentToday = rows.length > 0 ? Number(rows[0].emails_sent) : 0;
  const dailyLimit = state.completed
    ? WARMUP_DAILY_LIMITS[WARMUP_DAYS - 1]
    : state.daily_limit;
  const remaining = Math.max(0, dailyLimit - emailsSentToday);

  return {
    allowed: remaining >= count,
    daily_limit: dailyLimit,
    emails_sent_today: emailsSentToday,
    remaining,
  };
}
