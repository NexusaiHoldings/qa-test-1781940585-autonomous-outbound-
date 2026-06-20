/**
 * /settings/calendar — SDR Google Calendar + Calendly connection settings.
 *
 * Server component. Handles Google OAuth callback when ?code=...&state=...
 * are present in the URL (Google redirects here after authorization).
 *
 * Server Actions:
 *   connectGoogleCalendar  — redirects to Google OAuth consent screen
 *   disconnectGoogle       — revokes + clears stored tokens
 *   saveCalendlySettings   — persists encrypted Calendly API key + event URL
 */

import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import {
  generateGoogleAuthUrl,
  exchangeGoogleAuthCode,
  getCalendarSettings,
  saveCalendlyConfig,
  disconnectGoogleCalendar,
  getOrgIdForUser,
  type CalendarSettings,
} from "@/lib/sdr/calendar-connector";

// ── Helpers ────────────────────────────────────────────────────────────────────

async function requireOrgId(userId: string): Promise<string> {
  const orgId = await getOrgIdForUser(userId);
  if (!orgId) throw new Error("no_org");
  return orgId;
}

// ── Page ───────────────────────────────────────────────────────────────────────

interface PageProps {
  searchParams: {
    code?: string;
    state?: string;
    error?: string;
    connected?: string;
    saved?: string;
    disconnected?: string;
  };
}

