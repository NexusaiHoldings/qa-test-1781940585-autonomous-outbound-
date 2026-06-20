import { revalidatePath } from "next/cache";
import {
  getSendingDomains,
  upsertSendingDomain,
  deleteSendingDomain,
  verifyAndUpdateDomain,
  getDeliverabilityMetrics,
  type SendingDomain,
  type DeliverabilityMetrics,
} from "@/lib/sdr/domain-verifier";
import { getWarmupState, startWarmup, type WarmupState } from "@/lib/sdr/warmup-scheduler";

const ORG_ID = process.env.DEFAULT_ORG_ID ?? "default";

async function addDomainAction(formData: FormData): Promise<void> {
  "use server";
  const domain = (formData.get("domain") as string ?? "").trim().toLowerCase();
  const dkimSelector = (formData.get("dkim_selector") as string ?? "default").trim();
  if (!domain) return;
  await upsertSendingDomain(ORG_ID, domain, dkimSelector || "default");
  revalidatePath("/settings/sending");
}

async function verifyDomainAction(formData: FormData): Promise<void> {
  "use server";
  const domainId = formData.get("domain_id") as string;
  if (!domainId) return;
  await verifyAndUpdateDomain(domainId);
  revalidatePath("/settings/sending");
}

async function startWarmupAction(formData: FormData): Promise<void> {
  "use server";
  const domainId = formData.get("domain_id") as string;
  if (!domainId) return;
  await startWarmup(domainId);
  revalidatePath("/settings/sending");
}

async function deleteDomainAction(formData: FormData): Promise<void> {
  "use server";
  const domainId = formData.get("domain_id") as string;
  if (!domainId) return;
  await deleteSendingDomain(domainId);
  revalidatePath("/settings/sending");
}

function StatusBadge({ verified }: { verified: boolean }): JSX.Element {
  return (
    <span style={{ color: verified ? "green" : "orange", fontWeight: 600 }}>
      {verified ? "✓ Verified" : "✗ Pending"}
    </span>
  );
}

