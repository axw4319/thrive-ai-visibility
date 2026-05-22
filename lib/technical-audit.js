const fetch = require('node-fetch');
const cheerio = require('cheerio');

/*
  Real technical + GEO audit.
  Every item's pass/warn/fail status is derived from an HTTP fetch or HTML parse —
  nothing here is synthesized from the visibility score.
*/

const UA = 'Mozilla/5.0 (compatible; AIVisibilityBot/1.0)';
const FETCH_OPTS = { headers: { 'User-Agent': UA }, timeout: 8000, redirect: 'follow' };

async function fetchOk(url) {
  try {
    const res = await fetch(url, FETCH_OPTS);
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.message };
  }
}

/*
  robots.txt parse → per-user-agent allow/disallow for /
*/
function parseRobots(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  // Collect groups of UAs and their disallow rules
  const groups = [];
  let currentUAs = [];
  let currentRules = [];
  const push = () => {
    if (currentUAs.length || currentRules.length) groups.push({ ua: [...currentUAs], rules: [...currentRules] });
  };
  for (const line of lines) {
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim();
    if (key === 'user-agent') {
      // New group if we already have rules
      if (currentRules.length) { push(); currentUAs = []; currentRules = []; }
      currentUAs.push(val.toLowerCase());
    } else if (key === 'disallow' || key === 'allow') {
      currentRules.push({ type: key, path: val });
    }
  }
  push();

  // For a given UA, find the effective rule for path "/"
  function pathAllowed(uaName, path = '/') {
    const name = uaName.toLowerCase();
    // Find most specific group (UA name match) else fall back to *
    const matching = groups.find(g => g.ua.includes(name));
    const fallback = groups.find(g => g.ua.includes('*'));
    const group = matching || fallback;
    if (!group) return true;  // No rules = allowed
    // Evaluate rules in order; first match wins (RFC 9309 style)
    let allowed = true;
    for (const r of group.rules) {
      if (!r.path) continue;
      if (path.startsWith(r.path)) {
        allowed = r.type === 'allow';
        // Keep scanning for a more-specific match
      }
    }
    return allowed;
  }

  function hasExplicitUA(uaName) {
    const name = uaName.toLowerCase();
    return groups.some(g => g.ua.includes(name));
  }

  return { groups, pathAllowed, hasExplicitUA };
}

/*
  Parse HTML once. Re-uses the scraped HTML if provided, otherwise fetches.
*/
async function parseHomepage(url, providedHtml) {
  let html = providedHtml;
  if (!html) {
    const r = await fetchOk(url);
    if (!r.ok) return null;
    html = r.text;
  }
  const $ = cheerio.load(html);
  return {
    $,
    title: $('title').first().text().trim(),
    metaDesc: $('meta[name="description"]').attr('content') || '',
    canonical: $('link[rel="canonical"]').attr('href') || '',
    htmlLang: $('html').attr('lang') || '',
    og: {
      title: $('meta[property="og:title"]').attr('content') || '',
      desc:  $('meta[property="og:description"]').attr('content') || '',
      image: $('meta[property="og:image"]').attr('content') || '',
      url:   $('meta[property="og:url"]').attr('content') || '',
    },
    twitter: {
      card: $('meta[name="twitter:card"]').attr('content') || '',
      title: $('meta[name="twitter:title"]').attr('content') || '',
    },
    h1Count: $('h1').length,
    h2Count: $('h2').length,
    h3Count: $('h3').length,
    images: (() => {
      const imgs = $('img');
      const total = imgs.length;
      let withAlt = 0;
      imgs.each((_, el) => {
        const alt = ($(el).attr('alt') || '').trim();
        if (alt.length > 0) withAlt++;
      });
      return { total, withAlt };
    })(),
    jsonLd: (() => {
      const types = new Set();
      const raw = [];
      $('script[type="application/ld+json"]').each((_, el) => {
        const txt = $(el).html() || '';
        raw.push(txt);
        try {
          const obj = JSON.parse(txt);
          const all = Array.isArray(obj) ? obj : (obj['@graph'] ? obj['@graph'] : [obj]);
          for (const node of all) {
            const t = node['@type'];
            if (Array.isArray(t)) t.forEach(x => types.add(x));
            else if (t) types.add(t);
          }
        } catch {}
      });
      return { types: [...types], raw: raw.join('\n') };
    })(),
    hasDateModified: /"dateModified"\s*:/i.test(html),
    hasArticleSchema: /"@type"\s*:\s*"Article"|"@type"\s*:\s*\[[^\]]*"Article"/i.test(html),
  };
}

