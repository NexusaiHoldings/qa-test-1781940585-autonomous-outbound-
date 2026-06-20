export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { notFound } from "next/navigation";
import { getProspectById, ensureProspectsTable } from "@/lib/sdr/enrichment-provider";

interface NewsArticle {
  title: string;
  description: string | null;
  url: string;
  publishedAt: string;
  source: string;
}

interface PageProps {
  params: { id: string };
}

export default async function ProspectDetailPage({ params }: PageProps) {
  await ensureProspectsTable();
  const prospect = await getProspectById(params.id);

  if (!prospect) {
    notFound();
  }

  const newsPayload = prospect.context_payload?.news as
    | { articles?: NewsArticle[] }
    | undefined;
  const articles: NewsArticle[] = newsPayload?.articles ?? [];

  return (
    <main>
      <p>
        <a href="/prospects">← Back to Prospects</a>
      </p>
      <h1>{prospect.company_name}</h1>
      <p>
        {[prospect.industry, prospect.country, prospect.city]
          .filter(Boolean)
          .join(" · ")}
      </p>

      <div className="card">
        <h2>Company Details</h2>
        <table>
          <tbody>
            <tr>
              <th>Domain</th>
              <td>{prospect.domain ?? "—"}</td>
            </tr>
            <tr>
              <th>Employees</th>
              <td>
                {prospect.employee_count !== null
                  ? prospect.employee_count.toLocaleString()
                  : "—"}
              </td>
            </tr>
            <tr>
              <th>Annual Revenue</th>
              <td>
                {prospect.annual_revenue !== null
                  ? `$${(prospect.annual_revenue / 1_000_000).toFixed(1)}M`
                  : "—"}
              </td>
            </tr>
            <tr>
              <th>Website</th>
              <td>
                {prospect.website_url ? (
                  <a
                    href={prospect.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {prospect.website_url}
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
            <tr>
              <th>LinkedIn</th>
              <td>
                {prospect.linkedin_url ? (
                  <a
                    href={prospect.linkedin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {prospect.linkedin_url}
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
            <tr>
              <th>Status</th>
              <td>{prospect.enrichment_status}</td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{new Date(prospect.created_at).toLocaleString()}</td>
            </tr>
            <tr>
              <th>Enriched At</th>
              <td>
                {prospect.enriched_at
                  ? new Date(prospect.enriched_at).toLocaleString()
                  : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {prospect.enrichment_status === "failed" && prospect.enrichment_error && (
        <div className="card">
          <h2>Enrichment Error</h2>
          <p className="muted">{prospect.enrichment_error}</p>
        </div>
      )}

      {articles.length > 0 && (
        <div className="card">
          <h2>Recent News</h2>
          <ul>
            {articles.map((article, idx) => (
              <li key={idx}>
                <a
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {article.title}
                </a>
                <span className="muted">
                  {" "}
                  · {article.source} ·{" "}
                  {new Date(article.publishedAt).toLocaleDateString()}
                </span>
                {article.description && (
                  <p className="muted">{article.description}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {prospect.context_payload && (
        <details>
          <summary className="muted">Raw context payload (RAG context)</summary>
          <pre>{JSON.stringify(prospect.context_payload, null, 2)}</pre>
        </details>
      )}
    </main>
  );
}
