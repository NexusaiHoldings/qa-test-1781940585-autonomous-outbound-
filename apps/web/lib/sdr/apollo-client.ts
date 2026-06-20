/**
 * Apollo.io API client for ICP-based company discovery.
 * Uses v1 mixed_companies/search endpoint with header auth.
 */

export interface IcpFilter {
  industries?: string[];
  minEmployees?: number;
  maxEmployees?: number;
  countries?: string[];
  keywords?: string[];
}

export interface ApolloOrganization {
  id: string;
  name: string;
  website_url: string | null;
  linkedin_url: string | null;
  industry: string | null;
  num_employees: number | null;
  annual_revenue: number | null;
  country: string | null;
  city: string | null;
  primary_domain: string | null;
  phone: string | null;
  description: string | null;
}

export interface ApolloSearchResult {
  organizations: ApolloOrganization[];
  total_entries: number;
  page: number;
  per_page: number;
}

export async function searchApolloCompanies(
  filter: IcpFilter,
  page: number = 1,
  perPage: number = 25,
): Promise<ApolloSearchResult> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error("APOLLO_API_KEY env var not set");
  }

  const body: Record<string, unknown> = { page, per_page: perPage };

  if (filter.industries && filter.industries.length > 0) {
    body.organization_industry_tag_ids = filter.industries;
  }

  if (filter.countries && filter.countries.length > 0) {
    body.organization_locations = filter.countries;
  }

  if (filter.minEmployees !== undefined || filter.maxEmployees !== undefined) {
    const lo = filter.minEmployees ?? 1;
    const hi = filter.maxEmployees ?? 1_000_000;
    body.organization_num_employees_ranges = [`${lo},${hi}`];
  }

  if (filter.keywords && filter.keywords.length > 0) {
    body.q_organization_keyword_tags = filter.keywords;
  }

  const response = await fetch(
    "https://api.apollo.io/v1/mixed_companies/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Apollo API error (${response.status}): ${errText.slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as {
    organizations?: ApolloOrganization[];
    total_entries?: number;
    page?: number;
    per_page?: number;
  };

  return {
    organizations: data.organizations ?? [],
    total_entries: data.total_entries ?? 0,
    page: data.page ?? page,
    per_page: data.per_page ?? perPage,
  };
}

export function buildIcpFilterFromEnv(): IcpFilter {
  const filter: IcpFilter = {};

  const industries = process.env.APOLLO_ICP_INDUSTRIES;
  if (industries) {
    filter.industries = industries
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const countries = process.env.APOLLO_ICP_COUNTRIES;
  if (countries) {
    filter.countries = countries
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const minEmp = process.env.APOLLO_ICP_MIN_EMPLOYEES;
  if (minEmp) {
    filter.minEmployees = parseInt(minEmp, 10);
  }

  const maxEmp = process.env.APOLLO_ICP_MAX_EMPLOYEES;
  if (maxEmp) {
    filter.maxEmployees = parseInt(maxEmp, 10);
  }

  const keywords = process.env.APOLLO_ICP_KEYWORDS;
  if (keywords) {
    filter.keywords = keywords
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return filter;
}
