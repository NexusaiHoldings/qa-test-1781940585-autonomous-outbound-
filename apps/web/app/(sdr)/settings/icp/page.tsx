/**
 * /settings/icp — global ICP targeting configuration.
 *
 * Founder-facing page (F1-002). Shows the default ICP filter template
 * (stored with campaign_id IS NULL) that pre-populates new campaigns, and
 * lists all campaigns with their per-campaign ICP filter settings.
 */
import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { buildDb } from "@/lib/db";
import {
  validateIcpFilter,
  parseKeywordsFromString,
  ALLOWED_VERTICALS,
  ALLOWED_GEOGRAPHIES,
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

interface IcpRow {
  id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_status: string | null;
  industry_verticals: string[];
  headcount_min: number;
  headcount_max: number;
  geographies: string[];
  title_keywords: string[];
  updated_at: string;
}

async function saveDefaultIcpAction(formData: FormData): Promise<void> {
  "use server";

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
    redirect(`/settings/icp?error=${msg}`);
  }

  const db = buildDb();
  await db.execute(CAMPAIGN_DDL);
  await db.execute(ICP_FILTER_DDL);

  const existing = await db.query<{ id: string }>(
    "SELECT id FROM sdr_icp_filters WHERE campaign_id IS NULL LIMIT 1",
  );

  if (existing.length > 0) {
    await db.execute(
      `UPDATE sdr_icp_filters
       SET industry_verticals = $1::jsonb,
           headcount_min      = $2,
           headcount_max      = $3,
           title_keywords     = $4::jsonb,
           updated_at         = now()
       WHERE campaign_id IS NULL`,
      JSON.stringify(verticals),
      headcountMin,
      headcountMax,
      JSON.stringify(titleKeywords),
    );
  } else {
    await db.execute(
      `INSERT INTO sdr_icp_filters
         (campaign_id, industry_verticals, headcount_min, headcount_max, geographies, title_keywords)
       VALUES (NULL, $1::jsonb, $2, $3, $4::jsonb, $5::jsonb)`,
      JSON.stringify(verticals),
      headcountMin,
      headcountMax,
      JSON.stringify(["US"]),
      JSON.stringify(titleKeywords),
    );
  }

  redirect("/settings/icp?saved=1");
}

interface PageProps {
  searchParams: { error?: string; saved?: string; created?: string };
}

