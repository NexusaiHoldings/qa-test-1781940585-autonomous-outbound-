/**
 * Agent tool handler: book_calendar_meeting
 *
 * Calls Google Calendar API or Calendly API using the founder's stored OAuth
 * token to create a meeting event or generate a booking link, then writes the
 * confirmed meeting record to sdr_booked_meetings. Invoked when reply
 * classification returns 'interested' and prospect confirms availability.
 * Autonomy = human_review — mutations route through the cross-boundary bridge.
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

export type Args = Record<string, unknown>;

type CalendarProvider = "google_calendar" | "calendly";

interface OAuthToken {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  provider: CalendarProvider;
  owner_user_id: string;
}

interface GoogleCalendarEvent {
  id: string;
  htmlLink: string;
  hangoutLink: string | null;
  summary: string;
  start: { dateTime: string };
  end: { dateTime: string };
  status: string;
}

interface GoogleCalendarError {
  error?: { message?: string; code?: number };
}

interface CalendlySchedulingLink {
  booking_url: string;
  event_type_uri: string;
  owner: string;
}

interface CalendlyApiResponse {
  resource?: CalendlySchedulingLink;
  message?: string;
}

interface MeetingRecord {
  prospect_id: string;
  provider: CalendarProvider;
  calendar_event_id: string | null;
  calendar_event_link: string | null;
  booking_url: string | null;
  meeting_title: string;
  start_time: string;
  end_time: string;
  attendee_email: string | null;
  meet_link: string | null;
  status: string;
  booked_at: string;
}

async function fetchOAuthToken(
  ctx: HandlerContext,
  provider: CalendarProvider,
): Promise<OAuthToken | null> {
  const rows = await ctx.db.query<OAuthToken>(
    `SELECT access_token, refresh_token, expires_at, provider, owner_user_id
     FROM oauth_tokens
     WHERE provider = $1
       AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    provider,
  );
  if (!rows || rows.length === 0) return null;
  return rows[0] as OAuthToken;
}

async function refreshGoogleToken(
  refreshToken: string,
): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!resp.ok) return null;
  const data = (await resp.json()) as { access_token?: string };
  return data.access_token ?? null;
}

async function createGoogleCalendarEvent(
  accessToken: string,
  attendeeEmail: string,
  title: string,
  startTime: string,
  endTime: string,
  description: string,
): Promise<{ eventId: string; htmlLink: string; meetLink: string | null } | null> {
  const body = {
    summary: title,
    description,
    start: { dateTime: startTime, timeZone: "UTC" },
    end: { dateTime: endTime, timeZone: "UTC" },
    attendees: [{ email: attendeeEmail }],
    conferenceData: {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
    reminders: {
      useDefault: false,
      overrides: [{ method: "email", minutes: 60 }, { method: "popup", minutes: 10 }],
    },
  };

  const resp = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
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
    const err = (await resp.json().catch(() => ({}))) as GoogleCalendarError;
    const msg = err.error?.message ?? resp.statusText;
    throw new Error(`Google Calendar API error ${resp.status}: ${msg}`);
  }

  const event = (await resp.json()) as GoogleCalendarEvent;
  return {
    eventId: event.id,
    htmlLink: event.htmlLink,
    meetLink: event.hangoutLink ?? null,
  };
}

async function createCalendlySchedulingLink(
  accessToken: string,
  maxEventCount: number,
): Promise<{ bookingUrl: string; eventTypeUri: string } | null> {
  const meResp = await fetch("https://api.calendly.com/users/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!meResp.ok) return null;

  const meData = (await meResp.json()) as {
    resource?: { uri?: string; scheduling_url?: string };
  };
  const userUri = meData.resource?.uri;
  if (!userUri) return null;

  const etResp = await fetch(
    `https://api.calendly.com/event_types?user=${encodeURIComponent(userUri)}&count=1&active=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!etResp.ok) return null;

  const etData = (await etResp.json()) as {
    collection?: Array<{ uri?: string; scheduling_url?: string }>;
  };
  const eventType = etData.collection?.[0];
  if (!eventType?.uri) return null;

  const linkResp = await fetch("https://api.calendly.com/scheduling_links", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      max_event_count: maxEventCount,
      owner: eventType.uri,
      owner_type: "EventType",
    }),
  });

  if (!linkResp.ok) {
    const err = (await linkResp.json().catch(() => ({}))) as CalendlyApiResponse;
    throw new Error(`Calendly API error ${linkResp.status}: ${err.message ?? linkResp.statusText}`);
  }

  const linkData = (await linkResp.json()) as CalendlyApiResponse;
  const bookingUrl = linkData.resource?.booking_url;
  if (!bookingUrl) return null;

  return { bookingUrl, eventTypeUri: eventType.uri };
}

async function insertBookedMeeting(
  ctx: HandlerContext,
  record: MeetingRecord,
): Promise<string> {
  const meetingId = crypto.randomUUID();
  await ctx.db.execute(
    `INSERT INTO sdr_booked_meetings (
       id, prospect_id, provider, calendar_event_id, calendar_event_link,
       booking_url, meeting_title, start_time, end_time, attendee_email,
       meet_link, status, booked_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz,
       $10, $11, $12, $13::timestamptz, NOW(), NOW()
     )`,
    meetingId,
    record.prospect_id,
    record.provider,
    record.calendar_event_id,
    record.calendar_event_link,
    record.booking_url,
    record.meeting_title,
    record.start_time,
    record.end_time,
    record.attendee_email,
    record.meet_link,
    record.status,
    record.booked_at,
  );
  return meetingId;
}

export async function handleBookCalendarMeeting(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const prospectId = args["prospect_id"];
  if (typeof prospectId !== "string" || !prospectId) {
    return { status: 400, body: "prospect_id is required and must be a non-empty string" };
  }

  const startTime = args["start_time"];
  const endTime = args["end_time"];
  if (typeof startTime !== "string" || !startTime) {
    return { status: 400, body: "start_time is required (ISO 8601 datetime string)" };
  }
  if (typeof endTime !== "string" || !endTime) {
    return { status: 400, body: "end_time is required (ISO 8601 datetime string)" };
  }

  const title =
    typeof args["meeting_title"] === "string" && args["meeting_title"]
      ? args["meeting_title"]
      : "Intro call";

  const description =
    typeof args["notes"] === "string" ? args["notes"] : "";

  const preferredProvider =
    args["provider"] === "calendly" ? "calendly" : "google_calendar";

  // Fetch prospect for attendee email.
  const prospectRows = await ctx.db.query<{
    id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
  }>(
    `SELECT id, email, first_name, last_name
     FROM sdr_prospects
     WHERE id = $1
     LIMIT 1`,
    prospectId,
  );

  if (!prospectRows || prospectRows.length === 0) {
    return { status: 404, body: `Prospect ${prospectId} not found` };
  }

  const prospect = prospectRows[0] as {
    id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
  };

  // Attempt preferred provider first, fall back to the other.
  const providerOrder: CalendarProvider[] =
    preferredProvider === "calendly"
      ? ["calendly", "google_calendar"]
      : ["google_calendar", "calendly"];

  let lastError: string | null = null;

  for (const provider of providerOrder) {
    const token = await fetchOAuthToken(ctx, provider);
    if (!token) continue;

    let accessToken = token.access_token;

    // Refresh stale Google tokens.
    if (
      provider === "google_calendar" &&
      token.refresh_token &&
      token.expires_at &&
      new Date(token.expires_at) <= new Date()
    ) {
      const refreshed = await refreshGoogleToken(token.refresh_token);
      if (refreshed) {
        accessToken = refreshed;
        await ctx.db.execute(
          `UPDATE oauth_tokens
           SET access_token = $2, expires_at = $3, updated_at = NOW()
           WHERE provider = $1 AND owner_user_id = $4`,
          provider,
          refreshed,
          new Date(Date.now() + 3600 * 1000).toISOString(),
          token.owner_user_id,
        );
      }
    }

    try {
      if (provider === "google_calendar") {
        if (!prospect.email) {
          lastError = "Prospect has no email address for Google Calendar invite";
          continue;
        }

        const result = await createGoogleCalendarEvent(
          accessToken,
          prospect.email,
          title,
          startTime,
          endTime,
          description,
        );

        if (!result) {
          lastError = "Google Calendar returned no event data";
          continue;
        }

        const bookedAt = new Date().toISOString();
        const meetingId = await insertBookedMeeting(ctx, {
          prospect_id: prospectId,
          provider: "google_calendar",
          calendar_event_id: result.eventId,
          calendar_event_link: result.htmlLink,
          booking_url: null,
          meeting_title: title,
          start_time: startTime,
          end_time: endTime,
          attendee_email: prospect.email,
          meet_link: result.meetLink,
          status: "confirmed",
          booked_at: bookedAt,
        });

        await ctx.events.publish("meeting.booked", {
          meeting_id: meetingId,
          prospect_id: prospectId,
          provider: "google_calendar",
          calendar_event_id: result.eventId,
          start_time: startTime,
          booked_at: bookedAt,
        });

        return {
          status: 200,
          body: {
            meeting_id: meetingId,
            provider: "google_calendar",
            calendar_event_id: result.eventId,
            calendar_event_link: result.htmlLink,
            meet_link: result.meetLink,
            start_time: startTime,
            end_time: endTime,
            status: "confirmed",
          },
        };
      }

      if (provider === "calendly") {
        const result = await createCalendlySchedulingLink(accessToken, 1);

        if (!result) {
          lastError = "Calendly returned no scheduling link";
          continue;
        }

        const bookedAt = new Date().toISOString();
        const meetingId = await insertBookedMeeting(ctx, {
          prospect_id: prospectId,
          provider: "calendly",
          calendar_event_id: null,
          calendar_event_link: null,
          booking_url: result.bookingUrl,
          meeting_title: title,
          start_time: startTime,
          end_time: endTime,
          attendee_email: prospect.email,
          meet_link: null,
          status: "link_sent",
          booked_at: bookedAt,
        });

        await ctx.events.publish("meeting.booked", {
          meeting_id: meetingId,
          prospect_id: prospectId,
          provider: "calendly",
          booking_url: result.bookingUrl,
          start_time: startTime,
          booked_at: bookedAt,
        });

        return {
          status: 200,
          body: {
            meeting_id: meetingId,
            provider: "calendly",
            booking_url: result.bookingUrl,
            start_time: startTime,
            end_time: endTime,
            status: "link_sent",
          },
        };
      }
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    status: 503,
    body: `Unable to book meeting — no configured calendar provider succeeded. Last error: ${lastError ?? "no OAuth tokens found"}`,
  };
}
