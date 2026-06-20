/**
 * Company news fetcher — primary: NewsAPI, fallback: Google News RSS.
 * Targets funding rounds, leadership changes, and regulatory news.
 */

export interface NewsArticle {
  title: string;
  description: string | null;
  url: string;
  publishedAt: string;
  source: string;
}

export interface CompanyNews {
  companyName: string;
  articles: NewsArticle[];
  fetchedAt: string;
}

export async function fetchCompanyNews(
  companyName: string,
  maxArticles: number = 5,
): Promise<CompanyNews> {
  const apiKey = process.env.NEWS_API_KEY;
  if (apiKey) {
    return fetchFromNewsApi(companyName, maxArticles, apiKey);
  }
  return fetchFromGoogleRss(companyName, maxArticles);
}

async function fetchFromNewsApi(
  companyName: string,
  maxArticles: number,
  apiKey: string,
): Promise<CompanyNews> {
  const query = `"${companyName}" funding OR "leadership change" OR regulatory OR acquisition`;
  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query);
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", String(Math.min(maxArticles, 10)));
  url.searchParams.set("apiKey", apiKey);

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": "NexusSDR/1.0" },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `NewsAPI error (${response.status}): ${errText.slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as {
    articles?: Array<{
      title?: string;
      description?: string;
      url?: string;
      publishedAt?: string;
      source?: { name?: string };
    }>;
  };

  const articles: NewsArticle[] = (data.articles ?? []).slice(0, maxArticles).map((a) => ({
    title: a.title ?? "",
    description: a.description ?? null,
    url: a.url ?? "",
    publishedAt: a.publishedAt ?? new Date().toISOString(),
    source: a.source?.name ?? "Unknown",
  }));

  return { companyName, articles, fetchedAt: new Date().toISOString() };
}

async function fetchFromGoogleRss(
  companyName: string,
  maxArticles: number,
): Promise<CompanyNews> {
  const query = encodeURIComponent(
    `${companyName} funding OR leadership OR regulatory`,
  );
  const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

  let xmlText = "";
  try {
    const response = await fetch(rssUrl, {
      headers: { "User-Agent": "NexusSDR/1.0" },
    });
    if (response.ok) {
      xmlText = await response.text();
    }
  } catch {
    return { companyName, articles: [], fetchedAt: new Date().toISOString() };
  }

  const articles = parseRssItems(xmlText, maxArticles);
  return { companyName, articles, fetchedAt: new Date().toISOString() };
}

function parseRssItems(xml: string, maxItems: number): NewsArticle[] {
  const articles: NewsArticle[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null && articles.length < maxItems) {
    const item = match[1];
    const title = extractTag(item, "title");
    const link = extractTag(item, "link");
    const pubDate = extractTag(item, "pubDate");
    const source = extractTag(item, "source");
    const desc = extractTag(item, "description");

    if (title && link) {
      articles.push({
        title: decodeEntities(title),
        description: desc ? decodeEntities(desc) : null,
        url: link,
        publishedAt: pubDate
          ? new Date(pubDate).toISOString()
          : new Date().toISOString(),
        source: source || "Google News",
      });
    }
  }

  return articles;
}

function extractTag(xml: string, tag: string): string {
  const cdataRe = new RegExp(
    `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`,
  );
  const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const cdataMatch = cdataRe.exec(xml);
  if (cdataMatch) return cdataMatch[1].trim();
  const plainMatch = plainRe.exec(xml);
  if (plainMatch) return plainMatch[1].trim();
  return "";
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
