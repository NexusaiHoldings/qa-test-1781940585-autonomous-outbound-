/**
 * GPT-4o Personalized Email Composer
 *
 * Takes an enriched prospect profile (JSONB context_payload with funding rounds,
 * leadership changes, regulatory news) and generates a hyper-personalized cold
 * email referencing specific trigger events. Stores drafts in sdr_email_drafts;
 * approved drafts are enqueued in sdr_email_sends.
 *
 * No openai SDK (banned) — calls the completion API via fetch.
 */

export const runtime = "nodejs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (cfg: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

async function dbQuery<T = Record<string, unknown>>(
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const pool = getPool();
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

export async function bootstrapSchema(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sdr_email_drafts (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id     uuid NOT NULL,
      prospect_id     text NOT NULL,
      prospect_name   text NOT NULL,
      prospect_email  text NOT NULL,
      subject         text NOT NULL,
      body_text       text NOT NULL,
      preview_text    text NOT NULL,
      trigger_events  jsonb NOT NULL DEFAULT '[]'::jsonb,
      status          text NOT NULL DEFAULT 'draft',
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_sdr_email_drafts_campaign
      ON sdr_email_drafts (campaign_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS sdr_email_sends (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      draft_id        uuid NOT NULL REFERENCES sdr_email_drafts(id),
      campaign_id     uuid NOT NULL,
      prospect_email  text NOT NULL,
      subject         text NOT NULL,
      body_text       text NOT NULL,
      queued_at       timestamptz NOT NULL DEFAULT now(),
      sent_at         timestamptz,
      status          text NOT NULL DEFAULT 'queued'
    );
    CREATE INDEX IF NOT EXISTS idx_sdr_email_sends_campaign
      ON sdr_email_sends (campaign_id, queued_at DESC);
  `);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TriggerEvent {
  type: "funding_round" | "leadership_change" | "regulatory_news" | "product_launch" | "other";
  title: string;
  summary: string;
  date?: string;
}

export interface ProspectProfile {
  id: string;
  name: string;
  email: string;
  company: string;
  title: string;
  context_payload: {
    funding_rounds?: Array<{ round: string; amount: string; date: string }>;
    leadership_changes?: Array<{ name: string; role: string; date: string }>;
    regulatory_news?: Array<{ title: string; summary: string; date: string }>;
    product_launches?: Array<{ name: string; description: string; date: string }>;
    [key: string]: unknown;
  };
}

export interface EmailDraft {
  id: string;
  campaign_id: string;
  prospect_id: string;
  prospect_name: string;
  prospect_email: string;
  subject: string;
  body_text: string;
  preview_text: string;
  trigger_events: TriggerEvent[];
  status: "draft" | "approved" | "queued" | "sent";
  created_at: string;
  updated_at: string;
}

export interface ComposeOptions {
  campaign_id: string;
  prospect: ProspectProfile;
  sender_name: string;
  sender_title?: string;
  company_name: string;
}

export interface UpdateDraftInput {
  subject?: string;
  body_text?: string;
  preview_text?: string;
}

// ---------------------------------------------------------------------------
// LLM call (fetch, no openai SDK)
// ---------------------------------------------------------------------------

interface GptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function callGpt(messages: GptMessage[]): Promise<string> {
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const model = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GPT API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from GPT API");
  return content.trim();
}

// ---------------------------------------------------------------------------
// Trigger event extraction
// ---------------------------------------------------------------------------

function extractTriggerEvents(prospect: ProspectProfile): TriggerEvent[] {
  const events: TriggerEvent[] = [];
  const cp = prospect.context_payload;

  if (cp.funding_rounds) {
    for (const fr of cp.funding_rounds) {
      events.push({
        type: "funding_round",
        title: `${fr.round} round — ${fr.amount}`,
        summary: `${prospect.company} raised ${fr.amount} in a ${fr.round} round`,
        date: fr.date,
      });
    }
  }

  if (cp.leadership_changes) {
    for (const lc of cp.leadership_changes) {
      events.push({
        type: "leadership_change",
        title: `${lc.name} joined as ${lc.role}`,
        summary: `${lc.name} recently joined ${prospect.company} as ${lc.role}`,
        date: lc.date,
      });
    }
  }

  if (cp.regulatory_news) {
    for (const rn of cp.regulatory_news) {
      events.push({
        type: "regulatory_news",
        title: rn.title,
        summary: rn.summary,
        date: rn.date,
      });
    }
  }

  if (cp.product_launches) {
    for (const pl of cp.product_launches) {
      events.push({
        type: "product_launch",
        title: pl.name,
        summary: pl.description,
        date: pl.date,
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Email composition
// ---------------------------------------------------------------------------

export async function composeDraftEmail(options: ComposeOptions): Promise<EmailDraft> {
  const { campaign_id, prospect, sender_name, sender_title, company_name } = options;

  await bootstrapSchema();

  const triggerEvents = extractTriggerEvents(prospect);
  const triggerSummary =
    triggerEvents.length > 0
      ? triggerEvents
          .map((e) => `- ${e.title}: ${e.summary}${e.date ? ` (${e.date})` : ""}`)
          .join("\n")
      : "No specific trigger events identified.";

  const systemPrompt = `You are an expert B2B cold email copywriter. Write hyper-personalized, concise cold emails that reference specific recent trigger events at the prospect's company.

Rules:
- Subject line: 6–10 words, curiosity-driven, no spam triggers
- Body: 3–4 short paragraphs, 120–180 words total
- Reference at least one specific trigger event by name
- End with a single low-friction CTA (15-minute call or reply)
- First-person from the sender, conversational tone
- No generic phrases like "I hope this email finds you well"
- Preview text (40–60 chars): teaser that extends the subject line

Output format — respond with valid JSON only:
{
  "subject": "...",
  "body": "...",
  "preview_text": "..."
}`;

  const userPrompt = `Prospect details:
- Name: ${prospect.name}
- Title: ${prospect.title}
- Company: ${prospect.company}
- Email: ${prospect.email}

Recent trigger events at ${prospect.company}:
${triggerSummary}

Sender:
- Name: ${sender_name}${sender_title ? `\n- Title: ${sender_title}` : ""}
- Company: ${company_name}

Write the personalized cold email now.`;

  const raw = await callGpt([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  let parsed: { subject: string; body: string; preview_text: string };
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as {
      subject: string;
      body: string;
      preview_text: string;
    };
  } catch {
    parsed = {
      subject: `Quick question about ${prospect.company}`,
      body: raw,
      preview_text: `Hi ${prospect.name}, wanted to reach out…`,
    };
  }

  const rows = await dbQuery<EmailDraft>(
    `INSERT INTO sdr_email_drafts
       (campaign_id, prospect_id, prospect_name, prospect_email,
        subject, body_text, preview_text, trigger_events, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'draft')
     RETURNING *`,
    campaign_id,
    prospect.id,
    prospect.name,
    prospect.email,
    parsed.subject,
    parsed.body,
    parsed.preview_text,
    JSON.stringify(triggerEvents),
  );

  return rows[0];
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listEmailDrafts(campaignId: string): Promise<EmailDraft[]> {
  await bootstrapSchema();
  return dbQuery<EmailDraft>(
    `SELECT * FROM sdr_email_drafts
     WHERE campaign_id = $1
     ORDER BY created_at DESC`,
    campaignId,
  );
}

export async function getEmailDraft(draftId: string): Promise<EmailDraft | null> {
  await bootstrapSchema();
  const rows = await dbQuery<EmailDraft>(
    `SELECT * FROM sdr_email_drafts WHERE id = $1`,
    draftId,
  );
  return rows[0] ?? null;
}

export async function updateEmailDraft(
  draftId: string,
  updates: UpdateDraftInput,
): Promise<EmailDraft | null> {
  await bootstrapSchema();

  const setClauses: string[] = ["updated_at = now()"];
  const params: unknown[] = [draftId];
  let idx = 2;

  if (updates.subject !== undefined) {
    setClauses.push(`subject = $${idx++}`);
    params.push(updates.subject);
  }
  if (updates.body_text !== undefined) {
    setClauses.push(`body_text = $${idx++}`);
    params.push(updates.body_text);
  }
  if (updates.preview_text !== undefined) {
    setClauses.push(`preview_text = $${idx++}`);
    params.push(updates.preview_text);
  }

  const rows = await dbQuery<EmailDraft>(
    `UPDATE sdr_email_drafts
     SET ${setClauses.join(", ")}
     WHERE id = $1
     RETURNING *`,
    ...params,
  );
  return rows[0] ?? null;
}

export async function approveDraft(draftId: string): Promise<void> {
  await bootstrapSchema();

  const rows = await dbQuery<EmailDraft>(
    `UPDATE sdr_email_drafts
     SET status = 'approved', updated_at = now()
     WHERE id = $1 AND status = 'draft'
     RETURNING *`,
    draftId,
  );

  if (rows.length === 0) return;

  const draft = rows[0];
  await dbQuery(
    `INSERT INTO sdr_email_sends
       (draft_id, campaign_id, prospect_email, subject, body_text, status)
     VALUES ($1, $2, $3, $4, $5, 'queued')`,
    draft.id,
    draft.campaign_id,
    draft.prospect_email,
    draft.subject,
    draft.body_text,
  );

  await dbQuery(
    `UPDATE sdr_email_drafts SET status = 'queued' WHERE id = $1`,
    draftId,
  );
}
