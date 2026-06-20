/**
 * Agent tool handler: enrich_prospect_profile
 *
 * Calls Apollo API + LinkedIn data provider + news fetcher to build a
 * context-rich prospect profile, then writes the enriched JSONB payload
 * to sdr_prospects. Invoked by the agent when a new ICP-matched company
 * is identified (autonomy = autonomous — mutations route through the
 * cross-boundary bridge).
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

export type Args = Record<string, unknown>;

interface ApolloPersonResult {
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  seniority: string | null;
  departments: string[];
}

interface ApolloOrganizationResult {
  name: string | null;
  website_url: string | null;
  linkedin_url: string | null;
  industry: string | null;
  employee_count: number | null;
  annual_revenue: number | null;
  short_description: string | null;
  technologies: string[];
}

interface LinkedInProfile {
  headline: string | null;
  summary: string | null;
  experience: Array<{ title: string; company: string; duration: string }>;
  skills: string[];
}

interface NewsArticle {
  title: string;
  url: string;
  published_at: string;
  summary: string;
}

interface EnrichedProfile {
  prospect_id: string;
  company_name: string;
  enriched_at: string;
  apollo: {
    person: ApolloPersonResult | null;
    organization: ApolloOrganizationResult | null;
  };
  linkedin: LinkedInProfile | null;
  recent_news: NewsArticle[];
  icp_signals: string[];
  enrichment_version: number;
}

async function fetchApolloPersonData(
  email: string,
  apolloApiKey: string,
): Promise<ApolloPersonResult | null> {
  const url = new URL("https://api.apollo.io/v1/people/match");
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify({
      api_key: apolloApiKey,
      email,
      reveal_personal_emails: false,
    }),
  });

  if (!resp.ok) {
    return null;
  }

  const data = (await resp.json()) as { person?: ApolloPersonResult };
  return data.person ?? null;
}

async function fetchApolloOrgData(
  domain: string,
  apolloApiKey: string,
): Promise<ApolloOrganizationResult | null> {
  const url = new URL("https://api.apollo.io/v1/organizations/enrich");
  url.searchParams.set("api_key", apolloApiKey);
  url.searchParams.set("domain", domain);

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { "Cache-Control": "no-cache" },
  });

  if (!resp.ok) {
    return null;
  }

  const data = (await resp.json()) as { organization?: ApolloOrganizationResult };
  return data.organization ?? null;
}

async function fetchLinkedInProfile(
  linkedinUrl: string,
  linkedinApiKey: string,
): Promise<LinkedInProfile | null> {
  // Uses a LinkedIn data provider (e.g. Proxycurl) to fetch profile details.
  const proxyUrl = process.env.LINKEDIN_API_BASE_URL ?? "https://nubela.co/proxycurl/api/v2";
  const url = new URL(`${proxyUrl}/linkedin`);
  url.searchParams.set("url", linkedinUrl);
  url.searchParams.set("use_cache", "if-present");

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${linkedinApiKey}`,
    },
  });

  if (!resp.ok) {
    return null;
  }

  const raw = (await resp.json()) as {
    headline?: string;
    summary?: string;
    experiences?: Array<{ title?: string; company?: string; duration?: string }>;
    skills?: Array<{ name?: string }>;
  };

  return {
    headline: raw.headline ?? null,
    summary: raw.summary ?? null,
    experience: (raw.experiences ?? []).map((e) => ({
      title: e.title ?? "",
      company: e.company ?? "",
      duration: e.duration ?? "",
    })),
    skills: (raw.skills ?? []).map((s) => s.name ?? "").filter(Boolean),
  };
}

async function fetchRecentNews(companyName: string, newsApiKey: string): Promise<NewsArticle[]> {
  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", `"${companyName}"`);
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", "5");
  url.searchParams.set("language", "en");
  url.searchParams.set("apiKey", newsApiKey);

  const resp = await fetch(url.toString(), { method: "GET" });

  if (!resp.ok) {
    return [];
  }

  const data = (await resp.json()) as {
    articles?: Array<{
      title?: string;
      url?: string;
      publishedAt?: string;
      description?: string;
    }>;
  };

  return (data.articles ?? []).slice(0, 5).map((a) => ({
    title: a.title ?? "",
    url: a.url ?? "",
    published_at: a.publishedAt ?? "",
    summary: a.description ?? "",
  }));
}

function deriveIcpSignals(
  org: ApolloOrganizationResult | null,
  linkedin: LinkedInProfile | null,
): string[] {
  const signals: string[] = [];

  if (org) {
    if (org.employee_count && org.employee_count >= 50 && org.employee_count <= 5000) {
      signals.push("company_size_match");
    }
    if (org.technologies && org.technologies.length > 0) {
      signals.push("tech_stack_enriched");
    }
    if (org.annual_revenue && org.annual_revenue > 1_000_000) {
      signals.push("revenue_threshold_met");
    }
  }

  if (linkedin) {
    if (linkedin.experience && linkedin.experience.length > 0) {
      signals.push("linkedin_experience_available");
    }
    if (linkedin.skills && linkedin.skills.length >= 5) {
      signals.push("skills_enriched");
    }
  }

  return signals;
}

export async function handleEnrichProspectProfile(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const prospectId = args["prospect_id"];
  if (typeof prospectId !== "string" || !prospectId) {
    return { status: 400, body: "prospect_id is required and must be a non-empty string" };
  }

  const apolloApiKey = process.env.APOLLO_API_KEY;
  const linkedinApiKey = process.env.LINKEDIN_API_KEY;
  const newsApiKey = process.env.NEWS_API_KEY;

  if (!apolloApiKey) {
    return { status: 500, body: "APOLLO_API_KEY env var is not configured" };
  }

  // Fetch existing prospect row to get email + company domain.
  const prospectRows = await ctx.db.query<{
    id: string;
    email: string | null;
    company_name: string | null;
    company_domain: string | null;
    linkedin_url: string | null;
  }>(
    `SELECT id, email, company_name, company_domain, linkedin_url
     FROM sdr_prospects
     WHERE id = $1
     LIMIT 1`,
    prospectId,
  );

  if (!prospectRows || prospectRows.length === 0) {
    return { status: 404, body: `Prospect ${prospectId} not found` };
  }

  const prospect = prospectRows[0] as {
    id: string;
    email: string | null;
    company_name: string | null;
    company_domain: string | null;
    linkedin_url: string | null;
  };

  // Run external data fetches concurrently; tolerate partial failures.
  const [apolloPerson, apolloOrg, linkedinProfile, recentNews] = await Promise.allSettled([
    prospect.email && apolloApiKey
      ? fetchApolloPersonData(prospect.email, apolloApiKey)
      : Promise.resolve(null),
    prospect.company_domain && apolloApiKey
      ? fetchApolloOrgData(prospect.company_domain, apolloApiKey)
      : Promise.resolve(null),
    prospect.linkedin_url && linkedinApiKey
      ? fetchLinkedInProfile(prospect.linkedin_url, linkedinApiKey)
      : Promise.resolve(null),
    prospect.company_name && newsApiKey
      ? fetchRecentNews(prospect.company_name, newsApiKey)
      : Promise.resolve([]),
  ]);

  const personData =
    apolloPerson.status === "fulfilled" ? (apolloPerson.value ?? null) : null;
  const orgData =
    apolloOrg.status === "fulfilled" ? (apolloOrg.value ?? null) : null;
  const linkedinData =
    linkedinProfile.status === "fulfilled" ? (linkedinProfile.value ?? null) : null;
  const newsData =
    recentNews.status === "fulfilled" ? (recentNews.value ?? []) : [];

  const icpSignals = deriveIcpSignals(orgData, linkedinData);

  const enrichedPayload: EnrichedProfile = {
    prospect_id: prospectId,
    company_name: prospect.company_name ?? "",
    enriched_at: new Date().toISOString(),
    apollo: {
      person: personData,
      organization: orgData,
    },
    linkedin: linkedinData,
    recent_news: newsData,
    icp_signals: icpSignals,
    enrichment_version: 1,
  };

  await ctx.db.execute(
    `UPDATE sdr_prospects
     SET enriched_profile = $2::jsonb,
         enriched_at      = NOW(),
         updated_at       = NOW()
     WHERE id = $1`,
    prospectId,
    JSON.stringify(enrichedPayload),
  );

  await ctx.events.publish("prospect.enriched", {
    prospect_id: prospectId,
    company_name: prospect.company_name,
    icp_signals: icpSignals,
    enriched_at: enrichedPayload.enriched_at,
  });

  return {
    status: 200,
    body: {
      prospect_id: prospectId,
      enriched: true,
      icp_signals: icpSignals,
      enriched_at: enrichedPayload.enriched_at,
    },
  };
}
