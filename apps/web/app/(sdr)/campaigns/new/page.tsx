/**
 * /campaigns/new — create a new SDR campaign with ICP targeting filter.
 *
 * Founder-facing page (F1-002). Collects campaign name + ICP parameters
 * (industry vertical, headcount range, geography, job-title keywords) and
 * writes to sdr_campaigns + sdr_icp_filters via a server action.
 */
import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { buildDb } from "@/lib/db";
import {
  validateIcpFilter,
  parseKeywordsFromString,
  ALLOWED_VERTICALS,
} from "@/lib/sdr/icp-validator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CAMPAIGN_DDL = `
  CREATE TABLE IF NOT EXISTS sdr_campaigns (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text        NOT NULL,
    status     text        NOT NULL DEFAULT 'draft',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

const ICP_FILTER_DDL = `
  CREATE TABLE IF NOT EXISTS sdr_icp_filters (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id        uuid        REFERENCES sdr_campaigns(id) ON DELETE CASCADE,
    industry_verticals jsonb       NOT NULL DEFAULT '[]'::jsonb,
    headcount_min      integer     NOT NULL DEFAULT 1,
    headcount_max      integer     NOT NULL DEFAULT 10,
    geographies        jsonb       NOT NULL DEFAULT '["US"]'::jsonb,
    title_keywords     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
  )
`;

async function createCampaignAction(formData: FormData): Promise<void> {
  "use server";

  const name = ((formData.get("name") as string | null) ?? "").trim();
  const verticals = formData.getAll("verticals") as string[];
  const headcountMin = parseInt(
    (formData.get("headcount_min") as string | null) ?? "1",
    10,
  );
  const headcountMax = parseInt(
    (formData.get("headcount_max") as string | null) ?? "10",
    10,
  );
  const keywordsRaw = (formData.get("title_keywords") as string | null) ?? "";
  const titleKeywords = parseKeywordsFromString(keywordsRaw);

  if (!name) {
    redirect("/campaigns/new?error=Campaign+name+is+required");
  }

  const result = validateIcpFilter({
    industryVerticals: verticals,
    headcountMin,
    headcountMax,
    geographies: ["US"],
    titleKeywords,
  });

  if (!result.valid) {
    const msg = encodeURIComponent(
      result.errors.map((e) => e.message).join("; "),
    );
    redirect(`/campaigns/new?error=${msg}`);
  }

  const db = buildDb();
  await db.execute(CAMPAIGN_DDL);
  await db.execute(ICP_FILTER_DDL);

  const rows = await db.query<{ id: string }>(
    "INSERT INTO sdr_campaigns (name, status) VALUES ($1, $2) RETURNING id",
    name,
    "draft",
  );
  const campaignId = rows[0]?.id;
  if (!campaignId) {
    redirect("/campaigns/new?error=Database+error+creating+campaign");
  }

  await db.execute(
    `INSERT INTO sdr_icp_filters
       (campaign_id, industry_verticals, headcount_min, headcount_max, geographies, title_keywords)
     VALUES ($1, $2::jsonb, $3, $4, $5::jsonb, $6::jsonb)`,
    campaignId,
    JSON.stringify(verticals),
    headcountMin,
    headcountMax,
    JSON.stringify(["US"]),
    JSON.stringify(titleKeywords),
  );

  redirect("/settings/icp?created=1");
}

interface PageProps {
  searchParams: { error?: string };
}

export default async function NewCampaignPage({
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const errorMsg = searchParams.error ?? null;

  return (
    <main>
      <h1>New SDR Campaign</h1>
      <p>
        Define the Ideal Customer Profile to target the right prospects for
        this campaign.
      </p>

      {errorMsg && (
        <p
          role="alert"
          style={{ color: "var(--substrate-danger)", margin: "1rem 0" }}
        >
          {errorMsg}
        </p>
      )}

      <form action={createCampaignAction} style={{ maxWidth: "640px" }}>
        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <h2>Campaign Details</h2>
          <label htmlFor="camp-name">Campaign Name</label>
          <input
            id="camp-name"
            name="name"
            type="text"
            required
            placeholder="e.g. Q3 IT MSP Outreach"
            style={{ width: "100%", marginTop: "0.25rem" }}
          />
        </div>

        <div className="card" style={{ marginBottom: "1.5rem" }}>
          <h2>ICP Filter</h2>

          <fieldset
            style={{ border: "none", padding: 0, marginBottom: "1.25rem" }}
          >
            <legend style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
              Industry Vertical
            </legend>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Select all verticals this campaign should target.
            </p>
            {ALLOWED_VERTICALS.map((v) => (
              <label
                key={v}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginBottom: "0.4rem",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  name="verticals"
                  value={v}
                  defaultChecked
                />
                {v}
              </label>
            ))}
          </fieldset>

          <fieldset
            style={{ border: "none", padding: 0, marginBottom: "1.25rem" }}
          >
            <legend style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
              Company Headcount Range
            </legend>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Primary segment: 1–10 employees per CEO briefing.
            </p>
            <div style={{ display: "flex", gap: "1.5rem" }}>
              <div>
                <label htmlFor="headcount_min">Min employees</label>
                <input
                  id="headcount_min"
                  name="headcount_min"
                  type="number"
                  min={1}
                  max={10}
                  defaultValue={1}
                  required
                  style={{ width: "80px", marginTop: "0.25rem" }}
                />
              </div>
              <div>
                <label htmlFor="headcount_max">Max employees</label>
                <input
                  id="headcount_max"
                  name="headcount_max"
                  type="number"
                  min={1}
                  max={10}
                  defaultValue={10}
                  required
                  style={{ width: "80px", marginTop: "0.25rem" }}
                />
              </div>
            </div>
          </fieldset>

          <div style={{ marginBottom: "1.25rem" }}>
            <p style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
              Geography
            </p>
            <p className="muted">
              US only at MVP scope (CAN-SPAM compliance).
            </p>
          </div>

          <div>
            <label htmlFor="title_keywords" style={{ fontWeight: 600 }}>
              Job Title Keywords
            </label>
            <p className="muted" style={{ marginBottom: "0.25rem" }}>
              Comma-separated — e.g. owner, partner, managing director
            </p>
            <textarea
              id="title_keywords"
              name="title_keywords"
              rows={3}
              placeholder="owner, partner, principal, director"
              required
              style={{ width: "100%", marginTop: "0.25rem" }}
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <button type="submit">Create Campaign</button>
          <Link href="/settings/icp" className="btn secondary">
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