export default async function CalendarSettingsPage({
  searchParams,
}: PageProps) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  let orgId: string;
  try {
    orgId = await requireOrgId(user.id);
  } catch {
    return (
      <main>
        <h1>Calendar Integration</h1>
        <p>Connect your calendar to automatically book meetings with interested prospects.</p>
        <div className="empty">
          <p>You must be a member of an organization to configure calendar integrations.</p>
          <a href="/org/new" className="btn">
            Create Organization
          </a>
        </div>
      </main>
    );
  }

  // ── Handle Google OAuth callback ──────────────────────────────────────────
  if (searchParams.code && searchParams.state) {
    try {
      await exchangeGoogleAuthCode(searchParams.code, orgId);
    } catch (err) {
      console.error("[calendar] OAuth code exchange failed:", err);
      redirect("/settings/calendar?error=google_auth_failed");
    }
    redirect("/settings/calendar?connected=google");
  }

  // ── Load settings ─────────────────────────────────────────────────────────
  let settings: CalendarSettings;
  try {
    settings = await getCalendarSettings(orgId);
  } catch (err) {
    console.error("[calendar] failed to load settings:", err);
    settings = {
      orgId,
      googleConnected: false,
      googleTokenExpiresAt: null,
      calendlyConnected: false,
      calendlyEventTypeUrl: null,
    };
  }

  // ── Server Actions ────────────────────────────────────────────────────────

  async function connectGoogleCalendar(): Promise<void> {
    "use server";
    const currentUser = await getSessionUser();
    if (!currentUser) redirect("/login");
    const currentOrgId = await getOrgIdForUser(currentUser.id);
    if (!currentOrgId) redirect("/settings/calendar?error=no_org");
    const authUrl = generateGoogleAuthUrl(currentOrgId);
    redirect(authUrl);
  }

  async function disconnectGoogle(): Promise<void> {
    "use server";
    const currentUser = await getSessionUser();
    if (!currentUser) redirect("/login");
    const currentOrgId = await getOrgIdForUser(currentUser.id);
    if (!currentOrgId) return;
    await disconnectGoogleCalendar(currentOrgId);
    redirect("/settings/calendar?disconnected=google");
  }

  async function saveCalendlySettings(formData: FormData): Promise<void> {
    "use server";
    const currentUser = await getSessionUser();
    if (!currentUser) redirect("/login");
    const currentOrgId = await getOrgIdForUser(currentUser.id);
    if (!currentOrgId) return;
    const apiKey = (formData.get("calendlyApiKey") as string | null) ?? "";
    const eventTypeUrl =
      (formData.get("calendlyEventTypeUrl") as string | null) ?? "";
    if (!apiKey.trim() || !eventTypeUrl.trim()) {
      redirect("/settings/calendar?error=calendly_missing_fields");
      return;
    }
    await saveCalendlyConfig(currentOrgId, apiKey.trim(), eventTypeUrl.trim());
    redirect("/settings/calendar?saved=calendly");
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const googleExpiry = settings.googleTokenExpiresAt
    ? settings.googleTokenExpiresAt.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <main>
      <h1>Calendar Integration</h1>
      <p>
        Connect Google Calendar or Calendly so confirmed meetings are booked
        automatically — no manual scheduling required.
      </p>

      {/* ── Status banners ── */}
      {searchParams.connected === "google" && (
        <div className="card" style={{ borderColor: "#22c55e" }}>
          <strong>Google Calendar connected.</strong> New confirmed meetings
          will be added to your primary calendar automatically.
        </div>
      )}
      {searchParams.saved === "calendly" && (
        <div className="card" style={{ borderColor: "#22c55e" }}>
          <strong>Calendly settings saved.</strong> Booking links will use this
          event type.
        </div>
      )}
      {searchParams.disconnected === "google" && (
        <div className="card">
          <strong>Google Calendar disconnected.</strong> Tokens have been
          revoked.
        </div>
      )}
      {searchParams.error === "google_auth_failed" && (
        <div className="card" style={{ borderColor: "#ef4444" }}>
          <strong>Google authorization failed.</strong> Please try again.
        </div>
      )}
      {searchParams.error === "calendly_missing_fields" && (
        <div className="card" style={{ borderColor: "#ef4444" }}>
          <strong>Missing fields.</strong> Please provide both an API key and
          event type URL.
        </div>
      )}

      {/* ── Google Calendar ── */}
      <section className="card">
        <h2>Google Calendar</h2>
        <p className="muted">
          When a meeting is confirmed, it will be created on the
          founder&apos;s primary Google Calendar and the prospect will receive
          an invite.
        </p>

        {settings.googleConnected ? (
          <>
            <p>
              <strong>Status:</strong>{" "}
              <span style={{ color: "#22c55e" }}>Connected</span>
              {googleExpiry && (
                <span className="muted"> · token expires {googleExpiry}</span>
              )}
            </p>
            <form action={disconnectGoogle}>
              <button type="submit" className="btn secondary">
                Disconnect Google Calendar
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="muted">
              Not connected. Click below to authorize access to your Google
              Calendar.
            </p>
            <form action={connectGoogleCalendar}>
              <button type="submit" className="btn">
                Connect Google Calendar
              </button>
            </form>
          </>
        )}
      </section>

      {/* ── Calendly ── */}
      <section className="card">
        <h2>Calendly</h2>
        <p className="muted">
          Provide your Calendly Personal Access Token and the event type URL to
          generate single-use booking links for each interested prospect.
        </p>

        <form action={saveCalendlySettings}>
          <label htmlFor="calendlyApiKey">
            <strong>Personal Access Token</strong>
            <br />
            <span className="muted">
              Found in Calendly → Integrations → API &amp; Webhooks
            </span>
          </label>
          <input
            id="calendlyApiKey"
            name="calendlyApiKey"
            type="password"
            placeholder={
              settings.calendlyConnected ? "••••••••  (saved)" : "eyJhbGci..."
            }
            autoComplete="off"
            style={{ width: "100%", marginTop: "4px" }}
          />

          <label
            htmlFor="calendlyEventTypeUrl"
            style={{ marginTop: "16px", display: "block" }}
          >
            <strong>Event Type URL</strong>
            <br />
            <span className="muted">
              e.g. https://api.calendly.com/event_types/AAAA…
            </span>
          </label>
          <input
            id="calendlyEventTypeUrl"
            name="calendlyEventTypeUrl"
            type="url"
            defaultValue={settings.calendlyEventTypeUrl ?? ""}
            placeholder="https://api.calendly.com/event_types/..."
            style={{ width: "100%", marginTop: "4px" }}
          />

          <button type="submit" className="btn" style={{ marginTop: "16px" }}>
            {settings.calendlyConnected ? "Update Calendly Settings" : "Save Calendly Settings"}
          </button>

          {settings.calendlyConnected && (
            <p style={{ marginTop: "8px" }}>
              <span style={{ color: "#22c55e" }}>✓ Calendly connected</span>
            </p>
          )}
        </form>
      </section>

      {/* ── Webhook info ── */}
      <section className="card">
        <h2>Calendly Webhook</h2>
        <p className="muted">
          Register this URL in Calendly → Integrations → Webhooks to
          automatically record new bookings:
        </p>
        <code style={{ wordBreak: "break-all" }}>
          {process.env.APP_BASE_URL ?? "https://your-domain.com"}
          /api/webhooks/calendly
        </code>
        <p className="muted" style={{ marginTop: "8px" }}>
          Set <strong>CALENDLY_WEBHOOK_SIGNING_KEY</strong> in your environment
          to the signing secret shown when you create the webhook subscription.
        </p>
      </section>
    </main>
  );
}
