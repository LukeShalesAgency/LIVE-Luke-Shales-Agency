/**
 * lib/scraper.js
 *
 * Crawls a client's own website and returns plain text per page, so it can be
 * handed to Claude to draft an initial (or refreshed) knowledge base.
 *
 * Deliberately dependency-light: uses Node's built-in fetch and regex-based
 * HTML stripping rather than a full DOM parser. That's good enough for normal
 * server-rendered marketing/FAQ/policy pages. It will NOT see content that
 * only appears after JavaScript runs (a fully client-side-rendered React/Vue
 * site with no server-rendered HTML) — see README for the workaround.
 */

const MAX_PAGES_DEFAULT = 12;
const MAX_PAGES_CAP = 25;
const MAX_TOTAL_CHARS = 60000; // keeps the combined page text within a safe prompt size
const MAX_CHARS_PER_PAGE = 6000;
const FETCH_TIMEOUT_MS = 7000;
const CRAWL_DEADLINE_MS = 25000; // hard wall-clock cap per site — a slow or bot-throttling site can't stall the whole request
const BATCH_SIZE = 4; // pages fetched concurrently per round, instead of one at a time
const USER_AGENT = 'SitewrightKnowledgeBot/1.0 (+building an AI chatbot knowledge base for this site\'s own owner)';

function stripHtml(html) {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).trim() : '';
}

function extractMetaContent(html, propOrName) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${propOrName}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${propOrName}["']`,
    'i'
  );
  const m = html.match(re);
  return m ? stripHtml(m[1] || m[2] || '').trim() : '';
}

/**
 * Best-effort guess at the business's name from its homepage: prefers
 * og:site_name, then <title> with common trailing suffixes ("| Home",
 * "- Welcome", etc.) trimmed off, since a raw <title> is often noisier.
 */
function guessBusinessName(html) {
  const ogSiteName = extractMetaContent(html, 'og:site_name');
  if (ogSiteName) return ogSiteName;

  const title = extractTitle(html);
  if (!title) return '';
  return title.split(/\s[-|–—:]\s/)[0].trim();
}

/**
 * Fetches just the homepage (no crawl) — used to name a new client before
 * the full scrape runs.
 */
async function fetchHomepage(url) {
  return fetchHtml(url);
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  const re = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
  let match;
  while ((match = re.exec(html))) {
    try {
      const resolved = new URL(match[1], baseUrl);
      resolved.hash = '';
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') links.add(resolved.toString());
    } catch {
      // malformed href — skip it
    }
  }
  return links;
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Loads a site's sitemap.xml and returns real page URLs from it. Handles
 * both shapes a sitemap can take:
 *  - a direct <urlset> listing pages (what a small/hand-built site has)
 *  - a <sitemapindex> listing OTHER sitemap files (what Shopify, WordPress,
 *    and most CMS-driven sites use — /sitemap.xml itself has zero real
 *    pages in it, just pointers to sitemap_pages.xml, sitemap_products.xml,
 *    etc.) Missing this distinction meant the crawler found "pages" that
 *    were actually XML files, fetched none of them successfully (wrong
 *    content-type), and came back with nothing — this is why it silently
 *    failed on Shopify sites in particular.
 * For an index, it follows the 1-2 sub-sitemaps most likely to hold real
 * content (named like "pages" or "collections" rather than "products" or
 * "blog", since those tend to be huge and less useful for a knowledge base)
 * and pulls page URLs from those instead.
 */
async function tryLoadSitemap(origin) {
  const xml = await fetchOrNullXml(`${origin}/sitemap.xml`);
  if (!xml) return [];

  if (/<sitemapindex/i.test(xml)) {
    const subSitemapUrls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)]
      .map((m) => m[1].trim())
      .filter((u) => u.startsWith(origin));
    if (!subSitemapUrls.length) return [];

    const useful = subSitemapUrls.filter((u) => /page|collection|about|faq|help|support/i.test(u));
    const toFollow = (useful.length ? useful : subSitemapUrls).slice(0, 2);

    const subResults = await Promise.all(toFollow.map((sub) => fetchOrNullXml(sub)));
    const pageUrls = [];
    for (const subXml of subResults) {
      if (!subXml) continue;
      const urls = [...subXml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
      pageUrls.push(...urls.filter((u) => u.startsWith(origin)));
    }
    return pageUrls.slice(0, 40);
  }

  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
  return urls.filter((u) => u.startsWith(origin));
}