/*
  Run the full audit. Returns the same shape expected by the public report:
    [{ title, score, items: [{ status, title, note }, ...] }, ...]
*/
async function runTechnicalAudit(websiteUrl, scrapedHtml = null) {
  const u = new URL(websiteUrl);
  const origin = u.origin;

  // Fetch robots.txt, llms.txt, sitemap.xml in parallel
  const [robotsRes, llmsRes, sitemapRes] = await Promise.all([
    fetchOk(origin + '/robots.txt'),
    fetchOk(origin + '/llms.txt'),
    fetchOk(origin + '/sitemap.xml'),
  ]);

  const robots = robotsRes.ok ? parseRobots(robotsRes.text) : null;
  const home = await parseHomepage(websiteUrl, scrapedHtml);

  // ── AI crawler access ──
  const crawlerItems = [];
  const crawlerCheck = (ua, displayName, note) => {
    if (!robotsRes.ok) return { status: 'warn', title: `${displayName} access`, note: 'robots.txt not reachable — treat as unrestricted but verify manually.' };
    const allowed = robots.pathAllowed(ua, '/');
    return { status: allowed ? 'pass' : 'fail', title: `${displayName} ${allowed ? 'allowed' : 'blocked'} in robots.txt`, note };
  };
  crawlerItems.push(crawlerCheck('GPTBot', 'GPTBot', 'OpenAI crawler — drives ChatGPT citations.'));
  crawlerItems.push(crawlerCheck('ClaudeBot', 'ClaudeBot', 'Anthropic crawler — drives Claude / Perplexity citations.'));
  crawlerItems.push(crawlerCheck('PerplexityBot', 'PerplexityBot', 'Perplexity crawler.'));
  // Google-Extended: check explicit mention in robots.txt
  if (!robotsRes.ok) {
    crawlerItems.push({ status: 'warn', title: 'Google-Extended: robots.txt missing', note: 'Add robots.txt so you can control Google-Extended explicitly.' });
  } else {
    const hasGoogleExtended = robots.hasExplicitUA('Google-Extended') || robots.hasExplicitUA('google-extended');
    const allowed = robots.pathAllowed('Google-Extended', '/');
    if (!hasGoogleExtended) {
      crawlerItems.push({ status: 'warn', title: 'Google-Extended not explicitly allowed', note: 'Without an explicit rule, Google may skip your site for Gemini / AI Overview training.' });
    } else {
      crawlerItems.push({ status: allowed ? 'pass' : 'fail', title: `Google-Extended ${allowed ? 'allowed' : 'blocked'}`, note: 'Controls Gemini / AI Overview training.' });
    }
  }
  // llms.txt
  crawlerItems.push({
    status: llmsRes.ok ? 'pass' : 'fail',
    title: llmsRes.ok ? 'llms.txt present at site root' : 'Missing /llms.txt',
    note: llmsRes.ok ? 'Declares canonical content to LLM crawlers.' : 'Add /llms.txt to signal canonical content to LLM crawlers. ~15 minute task.',
  });
  const crawlerScore = pctPass(crawlerItems);

  // ── Structured data ──
  const sdItems = [];
  if (home) {
    const types = home.jsonLd.types;
    const has = (t) => types.includes(t);
    sdItems.push({ status: has('Organization') ? 'pass' : 'fail', title: `Organization schema ${has('Organization') ? 'present' : 'missing'}`, note: 'Entity resolution for AI knowledge graphs.' });
    sdItems.push({ status: (has('WebPage') || has('Article') || home.hasArticleSchema) ? 'pass' : 'warn', title: `WebPage / Article schema ${(has('WebPage') || has('Article') || home.hasArticleSchema) ? 'present' : 'missing'}`, note: 'Article metadata for AI extraction.' });
    sdItems.push({ status: has('FAQPage') ? 'pass' : 'fail', title: `FAQPage schema ${has('FAQPage') ? 'present' : 'missing'}`, note: '#1 signal for AI Overview inclusion.' });
    sdItems.push({ status: has('Service') ? 'pass' : 'warn', title: `Service schema ${has('Service') ? 'present' : 'missing'}`, note: 'Required for category match on "best X for Y" queries.' });
    sdItems.push({ status: (has('Person') || has('Author')) ? 'pass' : 'warn', title: `Author / Person schema ${(has('Person') || has('Author')) ? 'present' : 'missing'}`, note: 'E-E-A-T trust signal.' });
  } else {
    sdItems.push({ status: 'warn', title: 'Homepage not parseable', note: 'Could not parse structured data — check site reachability.' });
  }
  const sdScore = pctPass(sdItems);

  // ── Citability signals ──
  const citeItems = [];
  if (home) {
    // TL;DR-ish check: do any H2/H3 titles contain "tldr"/"summary"/"key takeaways"?
    const $ = home.$;
    const tldrHit = $('h1,h2,h3,h4').toArray().some(el => /tl;dr|tldr|summary|key takeaways|in short/i.test($(el).text()));
    citeItems.push({
      status: tldrHit ? 'pass' : 'warn',
      title: tldrHit ? 'TL;DR / summary block on homepage' : 'No obvious TL;DR / summary section',
      note: tldrHit ? 'Helps Bing / ChatGPT Search extract the first ~100 words.' : 'Add a TL;DR block to your top pages — Bing / ChatGPT Search extracts the first ~100 words as the answer.',
    });
    citeItems.push({
      status: home.h1Count === 1 ? 'pass' : home.h1Count > 1 ? 'warn' : 'fail',
      title: home.h1Count === 1 ? 'Exactly one H1 on homepage' : `Found ${home.h1Count} H1 tags on homepage`,
      note: 'One clear H1 aligned to search intent is optimal.',
    });
    citeItems.push({
      status: home.h2Count >= 2 ? 'pass' : 'warn',
      title: home.h2Count >= 2 ? `Heading hierarchy used (${home.h2Count} H2s)` : 'Heading hierarchy is thin',
      note: 'Structured passages with H2/H3 are extracted by AI more often than prose walls.',
    });
    citeItems.push({
      status: home.hasDateModified ? 'pass' : 'warn',
      title: home.hasDateModified ? 'dateModified present in schema' : 'dateModified missing',
      note: 'Freshness is a confirmed AI + Google ranking signal.',
    });
    // List usage
    const lists = $('ul,ol').length;
    citeItems.push({
      status: lists >= 3 ? 'pass' : 'warn',
      title: lists >= 3 ? `${lists} lists on homepage` : `Only ${lists} lists on homepage`,
      note: 'Bulleted / numbered lists are extracted 3× more often than prose answers.',
    });
  }
  const citeScore = pctPass(citeItems);

  // ── Content depth & E-E-A-T (limited — only things we can verify from homepage) ──
  const eeatItems = [];
  if (home) {
    const $ = home.$;
    const hasBlogLink = $('a[href*="/blog"],a[href*="/news"],a[href*="/resources"],a[href*="/articles"]').length > 0;
    eeatItems.push({
      status: hasBlogLink ? 'pass' : 'warn',
      title: hasBlogLink ? 'Blog / resources section linked from homepage' : 'No obvious blog / resources section',
      note: 'A regularly-updated blog is the baseline for AI crawler attention (~50+ posts is the SEJ threshold).',
    });
    const hasCaseStudy = $('a[href*="/case-studies"],a[href*="/case-study"],a[href*="/customers"],a[href*="/stories"]').length > 0;
    eeatItems.push({
      status: hasCaseStudy ? 'pass' : 'warn',
      title: hasCaseStudy ? 'Case studies / customer stories linked' : 'No case studies linked from homepage',
      note: 'Quantified outcomes are highly AI-quotable.',
    });
    const hasAuthor = home.jsonLd.types.includes('Person') || /"author"\s*:/i.test(home.jsonLd.raw);
    eeatItems.push({
      status: hasAuthor ? 'pass' : 'warn',
      title: hasAuthor ? 'Author metadata present in schema' : 'No author metadata in schema',
      note: 'Tie bylines to real humans with sameAs links — Google Quality Rater Guidelines weight this.',
    });
  }
  const eeatScore = pctPass(eeatItems);

  // ── Meta & social ──
  const metaItems = [];
  if (home) {
    metaItems.push({
      status: home.title ? (home.title.length > 10 && home.title.length < 80 ? 'pass' : 'warn') : 'fail',
      title: home.title ? `<title>: "${home.title.slice(0, 80)}"` : 'Missing <title>',
      note: 'Keyword-led, 50–60 chars recommended.',
    });
    metaItems.push({
      status: home.metaDesc ? (home.metaDesc.length > 50 ? 'pass' : 'warn') : 'fail',
      title: home.metaDesc ? 'Meta description present' : 'Missing meta description',
      note: home.metaDesc ? `${home.metaDesc.length} characters.` : 'Google will synthesize one if missing — usually worse than yours.',
    });
    const ogComplete = home.og.title && home.og.desc && home.og.image;
    metaItems.push({
      status: ogComplete ? 'pass' : home.og.title ? 'warn' : 'fail',
      title: ogComplete ? 'Open Graph tags complete' : 'Open Graph incomplete',
      note: 'LinkedIn / Slack previews.',
    });
    metaItems.push({
      status: home.twitter.card ? 'pass' : 'warn',
      title: home.twitter.card ? `Twitter Card: ${home.twitter.card}` : 'Missing Twitter Card metadata',
      note: 'Recommend summary_large_image site-wide.',
    });
    metaItems.push({
      status: home.canonical ? 'pass' : 'warn',
      title: home.canonical ? 'Canonical tag present' : 'Canonical tag missing',
      note: home.canonical ? home.canonical : 'Add <link rel="canonical"> to every page.',
    });
    metaItems.push({
      status: /^https:/.test(websiteUrl) ? 'pass' : 'fail',
      title: /^https:/.test(websiteUrl) ? 'HTTPS enabled' : 'Not HTTPS',
      note: 'Security + SEO ranking signal.',
    });
    metaItems.push({
      status: home.htmlLang ? 'pass' : 'warn',
      title: home.htmlLang ? `HTML lang="${home.htmlLang}"` : 'Missing <html lang>',
      note: 'Required for accessibility + language targeting.',
    });
  }
  const metaScore = pctPass(metaItems);

  // ── SEO fundamentals (the ones we can actually verify from homepage + sitemap) ──
  const seoItems = [];
  if (home) {
    const altPct = home.images.total > 0 ? (home.images.withAlt / home.images.total) * 100 : 100;
    seoItems.push({
      status: altPct >= 90 ? 'pass' : altPct >= 70 ? 'warn' : 'fail',
      title: `Image alt coverage on homepage: ${Math.round(altPct)}% (${home.images.withAlt}/${home.images.total})`,
      note: 'Descriptive alt text on content images.',
    });
  }
  seoItems.push({
    status: sitemapRes.ok ? 'pass' : 'fail',
    title: sitemapRes.ok ? 'XML sitemap present at /sitemap.xml' : 'No /sitemap.xml found',
    note: sitemapRes.ok ? `${sitemapRes.text.length.toLocaleString()} bytes.` : 'Submit an XML sitemap to GSC + Bing Webmaster Tools.',
  });
  // Internal link density on homepage
  if (home) {
    const internalLinks = home.$('a[href^="/"], a[href*="' + new URL(websiteUrl).hostname + '"]').length;
    seoItems.push({
      status: internalLinks >= 10 ? 'pass' : 'warn',
      title: `${internalLinks} internal links on homepage`,
      note: 'Every indexable page should be reachable in ≤ 3 clicks.',
    });
  }
  seoItems.push({
    status: robotsRes.ok ? 'pass' : 'warn',
    title: robotsRes.ok ? 'robots.txt present' : 'No robots.txt found',
    note: 'Even a permissive robots.txt is better than none — crawlers look for it first.',
  });
  const seoScore = pctPass(seoItems);

  // ── Return in the existing audit shape ──
  return [
    { title: 'AI Crawler Access',      score: crawlerScore, items: crawlerItems },
    { title: 'Structured Data',        score: sdScore,      items: sdItems },
    { title: 'Citability Signals',     score: citeScore,    items: citeItems },
    { title: 'Content Depth & E-E-A-T', score: eeatScore,   items: eeatItems },
    { title: 'Meta & Social',          score: metaScore,    items: metaItems },
    { title: 'SEO Fundamentals',       score: seoScore,     items: seoItems },
    // NOTE: Performance (Core Web Vitals) requires a PSI / Lighthouse call — deliberately
    // omitted so we never show made-up CWV numbers. Add when PSI_API_KEY is configured.
  ];
}

function pctPass(items) {
  if (!items.length) return 0;
  const map = { pass: 1, warn: 0.5, fail: 0 };
  const total = items.reduce((s, it) => s + (map[it.status] ?? 0), 0);
  return Math.round((total / items.length) * 100);
}

module.exports = { runTechnicalAudit };
