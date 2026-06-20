/**
 * /campaigns/[id]/emails — list all email drafts for a campaign.
 *
 * Server component: renders draft list with status badges.
 * Founder can click a draft to review and approve it.
 */
import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { listEmailDrafts, type EmailDraft } from "@/lib/sdr/email-composer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  queued: "Queued",
  sent: "Sent",
};

const STATUS_STYLES: Record<string, string> = {
  draft: "background:#fef9c3;color:#854d0e;",
  approved: "background:#dcfce7;color:#166534;",
  queued: "background:#dbeafe;color:#1e40af;",
  sent: "background:#f3f4f6;color:#374151;",
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export default async function CampaignEmailsPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  if (!params.id) redirect("/");

  let drafts: EmailDraft[] = [];
  let loadError = "";
  try {
    drafts = await listEmailDrafts(params.id);
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Failed to load drafts";
  }

  const draftCount = drafts.filter((d) => d.status === "draft").length;
  const queuedCount = drafts.filter((d) => d.status === "queued").length;

  return (
    <main>
      <h1>Email Drafts</h1>
      <p>
        Campaign <code>{params.id}</code> — {drafts.length} draft
        {drafts.length !== 1 ? "s" : ""} total
        {draftCount > 0 && ` · ${draftCount} awaiting review`}
        {queuedCount > 0 && ` · ${queuedCount} queued to send`}
      </p>

      <p>
        <Link
          href={`/campaigns/${encodeURIComponent(params.id)}`}
          className="btn secondary"
        >
          ← Back to Campaign
        </Link>
      </p>

      {loadError && (
        <div className="card" style={{ borderColor: "#fca5a5" }}>
          <p style={{ color: "#b91c1c" }}>Error loading drafts: {loadError}</p>
        </div>
      )}

      {!loadError && drafts.length === 0 && (
        <div className="empty">
          <p>No email drafts yet for this campaign.</p>
          <p className="muted">
            Use the GPT-4o email composer to generate personalized drafts from
            enriched prospect profiles.
          </p>
        </div>
      )}

      {drafts.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Prospect</th>
              <th>Subject</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((draft) => (
              <tr key={draft.id}>
                <td>
                  <strong>{draft.prospect_name}</strong>
                  <br />
                  <span className="muted">{draft.prospect_email}</span>
                </td>
                <td>{draft.subject}</td>
                <td>
                  <span
                    style={{
                      ...(STATUS_STYLES[draft.status]
                        ? Object.fromEntries(
                            STATUS_STYLES[draft.status]
                              .split(";")
                              .filter(Boolean)
                              .map((p) => p.split(":").map((s) => s.trim())),
                          )
                        : {}),
                      display: "inline-block",
                      padding: "2px 8px",
                      borderRadius: "9999px",
                      fontSize: "0.75rem",
                      fontWeight: 500,
                    }}
                  >
                    {STATUS_LABELS[draft.status] ?? draft.status}
                  </span>
                </td>
                <td className="muted">{formatDate(draft.created_at)}</td>
                <td>
                  <Link
                    href={`/campaigns/${encodeURIComponent(params.id)}/emails/${encodeURIComponent(draft.id)}`}
                    className="btn secondary"
                  >
                    {draft.status === "draft" ? "Review" : "View"}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