export default async function IcpSettingsPage({
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const db = buildDb();

  let defaultIcp: IcpRow | null = null;
  let campaignIcps: IcpRow[] = [];

  try {
    await db.execute(CAMPAIGN_DDL);
    await db.execute(ICP_FILTER_DDL);

    const defaultRows = await db.query<IcpRow>(
      `SELECT f.id, f.campaign_id, NULL::text AS campaign_name, NULL::text AS campaign_status,
              f.industry_verticals, f.headcount_min, f.headcount_max,
              f.geographies, f.title_keywords,
              f.updated_at::text AS updated_at
       FROM sdr_icp_filters f
       WHERE f.campaign_id IS NULL
       LIMIT 1`,
    );
    defaultIcp = defaultRows[0] ?? null;

    campaignIcps = await db.query<IcpRow>(
      `SELECT f.id, f.campaign_id, c.name AS campaign_name, c.status AS campaign_status,
              f.industry_verticals, f.headcount_min, f.headcount_max,
              f.geographies, f.title_keywords,
              f.updated_at::text AS updated_at
       FROM sdr_icp_filters f
       JOIN sdr_campaigns c ON c.id = f.campaign_id
       ORDER BY f.created_at DESC`,
    );
  } catch {
    // Tables don't exist yet — first-run scenario; render empty state.
  }

  const defaultVerticals: string[] =
    defaultIcp?.industry_verticals ?? [...ALLOWED_VERTICALS];
  const defaultMin = defaultIcp?.headcount_min ?? 1;
  const defaultMax = defaultIcp?.headcount_max ?? 10;
  const defaultKeywords: string[] = defaultIcp?.title_keywords ?? [];

  return (
    <main>
      <h1>ICP Settings</h1>
      <p>
        Configure the Ideal Customer Profile used across your SDR campaigns.
        This default template pre-populates the filter when you create a new
        campaign.
      </p>

      {searchParams.saved && (
        <p style={{ color: "var(--substrate-success)", margin: "1rem 0" }}>
          Default ICP saved.
        </p>
      )}
      {searchParams.created && (
        <p style={{ color: "var(--substrate-success)", margin: "1rem 0" }}>
          Campaign created with ICP filter.
        </p>
      )}
      {searchParams.error && (
        <p
          role="alert"
          style={{ color: "var(--substrate-danger)", margin: "1rem 0" }}
        >
          {searchParams.error}
        </p>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1.5rem" }}>
        <Link href="/campaigns/new" className="btn">
          + New Campaign
        </Link>
      </div>

      <section style={{ maxWidth: "640px", marginBottom: "2.5rem" }}>
        <h2>Default ICP Template</h2>
        <p className="muted">
          Applies to all new campaigns unless overridden per-campaign.
        </p>

        <form
          action={saveDefaultIcpAction}
          style={{ marginTop: "1rem" }}
        >
          <div className="card" style={{ marginBottom: "1rem" }}>
            <fieldset style={{ border: "none", padding: 0, marginBottom: "1.25rem" }}>
              <legend style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
                Industry Verticals
              </legend>
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
                    defaultChecked={defaultVerticals.includes(v)}
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
                1–10 employees (primary segment cap).
              </p>
              <div style={{ display: "flex", gap: "1.5rem" }}>
                <div>
                  <label htmlFor="icp-min">Min employees</label>
                  <input
                    id="icp-min"
                    name="headcount_min"
                    type="number"
                    min={1}
                    max={10}
                    defaultValue={defaultMin}
                    required
                    style={{ width: "80px", marginTop: "0.25rem" }}
                  />
                </div>
                <div>
                  <label htmlFor="icp-max">Max employees</label>
                  <input
                    id="icp-max"
                    name="headcount_max"
                    type="number"
                    min={1}
                    max={10}
                    defaultValue={defaultMax}
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
                {ALLOWED_GEOGRAPHIES.join(", ")} — US only at MVP scope
                (CAN-SPAM compliance).
              </p>
            </div>

            <div>
              <label htmlFor="icp-keywords" style={{ fontWeight: 600 }}>
                Job Title Keywords
              </label>
              <p className="muted" style={{ marginBottom: "0.25rem" }}>
                Comma-separated — e.g. owner, partner, managing director
              </p>
              <textarea
                id="icp-keywords"
                name="title_keywords"
                rows={3}
                defaultValue={defaultKeywords.join(", ")}
                placeholder="owner, partner, principal, director"
                required
                style={{ width: "100%", marginTop: "0.25rem" }}
              />
            </div>
          </div>

          <button type="submit">Save Default ICP</button>
        </form>
      </section>

      <section>
        <h2>Campaign ICP Configurations</h2>
        {campaignIcps.length === 0 ? (
          <div className="empty">
            <p>No campaigns yet.</p>
            <Link href="/campaigns/new" className="btn">
              Create your first campaign
            </Link>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>Verticals</th>
                <th>Headcount</th>
                <th>Title Keywords</th>
              </tr>
            </thead>
            <tbody>
              {campaignIcps.map((row) => (
                <tr key={row.id}>
                  <td>{row.campaign_name ?? "—"}</td>
                  <td>
                    <span className="muted">{row.campaign_status ?? "draft"}</span>
                  </td>
                  <td>
                    {Array.isArray(row.industry_verticals)
                      ? row.industry_verticals.join(", ")
                      : "—"}
                  </td>
                  <td>
                    {row.headcount_min}–{row.headcount_max}
                  </td>
                  <td className="muted">
                    {Array.isArray(row.title_keywords)
                      ? row.title_keywords.join(", ")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
