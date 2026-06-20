/**
 * POST /api/webhooks/inbound-email
 *
 * Receives forwarded prospect replies from the ESP (Resend, SendGrid, etc.),
 * classifies them via GPT, and autonomously dispatches the right action:
 *
 *   interested    → creates a high-priority support ticket for the founder
 *   objection     → schedules the next follow-up touch (2-3 touch max)
 *   unsubscribe   → suppresses the prospect immediately (CAN-SPAM)
 *   legal_threat  → creates an urgent support ticket and escalates to human
 *
 * URL is fixed (external ESP calls this path) so it lives outside (sdr)/.
 */

import { NextRequest, NextResponse } from "next/server";
import { classifyReply } from "@/lib/sdr/reply-classifier";
import {
  getPool,
  ensureSchema,
  findProspectByEmail,
  suppressProspect,
  scheduleFollowUp,
  saveReply,
} from "@/lib/sdr/sequence-engine";
import {
  handleCreateTicket,
  handleEscalateTicket,
} from "@nexus/support-and-help";
import type { HandlerContext, Db, EventBus } from "@nexus/support-and-help";
import type { Pool } from "pg";

// ── Lego adapter helpers ──────────────────────────────────────────────────────

function makeDbAdapter(pool: Pool): Db {
  return {
    async query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      const res = await pool.query<T & Record<string, unknown>>(
        sql,
        params.length > 0 ? params : undefined
      );
      return res.rows as T[];
    },
    async execute(sql: string, ...params: unknown[]): Promise<void> {
      await pool.query(sql, params.length > 0 ? params : undefined);
    },
  };
}

const noopEventBus: EventBus = {
  async publish(_subject: string, _payload: Record<string, unknown>): Promise<void> {},
};

function makeCtx(pool: Pool): HandlerContext {
  return { db: makeDbAdapter(pool), events: noopEventBus };
}

// ── Payload normalisation ─────────────────────────────────────────────────────

interface NormalisedEmail {
  fromEmail: string;
  subject: string | null;
  body: string;
}

