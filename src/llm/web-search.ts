/**
 * Web search backends for the truth-engine.
 *
 * The LLM can emit `SEARCH: <query>` during generation. The harness intercepts,
 * executes the search via the best available backend, and feeds results back.
 *
 * Backend priority:
 *   1. Brave Search API (if BRAVE_API_KEY env var is set)
 *   2. DuckDuckGo Instant Answers (free, no key — works for knowledge queries)
 *
 * For best results, get a free Brave Search API key: https://brave.com/search/api/
 * (2000 queries/month free tier)
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  backend: string;
  error?: string;
}

/** Format search results for injection into the LLM context. */
export function formatSearchResults(resp: SearchResponse): string {
  if (resp.error) {
    return `[SEARCH ERROR for "${resp.query}": ${resp.error}]`;
  }
  if (resp.results.length === 0) {
    return `[No results found for "${resp.query}". Try a more specific query, or set BRAVE_API_KEY for full web search (free: https://brave.com/search/api/)]`;
  }
  const lines = resp.results.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.snippet.slice(0, 300)}\n   ${r.url}`
  );
  return `[WEB RESULTS for "${resp.query}" (via ${resp.backend}):\n${lines.join("\n\n")}\n]`;
}

// ── Brave Search API ──────────────────────────────────────────────────────────

const BRAVE_API_KEY = process.env.BRAVE_API_KEY ?? "";

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
}

async function searchBrave(query: string): Promise<SearchResponse> {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
    const resp = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_API_KEY,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { query, results: [], backend: "brave", error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }

    const data = await resp.json() as { web?: { results?: BraveWebResult[] } };
    const results: SearchResult[] = (data.web?.results ?? []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));

    return { query, results, backend: "brave" };
  } catch (err) {
    return { query, results: [], backend: "brave", error: String(err) };
  }
}

// ── DuckDuckGo HTML Search (free, no API key) ──────────────────────────────────
// Scrapes lite.duckduckgo.com — the no-JS version that returns clean HTML results.
// This is the only free backend that returns real web search results.

async function searchDuckDuckGo(query: string): Promise<SearchResponse> {
  try {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; truth-engine/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      return { query, results: [], backend: "ddg", error: `HTTP ${resp.status}` };
    }

    const html = await resp.text();

    // Parse result links and snippets from the lite HTML
    // Format: <a class='result-link' href="...">Title</a> ... <td class='result-snippet'>Snippet</td>
    const results: SearchResult[] = [];

    // Extract URL from DDG redirect wrapper: //duckduckgo.com/l/?uddg=ENCODED_URL&rut=...
    const decodeDDGUrl = (raw: string): string => {
      const m = raw.match(/uddg=([^&]+)/);
      if (m) {
        try { return decodeURIComponent(m[1]!); } catch { return raw; }
      }
      return raw;
    };

    // Find all result-link/snippet pairs
    const linkPattern = /<a[^>]*class='result-link'[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetPattern = /<td[^>]*class='result-snippet'[^>]*>([\s\S]*?)<\/td>/gi;

    const links: Array<{ title: string; url: string }> = [];
    let m;
    while ((m = linkPattern.exec(html)) !== null) {
      links.push({
        url: decodeDDGUrl(m[1]!),
        title: m[2]!.replace(/<[^>]*>/g, "").trim(),
      });
    }

    const snippets: string[] = [];
    while ((m = snippetPattern.exec(html)) !== null) {
      snippets.push(m[1]!.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim());
    }

    // Pair links with snippets (they appear in order)
    for (let i = 0; i < Math.min(links.length, snippets.length, 5); i++) {
      results.push({ title: links[i]!.title, url: links[i]!.url, snippet: snippets[i]! });
    }

    return { query, results, backend: "ddg" };
  } catch (err) {
    return { query, results: [], backend: "ddg", error: String(err) };
  }
}

// ── Unified search ────────────────────────────────────────────────────────────

/**
 * Search the web using the best available backend.
 * Tries Brave first (if key set), then falls back to DuckDuckGo Instant Answers.
 */
export async function searchWeb(query: string): Promise<SearchResponse> {
  if (BRAVE_API_KEY) {
    const braveResult = await searchBrave(query);
    if (braveResult.results.length > 0 || braveResult.error) {
      return braveResult;
    }
    // Brave returned empty but no error — try DDG too
    const ddgResult = await searchDuckDuckGo(query);
    if (ddgResult.results.length > 0) {
      return ddgResult;
    }
    return braveResult; // prefer Brave's error message over empty DDG
  }
  return searchDuckDuckGo(query);
}

// ── Web page fetching ─────────────────────────────────────────────────────────

export interface FetchPageResult {
  url: string;
  title: string;
  text: string;
  length: number;
  truncated: boolean;
  error?: string;
}

/**
 * Fetch and extract readable text content from a URL.
 * Strips HTML, scripts, styles, and navigation elements.
 * Capped at 8000 chars to fit within context window observations.
 */
export async function fetchWebPage(url: string): Promise<FetchPageResult> {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; truth-engine/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      return { url, title: "", text: "", length: 0, truncated: false, error: `HTTP ${resp.status}` };
    }

    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return { url, title: "", text: "", length: 0, truncated: false, error: `Not HTML: ${contentType.slice(0, 80)}` };
    }

    const html = await resp.text();
    if (html.length < 10) {
      return { url, title: "", text: "", length: 0, truncated: false, error: "Empty response" };
    }

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch?.[1]?.replace(/<[^>]*>/g, "").trim() ?? "";

    // Strip non-content elements before extracting text
    let cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

    // Convert block elements to newlines for readability
    cleaned = cleaned
      .replace(/<\/(div|p|h[1-6]|li|tr|article|section|main|aside|blockquote|pre|table|ul|ol|dl|figure|figcaption)[^>]*>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n");

    // Strip all remaining HTML tags
    let text = cleaned.replace(/<[^>]*>/g, "");

    // Decode HTML entities
    text = text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&nbsp;/g, " ");

    // Collapse whitespace
    text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

    const truncated = text.length > 8000;
    const final = text.slice(0, 8000);

    return { url, title, text: final, length: final.length, truncated };
  } catch (err: any) {
    return { url, title: "", text: "", length: 0, truncated: false, error: err.message ?? String(err) };
  }
}

/** Format a fetched page result for observation injection. */
export function formatFetchResult(result: FetchPageResult): string {
  if (result.error) {
    return `[FETCH ERROR for "${result.url}": ${result.error}]`;
  }
  const header = result.title ? `"${result.title}" (${result.url})` : result.url;
  const truncNote = result.truncated ? `\n[truncated to ${result.length} chars]` : "";
  return `[FETCHED: ${header} — ${result.length} chars${truncNote}]\n\n${result.text}`;
}
