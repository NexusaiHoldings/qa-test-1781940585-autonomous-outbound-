/**
 * GET /api/unsubscribe/[token] — CAN-SPAM one-click unsubscribe handler.
 *
 * Each outbound SDR email embeds a unique tokenized URL. Clicking the link
 * (one HTTP GET — no confirmation step required by CAN-SPAM) immediately adds
 * the recipient's email to the suppression list and halts all future outreach
 * to that address.
 *
 * Public endpoint — no auth required. Token lookup is authenticated via the
 * cryptographically random token itself (64 hex chars / 256 bits of entropy).
 */
import { NextResponse } from "next/server";
import { processUnsubscribeToken } from "@/lib/sdr/suppression-list";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function confirmationHtml(email: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Unsubscribed</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f9fafb; margin: 0; padding: 0; }
    .container { max-width: 480px; margin: 80px auto; background: #fff; border-radius: 8px; padding: 40px; box-shadow: 0 1px 4px rgba(0,0,0,.08); text-align: center; }
    h1 { font-size: 1.5rem; margin: 0 0 12px; color: #111827; }
    p { color: #6b7280; margin: 0 0 8px; font-size: 0.95rem; }
    .email { font-weight: 600; color: #111827; }
  </style>
</head>
<body>
  <div class="container">
    <h1>You have been unsubscribed</h1>
    <p><span class="email">${email.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span> has been added to our suppression list.</p>
    <p>You will no longer receive outreach emails from us.</p>
    <p style="margin-top:24px;font-size:0.8rem;">If you unsubscribed by mistake, please contact us directly.</p>
  </div>
</body>
</html>`;
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Unsubscribe Error</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f9fafb; margin: 0; padding: 0; }
    .container { max-width: 480px; margin: 80px auto; background: #fff; border-radius: 8px; padding: 40px; box-shadow: 0 1px 4px rgba(0,0,0,.08); text-align: center; }
    h1 { font-size: 1.5rem; margin: 0 0 12px; color: #111827; }
    p { color: #6b7280; margin: 0; font-size: 0.95rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Unsubscribe link invalid</h1>
    <p>${message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
  </div>
</body>
</html>`;
}

export async function GET(
  _request: Request,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  const { token } = params;

  if (!token || typeof token !== "string" || token.length < 16) {
    return new NextResponse(errorHtml("This unsubscribe link is invalid or has expired."), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  let result: { email: string; orgId: string | null } | null;
  try {
    result = await processUnsubscribeToken(token);
  } catch (err) {
    console.error({ event: "unsubscribe.token_error", token, err });
    return new NextResponse(errorHtml("An error occurred while processing your request. Please try again."), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (!result) {
    return new NextResponse(errorHtml("This unsubscribe link is invalid or has already been used."), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  console.log({ event: "unsubscribe.success", email: result.email, org_id: result.orgId });

  return new NextResponse(confirmationHtml(result.email), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
