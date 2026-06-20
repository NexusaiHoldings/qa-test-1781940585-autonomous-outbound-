/**
 * LLM-powered reply classifier for SDR inbound email replies.
 * Calls the OpenAI API directly (no SDK) to classify prospect replies into
 * one of four categories used by the sequence engine to dispatch actions.
 */

export type ReplyClassification =
  | "interested"
  | "objection"
  | "unsubscribe"
  | "legal_threat";

export interface ClassifyReplyResult {
  classification: ReplyClassification;
  confidence: number;
  reasoning: string;
}

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIChoice {
  message: { content: string };
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
}

const VALID_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "interested",
  "objection",
  "unsubscribe",
  "legal_threat",
]);

const SYSTEM_PROMPT = `You are an SDR assistant classifying prospect email replies. \
Classify the reply into exactly one category:
- interested: prospect wants to learn more, schedule a call, or shows positive buying signals
- objection: prospect has concerns or pushback but has not opted out
- unsubscribe: prospect explicitly wants to stop receiving emails or be removed from the list
- legal_threat: prospect mentions legal action, spam laws, CAN-SPAM violations, \
regulatory complaints, or threatens to report the sender

Respond with valid JSON only, no markdown fences:
{"classification":"<category>","confidence":<0.0-1.0>,"reasoning":"<one-sentence explanation>"}`;

export async function classifyReply(
  replyText: string,
  prospectContext?: string
): Promise<ClassifyReplyResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not configured");
  }

  const userContent = prospectContext
    ? `Prospect context: ${prospectContext}\n\nReply to classify:\n${replyText}`
    : `Reply to classify:\n${replyText}`;

  const messages: OpenAIChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages,
      temperature: 0.1,
      response_format: { type: "json_object" },
      max_tokens: 256,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(unreadable)");
    throw new Error(
      `LLM classification request failed: HTTP ${response.status} — ${errorText}`
    );
  }

  const data = (await response.json()) as OpenAIResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty content in LLM response");
  }

  let parsed: { classification?: string; confidence?: unknown; reasoning?: unknown };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    throw new Error(`Failed to parse LLM JSON response: ${content}`);
  }

  if (!parsed.classification || !VALID_CLASSIFICATIONS.has(parsed.classification)) {
    throw new Error(
      `Invalid classification value returned by LLM: "${parsed.classification}". ` +
        `Expected one of: ${[...VALID_CLASSIFICATIONS].join(", ")}`
    );
  }

  const confidence = typeof parsed.confidence === "number"
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.8;

  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";

  return {
    classification: parsed.classification as ReplyClassification,
    confidence,
    reasoning,
  };
}
