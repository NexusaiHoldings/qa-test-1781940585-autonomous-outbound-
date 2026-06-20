/**
 * /campaigns — All campaigns listing for the current org.
 *
 * Shows all SDR campaigns with their status, prospect counts, and a link
 * to the pipeline dashboard for detailed metrics. Primary entry point for
 * campaign management.
 *
 * Feature: F1-009 (Campaign Pipeline Dashboard)
 */
import type { JSX } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import { getCampaignMetrics, getOrgIdForUser } from "@/lib/sdr/pipeline-metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: "Active",
    paused: "Paused",
    completed: "Completed",
    draft: "Draft",
    archived: "Archived",
  };
  return labels[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function CampaignsPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const orgId = await getOrgIdForUser(user.id);
  const campaigns = await getCampaignMetrics(orgId);

  const activeCampaigns = campaigns.filter((c) => c.status === "active");
  const otherCampaigns = campaigns.filter((c) => c.status !== "active");

  return (
    <main>
      <h1>Campaigns</h1>
      <p>
        Manage your outbound SDR campaigns. View the{" "}
        <a href="/pipeline">pipeline dashboard</a> for aggregate metrics across
        all campaigns.
      </p>

      {campaigns.length === 0 ? (
        <div className="empty">
          <p>
            No campaigns found. Create your first outbound campaign to begin
            enriching prospects and booking meetings.
          </p>
        </div>
      ) : (
        <>
          {activeCampaigns.length > 0 && (
            <>
              <h2>Active ({activeCampaigns.length})</h2>
              <table>
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Enriched</th>
                    <th>Emails</th>
                    <th>Open Rate</th>
                    <th>Reply Rate</th>
                    <th>Meetings</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {activeCampaigns.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                      </td>
                      <td>{c.prospectsEnriched}</td>
                      <td>{c.emailsSent}</td>
                      <td>{c.openRate}%</td>
                      <td>{c.replyRate}%</td>
                      <td>{c.meetingsBooked}</td>
                      <td className="muted">{formatDate(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {otherCampaigns.length > 0 && (
            <>
              <h2>All Campaigns</h2>
              <table>
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Status</th>
                    <th>Enriched</th>
                    <th>Emails</th>
                    <th>Meetings</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {otherCampaigns.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                      </td>
                      <td>
                        <span className="muted">{statusLabel(c.status)}</span>
                      </td>
                      <td>{c.prospectsEnriched}</td>
                      <td>{c.emailsSent}</td>
                      <td>{c.meetingsBooked}</td>
                      <td className="muted">{formatDate(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <p>
            <a href="/pipeline" className="btn secondary">
              View Pipeline Dashboard
            </a>
          </p>
        </>
      )}
    </main>
  );
}