function extractEmailFields(raw: Record<string, unknown>): NormalisedEmail | null {
  // Resend inbound webhook wraps fields under `data`
  const data =
    raw.type === "email.received" && typeof raw.data === "object" && raw.data !== null
      ? (raw.data as Record<string, unknown>)
      : raw;

  const fromRaw =
    (data.from as string | undefined) ??
    (data.From as string | undefined) ??
    "";
  // Strip display name: "Jane Doe <jane@example.com>" → "jane@example.com"
  const emailMatch = fromRaw.match(/<([^>]+)>/);
  const fromEmail = emailMatch ? emailMatch[1].trim() : fromRaw.trim();
  if (!fromEmail || !fromEmail.includes("@")) return null;

  const subject =
    (data.subject as string | undefined) ??
    (data.Subject as string | undefined) ??
    null;

  const body =
    (data.text as string | undefined) ??
    (data.plain as string | undefined) ??
    (data.Text as string | undefined) ??
    (data.body as string | undefined) ??
    "";
  if (!body.trim()) return null;

  return { fromEmail, subject: subject ?? null, body };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Optional shared secret to prevent spoofed webhook calls
  const webhookSecret = process.env.INBOUND_EMAIL_WEBHOOK_SECRET;
  if (webhookSecret) {
    const provided =
      request.headers.get("x-webhook-secret") ??
      request.headers.get("x-resend-signature") ??
      "";
    if (provided !== webhookSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = extractEmailFields(raw);
  if (!email) {
    return NextResponse.json(
      { error: "Could not extract from/body from payload" },
      { status: 400 }
    );
  }

  const { fromEmail, subject, body } = email;

  const pool = getPool();
  try {
    await ensureSchema(pool);
  } catch (err) {
    console.error("[inbound-email] schema setup failed", err);
    return NextResponse.json(
      { error: "Database initialisation failed" },
      { status: 500 }
    );
  }

  // Look up the prospect in our DB
  const prospect = await findProspectByEmail(fromEmail, pool).catch(() => null);
  const prospectId = prospect?.id ?? null;
  const campaignId = prospect?.campaign_id ?? null;

  const prospectContext = prospect
    ? [prospect.first_name, prospect.last_name].filter(Boolean).join(" ") +
      (prospect.company ? ` at ${prospect.company}` : "")
    : undefined;

  // Classify with LLM
  let classification;
  try {
    classification = await classifyReply(body, prospectContext);
  } catch (err) {
    console.error("[inbound-email] classification failed", err);
    return NextResponse.json(
      { error: "Reply classification failed" },
      { status: 502 }
    );
  }

  // Dispatch action based on classification
  let dispatchedAction = "none";

  if (classification.classification === "unsubscribe") {
    if (prospectId) {
      await suppressProspect(prospectId, pool);
    }
    dispatchedAction = prospectId ? "prospect_suppressed" : "unknown_sender_unsubscribe";
  } else if (classification.classification === "objection") {
    if (prospectId && campaignId) {
      await scheduleFollowUp(prospectId, campaignId, "objection_followup", pool);
      dispatchedAction = "followup_scheduled";
    } else {
      dispatchedAction = "objection_no_prospect";
    }
  } else if (classification.classification === "interested") {
    try {
      const ctx = makeCtx(pool);
      const ticketResult = await handleCreateTicket(ctx, {
        subject: `Interested prospect: ${fromEmail}`,
        message:
          `A prospect has replied with interest and should be contacted by the team.\n\n` +
          `From: ${fromEmail}\n` +
          `Subject: ${subject ?? "(none)"}\n\n` +
          `Reply:\n${body}`,
        priority: "high",
      });
      const ticketId =
        typeof ticketResult.body === "object" && ticketResult.body !== null
          ? String(ticketResult.body.ticket_id ?? "")
          : "";
      dispatchedAction = ticketId
        ? `founder_ticket_created:${ticketId}`
        : "founder_ticket_created";
    } catch (err) {
      console.error("[inbound-email] ticket creation failed for interested prospect", err);
      dispatchedAction = "founder_ticket_failed";
    }
  } else if (classification.classification === "legal_threat") {
    try {
      const ctx = makeCtx(pool);
      const ticketResult = await handleCreateTicket(ctx, {
        subject: `LEGAL THREAT — prospect: ${fromEmail}`,
        message:
          `URGENT: A prospect has issued a legal threat. Requires immediate human review.\n\n` +
          `From: ${fromEmail}\n` +
          `Subject: ${subject ?? "(none)"}\n\n` +
          `Reply:\n${body}`,
        priority: "urgent",
      });

      if (
        typeof ticketResult.body === "object" &&
        ticketResult.body !== null &&
        ticketResult.body.ticket_id
      ) {
        const ticketId = String(ticketResult.body.ticket_id);
        await handleEscalateTicket(ctx, ticketId, {
          reason:
            "Prospect issued a legal threat — requires immediate human review and legal team notification",
          priority_override: "urgent",
        });
        dispatchedAction = `legal_threat_escalated:${ticketId}`;
      } else {
        dispatchedAction = "legal_threat_ticket_failed";
      }
    } catch (err) {
      console.error("[inbound-email] legal threat escalation failed", err);
      dispatchedAction = "legal_threat_escalation_failed";
    }
  }

  // Persist the reply record regardless of dispatch outcome
  try {
    const replyId = await saveReply(
      fromEmail,
      subject,
      body,
      prospectId,
      campaignId,
      classification.classification,
      classification.confidence,
      classification.reasoning,
      dispatchedAction,
      raw,
      pool
    );

    return NextResponse.json({
      ok: true,
      reply_id: replyId,
      classification: classification.classification,
      confidence: classification.confidence,
      action: dispatchedAction,
    });
  } catch (err) {
    console.error("[inbound-email] failed to persist reply", err);
    // Still return success for the classification/dispatch — persistence is non-critical
    return NextResponse.json({
      ok: true,
      classification: classification.classification,
      action: dispatchedAction,
    });
  }
}