function DomainCard({
  domain,
  metrics,
  warmup,
}: {
  domain: SendingDomain;
  metrics: DeliverabilityMetrics;
  warmup: WarmupState | null;
}): JSX.Element {
  const dkimHost = `${domain.dkim_selector}._domainkey.${domain.domain}`;
  const dmarcHost = `_dmarc.${domain.domain}`;

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <strong>{domain.domain}</strong>
          {domain.domain_verified ? (
            <span style={{ marginLeft: 8, color: "green" }}>● Active</span>
          ) : (
            <span style={{ marginLeft: 8, color: "orange" }}>● Unverified</span>
          )}
        </div>
        <form action={deleteDomainAction}>
          <input type="hidden" name="domain_id" value={domain.id} />
          <button type="submit" className="btn secondary" style={{ fontSize: "0.8rem" }}>
            Remove
          </button>
        </form>
      </div>

      <table style={{ marginTop: 12, width: "100%" }}>
        <tbody>
          <tr>
            <td style={{ width: 80 }}>SPF</td>
            <td><StatusBadge verified={domain.spf_verified} /></td>
            <td className="muted" style={{ fontSize: "0.8rem" }}>Add TXT on <code>{domain.domain}</code>: <code>v=spf1 include:amazonses.com ~all</code></td>
          </tr>
          <tr>
            <td>DKIM</td>
            <td><StatusBadge verified={domain.dkim_verified} /></td>
            <td className="muted" style={{ fontSize: "0.8rem" }}>Add TXT on <code>{dkimHost}</code> with your ESP-provided key</td>
          </tr>
          <tr>
            <td>DMARC</td>
            <td><StatusBadge verified={domain.dmarc_verified} /></td>
            <td className="muted" style={{ fontSize: "0.8rem" }}>Add TXT on <code>{dmarcHost}</code>: <code>v=DMARC1; p=quarantine; rua=mailto:dmarc@{domain.domain}</code></td>
          </tr>
        </tbody>
      </table>

      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <form action={verifyDomainAction}>
          <input type="hidden" name="domain_id" value={domain.id} />
          <button type="submit" className="btn secondary">Re-check DNS</button>
        </form>
        {domain.domain_verified && warmup && warmup.warmup_day === 0 && (
          <form action={startWarmupAction}>
            <input type="hidden" name="domain_id" value={domain.id} />
            <button type="submit" className="btn">Start Warm-up</button>
          </form>
        )}
      </div>

      {warmup && warmup.warmup_day > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={{ margin: "4px 0" }}>
            <strong>Warm-up progress:</strong> Day {warmup.warmup_day} / 14
            {warmup.completed ? " — Complete" : ` — ${warmup.daily_limit} emails/day`}
          </p>
          <div style={{ background: "#eee", borderRadius: 4, height: 8, marginTop: 4 }}>
            <div
              style={{
                background: warmup.completed ? "green" : "#007bff",
                borderRadius: 4,
                height: 8,
                width: `${Math.min(100, (warmup.warmup_day / 14) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {domain.domain_verified && (
        <div style={{ marginTop: 12 }}>
          <strong>Deliverability (last 30 days)</strong>
          <table style={{ marginTop: 8 }}>
            <tbody>
              <tr>
                <td>Emails sent</td>
                <td>{metrics.emails_sent.toLocaleString()}</td>
              </tr>
              <tr>
                <td>Bounce rate</td>
                <td style={{ color: metrics.bounce_rate > 0.05 ? "red" : "inherit" }}>
                  {(metrics.bounce_rate * 100).toFixed(2)}%
                  {metrics.bounce_rate > 0.05 && " ⚠ High"}
                </td>
              </tr>
              <tr>
                <td>Spam rate</td>
                <td style={{ color: metrics.spam_rate > 0.001 ? "red" : "inherit" }}>
                  {(metrics.spam_rate * 100).toFixed(3)}%
                  {metrics.spam_rate > 0.001 && " ⚠ High"}
                </td>
              </tr>
              <tr>
                <td>Inbox placement</td>
                <td>
                  {metrics.emails_sent > 0
                    ? `${(metrics.inbox_placement_score * 100).toFixed(0)}%`
                    : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {domain.last_verified_at && (
        <p className="muted" style={{ fontSize: "0.75rem", marginTop: 8 }}>
          Last checked: {new Date(domain.last_verified_at).toLocaleString()}
        </p>
      )}
    </div>
  );
}

export default async function SendingSettingsPage(): Promise<JSX.Element> {
  let domains: SendingDomain[] = [];
  let loadError: string | null = null;

  try {
    domains = await getSendingDomains(ORG_ID);
  } catch (err) {
    loadError = String((err as Error).message);
  }

  const domainData = await Promise.all(
    domains.map(async (d) => {
      const [metrics, warmup] = await Promise.all([
        getDeliverabilityMetrics(d.id, 30).catch(() => ({
          emails_sent: 0,
          bounces: 0,
          spam_complaints: 0,
          inbox_placement_score: 0,
          bounce_rate: 0,
          spam_rate: 0,
          date_range_days: 30,
        })),
        getWarmupState(d.id).catch(() => null),
      ]);
      return { domain: d, metrics, warmup };
    })
  );

  return (
    <main>
      <h1>Sending Domain Configuration</h1>
      <p>
        Connect your own sending domain to maximize inbox placement. Campaign dispatch is blocked
        until your domain is verified. Authenticate with DKIM, SPF, and DMARC records.
      </p>

      <form action={addDomainAction} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
        <input
          type="text"
          name="domain"
          placeholder="outreach.yourfirm.com"
          required
          style={{ flex: "1 1 220px" }}
        />
        <input
          type="text"
          name="dkim_selector"
          placeholder="DKIM selector (default: default)"
          style={{ flex: "1 1 180px" }}
        />
        <button type="submit" className="btn">Add Domain</button>
      </form>

      {loadError && (
        <div className="card" style={{ borderColor: "red" }}>
          <p style={{ color: "red" }}>Failed to load domains: {loadError}</p>
        </div>
      )}

      {!loadError && domains.length === 0 && (
        <div className="empty">
          <p>No sending domains configured yet.</p>
          <p className="muted">Add a domain above to get started with DKIM, SPF, and DMARC setup.</p>
        </div>
      )}

      {domainData.map(({ domain, metrics, warmup }) => (
        <DomainCard key={domain.id} domain={domain} metrics={metrics} warmup={warmup} />
      ))}
    </main>
  );
}
