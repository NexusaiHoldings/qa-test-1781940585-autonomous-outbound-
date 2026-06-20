/**
 * /pipeline — Campaign Pipeline Dashboard.
 *
 * Founder-facing surface showing all active campaigns with real-time
 * metrics: prospects enriched, emails sent, open rate, reply rate,
 * meetings booked. Reads across all sdr_ tables for the current org.
 *
 * Feature: F1-009 (Campaign Pipeline Dashboard)
 */
import type { JSX } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import {
  getCampaignMetrics,
  getPipelineSummary,
  getOrgIdForUser,
} from "@/lib/sdr/pipeline-metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default async function PipelinePage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const orgId = await getOrgIdForUser(user.id);
  const [campaigns, summary] = await Promise.all([
    getCampaignMetrics(orgId),
    getPipelineSummary(orgId),
  ]);

  return (
    <main>
      <h1>Campaign Pipeline</h1>
      <p>
        Real-time view of all active outbound campaigns — prospects enriched,
        emails delivered, open rate, reply rate, and meetings booked.
      </p>

      <section aria-label="Pipeline summary">
        <ul style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "1rem", listStyle: "none", padding: 0, margin: "1.5rem 0" }}>
          <li className="card">
            <div className="muted">Active Campaigns</div>
            <strong style={{ fontSize: "1.75rem", display: "block" }}>
              {summary.activeCampaigns}
            </strong>
            <div className="muted">of {summary.totalCampaigns} total</div>
          </li>
          <li className="card">
            <div className="muted">Prospects Enriched</div>
            <strong style={{ fontSize: "1.75rem", display: "block" }}>
              {summary.totalProspectsEnriched}
            </strong>
          </li>
          <li className="card">
            <div className="muted">Emails Sent</div>
            <strong style={{ fontSize: "1.75rem", display: "block" }}>
              {summary.totalEmailsSent}
            </strong>
          </li>
          <li className="card">
            <div className="muted">Open Rate</div>
            <strong style={{ fontSize: "1.75rem", display: "block" }}>
              {summary.overallOpenRate}%
            </strong>
          </li>
          <li className="card">
            <div className="muted">Reply Rate</div>
            <strong style={{ fontSize: "1.75rem", display: "block" }}>
              {summary.overallReplyRate}%
            </strong>
          </li>
          <li className="card">
            <div className="muted">Meetings Booked</div>
            <strong style={{ fontSize: "1.75rem", display: "block" }}>
              {summary.totalMeetingsBooked}
            </strong>
          </li>
        </ul>
      </section>

      <h2>Campaign Breakdown</h2>

      {campaigns.length === 0 ? (
        <div className="empty">
          <p>
            No campaigns yet. Launch your first outbound campaign to start
            tracking pipeline metrics here.
          </p>
          <a href="/campaigns" className="btn">
            Go to Campaigns
          </a>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Status</th>
              <th>Enriched</th>
              <th>Emails Sent</th>
              <th>Open Rate</th>
              <th>Reply Rate</th>
              <th>Meetings</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td>
                  <strong>{c.name}</strong>
                </td>
                <td>
                  <span className="muted">{statusLabel(c.status)}</span>
                </td>
                <td>{c.prospectsEnriched}</td>
                <td>{c.emailsSent}</td>
                <td>{c.openRate}%</td>
                <td>{c.replyRate}%</td>
                <td>
                  {c.meetingsBooked > 0 ? (
                    <strong>{c.meetingsBooked}</strong>
                  ) : (
                    c.meetingsBooked
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
