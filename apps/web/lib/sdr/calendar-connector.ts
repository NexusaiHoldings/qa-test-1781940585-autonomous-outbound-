/**
 * SDR calendar connector — Google Calendar OAuth + Calendly booking integration.
 *
 * Stores encrypted OAuth tokens per org in sdr_calendar_settings.
 * Records confirmed meetings in sdr_booked_meetings.
 *
 * Required env vars:
 *   CALENDAR_TOKEN_ENCRYPTION_KEY — 64 hex chars (32-byte AES-256 key)
 *   GOOGLE_CLIENT_ID              — Google OAuth2 client ID
 *   GOOGLE_CLIENT_SECRET          — Google OAuth2 client secret
 *   CALENDLY_WEBHOOK_SIGNING_KEY  — Calendly webhook signing secret
 *   DATABASE_URL                  — Postgres connection string
 *   APP_BASE_URL                  — public base URL (for OAuth redirect URI)
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CalendarSettings {
  orgId: string;
  googleConnected: boolean;
  googleTokenExpiresAt: Date | null;
  calendlyConnected: boolean;
  calendlyEventTypeUrl: string | null;
}

export interface GoogleCalendarEvent {
  summary: string;
  description?: string;
  startTime: string;
  endTime: string;
  attendeeEmail: string;
  attendeeName?: string;
  location?: string;
  timeZone?: string;
}

export interface BookedMeeting {
  id: string;
  orgId: string;
  prospectEmail: string;
  prospectName: string;
  meetingStartAt: Date;
  meetingEndAt: Date;
  meetingUrl: string | null;
  source: "google_calendar" | "calendly";
  calendarEventId: string | null;
  calendlyEventUuid: string | null;
}

// ── DB Pool ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} {
  if (_pool) return _pool;
  const { Pool: PgPool } = require("pg") as {
    Pool: new (cfg: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

async function dbQuery<T = Record<string, unknown>>(
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const res = await getPool().query(sql, params);
  return res.rows as T[];
}

async function dbExecute(sql: string, ...params: unknown[]): Promise<void> {
  await getPool().query(sql, params);
}

// ── Encryption ─────────────────────────────────────────────────────────────────

function getEncryptionKey(): Buffer {
  const keyHex = process.env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? "";
  if (keyHex.length < 64) {
    throw new Error(
      "CALENDAR_TOKEN_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars)",
    );
  }
  return Buffer.from(keyHex.slice(0, 64), "hex");
}

function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptToken(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("invalid encrypted token format");
  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const data = Buffer.from(parts[2], "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(data).toString("utf8") + decipher.final("utf8");
}

// ── Schema Initialization ──────────────────────────────────────────────────────

let _schemaInitialized = false;

export async function ensureSchema(): Promise<void> {
  if (_schemaInitialized) return;
  await dbExecute(`
    CREATE TABLE IF NOT EXISTS sdr_calendar_settings (
      id                        UUID        NOT NULL DEFAULT gen_random_uuid(),
      org_id                    UUID        NOT NULL,
      google_access_token_enc   TEXT,
      google_refresh_token_enc  TEXT,
      google_token_expires_at   TIMESTAMPTZ,
      calendly_api_key_enc      TEXT,
      calendly_event_type_url   TEXT,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT sdr_calendar_settings_pkey PRIMARY KEY (id),
      CONSTRAINT sdr_calendar_settings_org_unique UNIQUE (org_id)
    )
  `);
  await dbExecute(`
    CREATE TABLE IF NOT EXISTS sdr_booked_meetings (
      id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
      org_id              UUID        NOT NULL,
      prospect_email      TEXT        NOT NULL,
      prospect_name       TEXT        NOT NULL DEFAULT '',
      meeting_start_at    TIMESTAMPTZ NOT NULL,
      meeting_end_at      TIMESTAMPTZ NOT NULL,
      meeting_url         TEXT,
      source              TEXT        NOT NULL,
      calendar_event_id   TEXT,
      calendly_event_uuid TEXT,
      raw_payload         JSONB       NOT NULL DEFAULT '{}',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT sdr_booked_meetings_pkey PRIMARY KEY (id),
      CONSTRAINT sdr_booked_meetings_org_calendly_unique
        UNIQUE (org_id, calendly_event_uuid)
    )
  `);
  await dbExecute(
    "CREATE INDEX IF NOT EXISTS idx_sdr_booked_meetings_org ON sdr_booked_meetings(org_id, meeting_start_at)",
  );
  _schemaInitialized = true;
}

// ── Internal row type ──────────────────────────────────────────────────────────

interface SettingsRow {
  org_id: string;
  google_access_token_enc: string | null;
  google_refresh_token_enc: string | null;
  google_token_expires_at: Date | null;
  calendly_api_key_enc: string | null;
  calendly_event_type_url: string | null;
}

async function fetchSettingsRow(orgId: string): Promise<SettingsRow | null> {
  const rows = await dbQuery<SettingsRow>(
    `SELECT org_id, google_access_token_enc, google_refresh_token_enc,
            google_token_expires_at, calendly_api_key_enc, calendly_event_type_url
     FROM sdr_calendar_settings WHERE org_id = $1::uuid LIMIT 1`,
    orgId,
  );
  return rows[0] ?? null;
}

// ── Google Calendar OAuth ──────────────────────────────────────────────────────

function googleRedirectUri(): string {
  const base =
    process.env.APP_BASE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000");
  return `${base.replace(/\/+$/, "")}/settings/calendar`;
}

export function generateGoogleAuthUrl(orgId: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");
  const redirectUri = googleRedirectUri();
  const state = Buffer.from(
    JSON.stringify({ orgId, ts: Date.now() }),
  ).toString("base64url");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.events",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleAuthCode(
  code: string,
  orgId: string,
): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("Google OAuth credentials not configured");

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }).toString(),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `Google token exchange failed (${resp.status}): ${detail.slice(0, 300)}`,
    );
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  await ensureSchema();
  const accessEnc = encryptToken(data.access_token);
  const refreshEnc = data.refresh_token
    ? encryptToken(data.refresh_token)
    : null;
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await dbExecute(
    `INSERT INTO sdr_calendar_settings
       (org_id, google_access_token_enc, google_refresh_token_enc, google_token_expires_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, NOW())
     ON CONFLICT (org_id) DO UPDATE SET
       google_access_token_enc  = EXCLUDED.google_access_token_enc,
       google_refresh_token_enc = COALESCE(EXCLUDED.google_refresh_token_enc, sdr_calendar_settings.google_refresh_token_enc),
       google_token_expires_at  = EXCLUDED.google_token_expires_at,
       updated_at               = NOW()`,
    orgId,
    accessEnc,
    refreshEnc,
    expiresAt,
  );
}

export async function getValidGoogleToken(
  orgId: string,
): Promise<string | null> {
  await ensureSchema();
  const row = await fetchSettingsRow(orgId);
  if (!row?.google_access_token_enc) return null;

  const expiresAt = row.google_token_expires_at
    ? new Date(row.google_token_expires_at)
    : null;
  const stillValid = expiresAt && expiresAt.getTime() > Date.now() + 60_000;

  if (stillValid) return decryptToken(row.google_access_token_enc);

  if (!row.google_refresh_token_enc) return null;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const refreshResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: decryptToken(row.google_refresh_token_enc),
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }).toString(),
  });

  if (!refreshResp.ok) {
    console.error(
      `[calendar] Google token refresh failed (${refreshResp.status})`,
    );
    return null;
  }

  const refreshData = (await refreshResp.json()) as {
    access_token: string;
    expires_in: number;
  };
  const newAccessEnc = encryptToken(refreshData.access_token);
  const newExpiry = new Date(Date.now() + refreshData.expires_in * 1000);

  await dbExecute(
    `UPDATE sdr_calendar_settings
     SET google_access_token_enc = $2, google_token_expires_at = $3, updated_at = NOW()
     WHERE org_id = $1::uuid`,
    orgId,
    newAccessEnc,
    newExpiry,
  );

  return refreshData.access_token;
}

export async function createGoogleCalendarEvent(
  orgId: string,
  event: GoogleCalendarEvent,
): Promise<string> {
  const accessToken = await getValidGoogleToken(orgId);
  if (!accessToken) throw new Error("Google Calendar not connected");

  const body = {
    summary: event.summary,
    description: event.description ?? "",
    location: event.location ?? "",
    start: {
      dateTime: event.startTime,
      timeZone: event.timeZone ?? "UTC",
    },
    end: {
      dateTime: event.endTime,
      timeZone: event.timeZone ?? "UTC",
    },
    attendees: [
      {
        email: event.attendeeEmail,
        displayName: event.attendeeName ?? event.attendeeEmail,
      },
    ],
    reminders: { useDefault: true },
  };

  const resp = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendNotifications=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `Google Calendar event creation failed (${resp.status}): ${detail.slice(0, 300)}`,
    );
  }

  const data = (await resp.json()) as { id: string };
  return data.id;
}

export async function disconnectGoogleCalendar(orgId: string): Promise<void> {
  await ensureSchema();
  const row = await fetchSettingsRow(orgId);
  if (!row?.google_access_token_enc) return;

  try {
    const token = decryptToken(row.google_access_token_enc);
    await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
  } catch {
    // Best-effort revocation; proceed with local cleanup regardless
  }

  await dbExecute(
    `UPDATE sdr_calendar_settings
     SET google_access_token_enc = NULL,
         google_refresh_token_enc = NULL,
         google_token_expires_at = NULL,
         updated_at = NOW()
     WHERE org_id = $1::uuid`,
    orgId,
  );
}

// ── Calendly ───────────────────────────────────────────────────────────────────

export async function saveCalendlyConfig(
  orgId: string,
  apiKey: string,
  eventTypeUrl: string,
): Promise<void> {
  await ensureSchema();
  const apiKeyEnc = encryptToken(apiKey);
  await dbExecute(
    `INSERT INTO sdr_calendar_settings (org_id, calendly_api_key_enc, calendly_event_type_url, updated_at)
     VALUES ($1::uuid, $2, $3, NOW())
     ON CONFLICT (org_id) DO UPDATE SET
       calendly_api_key_enc     = EXCLUDED.calendly_api_key_enc,
       calendly_event_type_url  = EXCLUDED.calendly_event_type_url,
       updated_at               = NOW()`,
    orgId,
    apiKeyEnc,
    eventTypeUrl,
  );
}

export async function generateCalendlyBookingLink(
  orgId: string,
  prospectEmail: string,
  prospectName: string,
): Promise<string | null> {
  await ensureSchema();
  const row = await fetchSettingsRow(orgId);
  if (!row?.calendly_api_key_enc || !row.calendly_event_type_url) return null;

  const apiKey = decryptToken(row.calendly_api_key_enc);

  const resp = await fetch("https://api.calendly.com/scheduling_links", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      max_event_count: 1,
      owner: row.calendly_event_type_url,
      owner_type: "EventType",
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error(
      `[calendar] Calendly scheduling link failed (${resp.status}): ${detail.slice(0, 200)}`,
    );
    return null;
  }

  const data = (await resp.json()) as {
    resource: { booking_url: string };
  };
  const bookingUrl = data.resource?.booking_url;
  if (!bookingUrl) return null;

  const url = new URL(bookingUrl);
  url.searchParams.set("email", prospectEmail);
  url.searchParams.set("name", prospectName);
  return url.toString();
}

export function verifyCalendlySignature(
  body: string,
  header: string,
  webhookKey: string,
): boolean {
  // Calendly v2 format: "t=<epoch_ms>,v1=<hmac_hex>"
  const parts: Record<string, string> = {};
  for (const segment of header.split(",")) {
    const eq = segment.indexOf("=");
    if (eq > 0) parts[segment.slice(0, eq)] = segment.slice(eq + 1);
  }
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  const toSign = `${timestamp}.${body}`;
  const expected = createHmac("sha256", webhookKey)
    .update(toSign)
    .digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    return false;
  }
}

export async function processCalendlyWebhook(
  orgId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await ensureSchema();

  const eventType = payload.event as string | undefined;
  if (eventType !== "invitee.created") return;

  const payloadData = payload.payload as Record<string, unknown> | undefined;
  if (!payloadData) return;

  const invitee = payloadData.invitee as Record<string, unknown> | undefined;
  const scheduledEvent = payloadData.scheduled_event as
    | Record<string, unknown>
    | undefined;
  if (!invitee || !scheduledEvent) return;

  const prospectEmail = String(invitee.email ?? "");
  const prospectName = String(invitee.name ?? "");
  if (!prospectEmail) return;

  const calendlyEventUuid = String(scheduledEvent.uri ?? "")
    .split("/")
    .pop() ?? crypto.randomUUID();

  const startTime = String(scheduledEvent.start_time ?? "");
  const endTime = String(scheduledEvent.end_time ?? startTime);

  const locationObj = scheduledEvent.location as
    | Record<string, unknown>
    | null
    | undefined;
  let meetingUrl: string | null = null;
  if (locationObj) {
    if (typeof locationObj.join_url === "string") {
      meetingUrl = locationObj.join_url;
    } else if (typeof locationObj.location === "string") {
      meetingUrl = locationObj.location;
    }
  }

  if (!startTime) return;

  await dbExecute(
    `INSERT INTO sdr_booked_meetings
       (org_id, prospect_email, prospect_name, meeting_start_at, meeting_end_at,
        meeting_url, source, calendly_event_uuid, raw_payload)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, 'calendly', $7, $8::jsonb)
     ON CONFLICT (org_id, calendly_event_uuid) DO NOTHING`,
    orgId,
    prospectEmail,
    prospectName,
    new Date(startTime),
    new Date(endTime),
    meetingUrl,
    calendlyEventUuid,
    JSON.stringify(payload),
  );
}

// ── Settings read ──────────────────────────────────────────────────────────────

export async function getCalendarSettings(
  orgId: string,
): Promise<CalendarSettings> {
  await ensureSchema();
  const row = await fetchSettingsRow(orgId);
  return {
    orgId,
    googleConnected: !!(row?.google_access_token_enc),
    googleTokenExpiresAt: row?.google_token_expires_at
      ? new Date(row.google_token_expires_at)
      : null,
    calendlyConnected: !!(row?.calendly_api_key_enc),
    calendlyEventTypeUrl: row?.calendly_event_type_url ?? null,
  };
}

// ── Save booked meeting (Google Calendar path) ─────────────────────────────────

export async function saveBookedMeeting(
  meeting: Omit<BookedMeeting, "id">,
): Promise<string> {
  await ensureSchema();
  const id = crypto.randomUUID();
  await dbExecute(
    `INSERT INTO sdr_booked_meetings
       (id, org_id, prospect_email, prospect_name, meeting_start_at, meeting_end_at,
        meeting_url, source, calendar_event_id, calendly_event_uuid, raw_payload)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb)`,
    id,
    meeting.orgId,
    meeting.prospectEmail,
    meeting.prospectName,
    meeting.meetingStartAt,
    meeting.meetingEndAt,
    meeting.meetingUrl,
    meeting.source,
    meeting.calendarEventId,
    meeting.calendlyEventUuid,
  );
  return id;
}

// ── Org helper (used by pages + webhooks) ──────────────────────────────────────

export async function getOrgIdForUser(userId: string): Promise<string | null> {
  const rows = await dbQuery<{ org_id: string }>(
    `SELECT org_id FROM org_members WHERE user_id = $1::uuid
     ORDER BY joined_at ASC LIMIT 1`,
    userId,
  );
  return rows[0]?.org_id ?? null;
}
