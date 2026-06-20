/**
 * /campaigns/[id]/replies — displays inbound replies for a campaign,
 * showing each reply's AI classification and the action that was dispatched.
 *
 * Server component — no 'use client' needed; data is fetched at render time.
 */

import type { CSSProperties } from "react";
import {
  getPool,
  ensureSchema,
  getRepliesForCampaign,
} from "@/lib/sdr/sequence-engine";
import type { ReplyRow } from "@/lib/sdr/sequence-engine";

interface PageProps {
  params: { id: string };
}

const CLASSIFICATION_LABELS: Record<string, string> = {
  interested: "Interested",
  objection: "Objection",
  unsubscribe: "Unsubscribe",
  legal_threat: "Legal Threat",
};

const BASE_BADGE: CSSProperties = {
  padding: "2px 8px",
  borderRadius: "4px",
  fontSize: "0.8em",
};

function classificationBadgeStyle(classification: string | null): CSSProperties {
  switch (classification) {
    case "interested":
      return { ...BASE_BADGE, color: "#166534", background: "#dcfce7", fontWeight: 600 };
    case "objection":
      return { ...BASE_BADGE, color: "#92400e", background: "#fef3c7", fontWeight: 600 };
    case "unsubscribe":
      return { ...BASE_BADGE, color: "#374151", background: "#f3f4f6", fontWeight: 600 };
    case "legal_threat":
      return { ...BASE_BADGE, color: "#991b1b", background: "#fee2e2", fontWeight: 600 };
    default:
      return { ...BASE_BADGE, color: "#6b7280", background: "#f9fafb" };
  }
}

function formatAction(action: string | null): string {
  if (!action || action === "none") return "—";
  if (action.startsWith("legal_threat_escalated:"))
    return `Escalated (ticket ${action.split(":")[1]})`;
  if (action.startsWith("founder_ticket_created:"))
    return `Founder notified (ticket ${action.split(":")[1]})`;
  if (action === "followup_scheduled") return "Follow-up scheduled";
  if (action === "prospect_suppressed") return "Prospect suppressed";
  if (action === "unknown_sender_unsubscribe") return "Unsubscribe noted (unknown sender)";
  if (action === "objection_no_prospect") return "Objection logged (unmatched sender)";
  return action.replace(/_/g, " ");
}

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function fetchReplies(campaignId: string): Promise<ReplyRow[]> {
  const pool = getPool();
  await ensureSchema(pool);
  return getRepliesForCampaign(campaignId, pool);
}

export default async function CampaignRepliesPage({ params }: PageProps) {
  const { id: campaignId } = params;

  let replies: ReplyRow[];
  try {
    replies = await fetchReplies(campaignId);
  } catch {
    return (
      <main>
        <h1>Campaign Replies</h1>
        <p>AI-classified inbound replies with autonomous dispatch actions.</p>
        <div className="card">
          <p>Unable to load replies. Check your database connection and try again.</p>
        </div>
      </main>
    );
  }

  const total = replies.length;
  const byClass = replies.reduce<Record<string, number>>((acc, r) => {
    const key = r.classification ?? "unclassified";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main>
      <h1>Campaign Replies</h1>
      <p>
        Inbound prospect replies are classified by AI and actioned automatically —
        follow-ups for objections, founder escalation for interest, and instant
        suppression for unsubscribes.
      </p>

      {total > 0 && (
        <div className="toolbar" style={{ marginBottom: "1.5rem" }}>
          <div className="card" style={{ padding: "0.75rem 1.25rem" }}>
            <strong>{total}</strong>{" "}
            <span className="muted">total replies</span>
          </div>
          {Object.entries(byClass).map(([cls, count]) => (
            <div key={cls} className="card" style={{ padding: "0.75rem 1.25rem" }}>
              <strong>{count}</strong>{" "}
              <span className="muted">{CLASSIFICATION_LABELS[cls] ?? cls}</span>
            </div>
          ))}
        </div>
      )}

      {replies.length === 0 ? (
        <div className="empty">
          <p>No replies yet.</p>
          <p className="muted">
            Inbound prospect replies will appear here once received and classified.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>From</th>
              <th>Subject</th>
              <th>Classification</th>
              <th>Confidence</th>
              <th>Reasoning</th>
              <th>Action Taken</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {replies.map((reply) => (
              <tr key={reply.id}>
                <td>{reply.from_email}</td>
                <td className="muted">{reply.subject ?? "—"}</td>
                <td>
                  <span style={classificationBadgeStyle(reply.classification)}>
                    {CLASSIFICATION_LABELS[reply.classification ?? ""] ??
                      (reply.classification ?? "unclassified")}
                  </span>
                </td>
                <td className="muted">
                  {reply.confidence !== null && reply.confidence !== undefined
                    ? `${Math.round(reply.confidence * 100)}%`
                    : "—"}
                </td>
                <td
                  className="muted"
                  style={{ maxWidth: "240px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={reply.reasoning ?? ""}
                >
                  {reply.reasoning ?? "—"}
                </td>
                <td>{formatAction(reply.dispatched_action)}</td>
                <td className="muted">{formatDate(reply.received_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="muted" style={{ marginTop: "2rem", fontSize: "0.8em" }}>
        Campaign ID: {campaignId}
      </p>
    </main>
  );
}