async function fetchOrNullXml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Crawl a site starting from startUrl, staying on the same origin.
 * Prefers sitemap.xml (if present) for full page coverage; otherwise follows
 * links breadth-first from the start page.
 *
 * Returns [{ url, title, text }, ...]
 */
async function crawlSite(startUrl, maxPages = MAX_PAGES_DEFAULT) {
  const capped = Math.max(1, Math.min(maxPages, MAX_PAGES_CAP));
  const start = new URL(startUrl);
  const origin = start.origin;
  const deadline = Date.now() + CRAWL_DEADLINE_MS;

  const sitemapUrls = await tryLoadSitemap(origin);
  const usingSitemap = sitemapUrls.length > 0;
  const queue = usingSitemap ? [...new Set([start.toString(), ...sitemapUrls])] : [start.toString()];

  const visited = new Set();
  const pages = [];
  let totalChars = 0;

  // fetches a few pages at once instead of one at a time, and gives up once
  // CRAWL_DEADLINE_MS has passed — so a slow site, or one that silently
  // throttles/ignores a bot's requests, can't stall the whole request for
  // minutes; it just returns whatever it managed to get in time.
  while (queue.length && pages.length < capped && totalChars < MAX_TOTAL_CHARS && Date.now() < deadline) {
    const batch = [];
    while (batch.length < BATCH_SIZE && queue.length) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      batch.push(url);
    }
    if (!batch.length) break;

    const fetched = await Promise.all(batch.map(async (url) => ({ url, html: await fetchHtml(url) })));

    for (const { url, html } of fetched) {
      if (!html) continue;
      const text = stripHtml(html);
      if (text.length < 40) continue; // near-empty page, skip

      const title = extractTitle(html);
      const trimmed = text.slice(0, MAX_CHARS_PER_PAGE);
      pages.push({ url, title, text: trimmed });
      totalChars += trimmed.length;

      if (!usingSitemap) {
        for (const link of extractLinks(html, url)) {
          try {
            if (new URL(link).origin === origin && !visited.has(link) && !queue.includes(link)) queue.push(link);
          } catch {
            // ignore
          }
        }
      }
      if (pages.length >= capped || totalChars >= MAX_TOTAL_CHARS) break;
    }
  }

  return pages;
}

const MAX_SITES = 6; // a sanity cap — nobody legitimately has more than a handful of source sites
const MAX_TOTAL_PAGES = 30; // across ALL sites combined, so 3 sites doesn't mean 3x the tokens per draft

/**
 * Crawls several sites (e.g. a main site plus a separate FAQ or support
 * subdomain/domain) and merges the results into one page list, each page
 * tagged with which site it came from. Splits the page budget evenly across
 * sites so adding more sources doesn't blow up the total crawl or the size
 * of what gets sent to Claude to draft from.
 *
 * Duplicate/near-duplicate URLs across sites (someone passing the same URL
 * twice, or two URLs that normalize to the same origin+path) are skipped.
 *
 * Returns [{ url, title, text, site }, ...]
 */
async function crawlSites(urls, maxPagesPerSite = MAX_PAGES_DEFAULT) {
  const uniqueUrls = [...new Set((urls || []).map((u) => (u || '').trim()).filter(Boolean))].slice(0, MAX_SITES);
  if (!uniqueUrls.length) return [];

  const perSiteCap = Math.max(1, Math.min(maxPagesPerSite, Math.floor(MAX_TOTAL_PAGES / uniqueUrls.length)));

  const results = await Promise.all(
    uniqueUrls.map(async (u) => {
      try {
        const pages = await crawlSite(u, perSiteCap);
        return pages.map((p) => ({ ...p, site: u }));
      } catch {
        return []; // one bad URL in the list shouldn't sink the whole scrape
      }
    })
  );

  const seen = new Set();
  const merged = [];
  for (const pages of results) {
    for (const p of pages) {
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      merged.push(p);
      if (merged.length >= MAX_TOTAL_PAGES) return merged;
    }
  }
  return merged;
}

module.exports = { crawlSite, crawlSites, stripHtml, guessBusinessName, fetchHomepage };
