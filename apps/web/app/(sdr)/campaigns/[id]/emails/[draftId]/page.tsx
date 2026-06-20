/**
 * /campaigns/[id]/emails/[draftId] — review and approve a single email draft.
 *
 * Server component with inline server actions for editing and approval.
 * Founder can edit subject/body before approving. Approved drafts move to
 * the sdr_email_sends queue.
 */
import type { JSX } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  getEmailDraft,
  updateEmailDraft,
  approveDraft,
  type EmailDraft,
} from "@/lib/sdr/email-composer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default async function EmailDraftPage({
  params,
}: {
  params: { id: string; draftId: string };
}): Promise<JSX.Element> {
  if (!params.id || !params.draftId) redirect("/");

  let draft: EmailDraft | null = null;
  let loadError = "";
  try {
    draft = await getEmailDraft(params.draftId);
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Failed to load draft";
  }

  if (!loadError && !draft) {
    redirect(`/campaigns/${encodeURIComponent(params.id)}/emails`);
  }

  const campaignId = params.id;
  const draftId = params.draftId;

  async function handleSave(formData: FormData): Promise<void> {
    "use server";
    const subject = (formData.get("subject") as string | null) ?? "";
    const bodyText = (formData.get("body_text") as string | null) ?? "";
    const previewText = (formData.get("preview_text") as string | null) ?? "";
    await updateEmailDraft(draftId, {
      subject,
      body_text: bodyText,
      preview_text: previewText,
    });
    redirect(
      `/campaigns/${encodeURIComponent(campaignId)}/emails/${encodeURIComponent(draftId)}`,
    );
  }

  async function handleApprove(): Promise<void> {
    "use server";
    await approveDraft(draftId);
    redirect(`/campaigns/${encodeURIComponent(campaignId)}/emails`);
  }

  const canEdit = draft?.status === "draft";

  return (
    <main>
      <p>
        <Link
          href={`/campaigns/${encodeURIComponent(campaignId)}/emails`}
          className="btn secondary"
        >
          ← All Drafts
        </Link>
      </p>

      <h1>Email Draft</h1>
      <p>
        Review and edit this AI-generated email before approving it for send.
      </p>

      {loadError && (
        <div className="card">
          <p>Error: {loadError}</p>
        </div>
      )}

      {draft && (
        <>
          <div className="card">
            <p className="muted">
              To:{" "}
              <strong>{draft.prospect_name}</strong>{" "}
              &lt;{draft.prospect_email}&gt;
              &nbsp;·&nbsp;Status: <strong>{draft.status}</strong>
              &nbsp;·&nbsp;Created: {formatDate(draft.created_at)}
            </p>

            {draft.trigger_events && draft.trigger_events.length > 0 && (
              <details style={{ marginTop: "0.5rem" }}>
                <summary className="muted">
                  {draft.trigger_events.length} trigger event
                  {draft.trigger_events.length !== 1 ? "s" : ""} referenced
                </summary>
                <ul>
                  {draft.trigger_events.map((ev, idx) => (
                    <li key={idx}>
                      <strong>{ev.title}</strong>
                      {ev.date && (
                        <span className="muted"> ({ev.date})</span>
                      )}
                      {" — "}
                      <span className="muted">{ev.summary}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {canEdit ? (
            <form action={handleSave}>
              <label htmlFor="subject">Subject</label>
              <input
                id="subject"
                name="subject"
                type="text"
                defaultValue={draft.subject}
                required
              />

              <label htmlFor="preview_text">Preview Text</label>
              <input
                id="preview_text"
                name="preview_text"
                type="text"
                defaultValue={draft.preview_text}
              />

              <label htmlFor="body_text">Email Body</label>
              <textarea
                id="body_text"
                name="body_text"
                rows={14}
                required
                defaultValue={draft.body_text}
                style={{ width: "100%", fontFamily: "inherit" }}
              />

              <p>
                <button type="submit" className="btn secondary">
                  Save Changes
                </button>
              </p>
            </form>
          ) : (
            <div className="card">
              <p>
                <strong>Subject:</strong> {draft.subject}
              </p>
              <p>
                <strong>Preview:</strong>{" "}
                <span className="muted">{draft.preview_text}</span>
              </p>
              <p>
                <strong>Body:</strong>
              </p>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  fontSize: "0.9rem",
                }}
              >
                {draft.body_text}
              </pre>
            </div>
          )}

          {canEdit && (
            <form action={handleApprove}>
              <p>
                <button type="submit">
                  Approve &amp; Queue for Send
                </button>
              </p>
            </form>
          )}

          {!canEdit && draft.status === "queued" && (
            <div className="card">
              <p>
                This draft has been approved and is queued for sending.
              </p>
            </div>
          )}

          {!canEdit && draft.status === "sent" && (
            <div className="card">
              <p>This email has been sent.</p>
            </div>
          )}
        </>
      )}
    </main>
  );
}
