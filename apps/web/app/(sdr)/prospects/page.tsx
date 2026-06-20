export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import {
  listProspects,
  countProspects,
  ensureProspectsTable,
} from "@/lib/sdr/enrichment-provider";

interface PageProps {
  searchParams: { [key: string]: string | string[] | undefined };
}

function getString(
  val: string | string[] | undefined,
  fallback: string,
): string {
  if (Array.isArray(val)) return val[0] ?? fallback;
  return val ?? fallback;
}

export default async function ProspectsPage({ searchParams }: PageProps) {
  const status = getString(searchParams.status, "");
  const statusFilter = status || undefined;
  const page = Math.max(1, parseInt(getString(searchParams.page, "1"), 10));
  const limit = 25;
  const offset = (page - 1) * limit;

  let prospects: Awaited<ReturnType<typeof listProspects>> = [];
  let total = 0;

  try {
    await ensureProspectsTable();
    [prospects, total] = await Promise.all([
      listProspects(statusFilter, limit, offset),
      countProspects(statusFilter),
    ]);
  } catch {
    // Table not yet created — show empty state
  }

  const totalPages = Math.ceil(total / limit);

  const filterHref = (s: string) => {
    const params = new URLSearchParams();
    if (s) params.set("status", s);
    const qs = params.toString();
    return qs ? `/prospects?${qs}` : "/prospects";
  };

  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    params.set("page", String(p));
    return `/prospects?${params.toString()}`;
  };

  return (
    <main>
      <h1>Prospects</h1>
      <p>
        Enriched company profiles sourced from Apollo and recent news signals.
      </p>

      <div className="toolbar">
        <a
          href={filterHref("")}
          className={!statusFilter ? "btn" : "btn secondary"}
        >
          All
        </a>
        <a
          href={filterHref("pending")}
          className={statusFilter === "pending" ? "btn" : "btn secondary"}
        >
          Pending
        </a>
        <a
          href={filterHref("enriched")}
          className={statusFilter === "enriched" ? "btn" : "btn secondary"}
        >
          Enriched
        </a>
        <a
          href={filterHref("failed")}
          className={statusFilter === "failed" ? "btn" : "btn secondary"}
        >
          Failed
        </a>
        <span className="muted">{total} total</span>
      </div>

      {prospects.length === 0 ? (
        <div className="empty">
          <p>
            No prospects found. The enrichment cron job will populate this list
            automatically.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Industry</th>
              <th>Employees</th>
              <th>Country</th>
              <th>Status</th>
              <th>Enriched</th>
            </tr>
          </thead>
          <tbody>
            {prospects.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={`/prospects/${p.id}`}>{p.company_name}</a>
                </td>
                <td>
                  {p.industry ?? <span className="muted">—</span>}
                </td>
                <td>
                  {p.employee_count !== null ? (
                    p.employee_count.toLocaleString()
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{p.country ?? <span className="muted">—</span>}</td>
                <td>{p.enrichment_status}</td>
                <td>
                  {p.enriched_at ? (
                    new Date(p.enriched_at).toLocaleDateString()
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div className="toolbar">
          {page > 1 && (
            <a href={pageHref(page - 1)} className="btn secondary">
              Previous
            </a>
          )}
          <span className="muted">
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <a href={pageHref(page + 1)} className="btn secondary">
              Next
            </a>
          )}
        </div>
      )}
    </main>
  );
}
