const db = require('../database');
const { normalizeBrand } = require('./brand-extractor');

// Ensure target brand always appears in top brands list (at end if not in top 10)
function buildTopBrandsWithTarget(metrics, targetNorm, brandName) {
  const top = metrics.slice(0, 10);
  const targetInTop = top.some(m => m.normalized_name === targetNorm);
  if (!targetInTop) {
    const targetMetric = metrics.find(m => m.normalized_name === targetNorm);
    if (targetMetric) {
      top.push(targetMetric);
    } else {
      // Brand wasn't found at all — add with zeros
      top.push({
        brand_name: brandName,
        normalized_name: targetNorm,
        visibility_pct: 0,
        market_share_pct: 0,
        avg_rank: 0,
        mention_count: 0,
        avg_sentiment: 0
      });
    }
  }
  return top;
}

function assembleReport(scanId) {
  const scan = db.getScan.get(scanId);
  if (!scan) return null;

  const metrics = db.getMetrics.all(scanId);
  const mentions = db.getMentions.all(scanId);
  const prompts = db.getPrompts.all(scanId);
  const responses = db.getResponses.all(scanId);
  const targetNorm = normalizeBrand(scan.brand_name);

  // Find target brand metrics
  const targetMetrics = metrics.find(m => m.normalized_name === targetNorm) || {
    visibility_pct: 0, market_share_pct: 0, avg_rank: 0, mention_count: 0, avg_sentiment: 0
  };

  // Models used
  const models = [...new Set(responses.map(r => r.model_name))];

  // Per-model breakdown for all brands
  const modelBreakdown = {};
  for (const model of models) {
    const modelMentions = mentions.filter(m => m.model_name === model);
    const brandCounts = {};
    for (const m of modelMentions) {
      if (!brandCounts[m.normalized_name]) brandCounts[m.normalized_name] = { name: m.brand_name, count: 0 };
      brandCounts[m.normalized_name].count++;
    }
    const sorted = Object.values(brandCounts).sort((a, b) => b.count - a.count);
    const top5 = sorted.slice(0, 5);
    // Ensure target brand always appears in model breakdown
    if (!top5.some(b => normalizeBrand(b.name) === targetNorm)) {
      const targetEntry = brandCounts[targetNorm];
      top5.push(targetEntry || { name: scan.brand_name, count: 0 });
    }
    modelBreakdown[model] = top5;
  }

  // Per-prompt results
  const promptResults = prompts.map(p => {
    const promptResponses = responses.filter(r => r.prompt_text === p.prompt_text);
    const promptMentions = mentions.filter(m => m.prompt_text === p.prompt_text);
    const brandsFound = [...new Set(promptMentions.map(m => m.normalized_name))].length;

    // Target brand visibility for this prompt: % of model responses that mentioned it
    const targetMentions = promptMentions.filter(m => m.normalized_name === targetNorm);
    const modelsForPrompt = [...new Set(promptResponses.map(r => r.model_name))];
    const modelsWithTarget = [...new Set(targetMentions.map(m => m.model_name))];
    const promptVisibility = modelsForPrompt.length > 0
      ? Math.round((modelsWithTarget.length / modelsForPrompt.length) * 1000) / 10
      : 0;

    // Top brand for this prompt
    const brandCounts = {};
    for (const m of promptMentions) {
      if (!brandCounts[m.normalized_name]) brandCounts[m.normalized_name] = { name: m.brand_name, count: 0 };
      brandCounts[m.normalized_name].count++;
    }
    const topBrand = Object.values(brandCounts).sort((a, b) => b.count - a.count)[0];

    // Top 3 competitors for this prompt
    const top3 = Object.values(brandCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map(b => b.name);

    return {
      prompt: p.prompt_text,
      category: p.category,
      brands_found: brandsFound,
      visibility_pct: promptVisibility,
      top_brand: topBrand ? topBrand.name : '-',
      top_competitors: top3
    };
  });

  // Leader gap
  const leader = metrics[0];
  const leaderGap = leader && leader.normalized_name !== targetNorm
    ? Math.round(leader.visibility_pct - targetMetrics.visibility_pct)
    : 0;

  return {
    scan: {
      id: scan.id,
      brand_name: scan.brand_name,
      website_url: scan.website_url,
      industry: scan.industry,
      location: scan.location,
      created_at: scan.created_at
    },
    target: {
      ...targetMetrics,
      brand_name: scan.brand_name,
      normalized_name: targetNorm
    },
    leader: leader ? { brand_name: leader.brand_name, visibility_pct: leader.visibility_pct } : null,
    leader_gap: leaderGap,
    brands_tracked: metrics.length,
    total_prompts: prompts.length,
    total_conversations: responses.filter(r => r.raw_response).length,
    models,
    metrics: metrics.slice(0, 50),
    model_breakdown: modelBreakdown,
    prompt_results: promptResults,
    top_brands: buildTopBrandsWithTarget(metrics, targetNorm, scan.brand_name)
  };
}

/*
  Transform the raw assembleReport() output into the shape the public /ai-visibility-checker/
  frontend expects (matches the demo-mode buildDemoReport shape).
*/
const MODEL_META = {
  chatgpt:            { name: 'ChatGPT',             color: '#10a37f', cls: 'plat-gpt',
    logo: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073z"/></svg>' },
  gemini:             { name: 'Gemini',              color: '#9b72cb', cls: 'plat-gem',
    logo: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M12 2L14 10 22 12 14 14 12 22 10 14 2 12 10 10z"/></svg>' },
  perplexity:         { name: 'Perplexity',          color: '#20b2aa', cls: 'plat-ppx',
    logo: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><circle cx="12" cy="12" r="10" fill="none" stroke="#fff" stroke-width="2"/><path d="M12 6v12M6 12h12" stroke="#fff" stroke-width="2"/></svg>' },
  google_ai_overview: { name: 'Google AI Overviews', color: '#4285f4', cls: 'plat-goog',
    logo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#4285f4"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34a853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09 0-.73.13-1.43.35-2.09V7.07H2.18A10.97 10.97 0 0 0 1 12c0 1.78.43 3.46 1.18 4.93l3.66-2.84z" fill="#fbbc05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#ea4335"/></svg>' },
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }

function assemblePublicReport(scanId) {
  const raw = assembleReport(scanId);
  if (!raw) return null;

  const { scan, target, metrics, prompt_results, models } = raw;

  // ── Per-platform visibility for the target brand ──
  const db = require('../database');
  const mentions = db.getMentions.all(scanId);
  const prompts = db.getPrompts.all(scanId);
  const targetNorm = (target && target.normalized_name) || '';
  const totalPrompts = prompts.length;

  const platforms = models.map(m => {
    const modelTargetMentions = mentions.filter(x => x.model_name === m && x.normalized_name === targetNorm);
    const promptsWithTarget = new Set(modelTargetMentions.map(x => x.prompt_text));
    const visibility = totalPrompts > 0 ? Math.round((promptsWithTarget.size / totalPrompts) * 100) : 0;
    const avgRank = modelTargetMentions.length > 0
      ? +(modelTargetMentions.reduce((s, x) => s + (x.position || 0), 0) / modelTargetMentions.length).toFixed(1)
      : 0;
    const meta = MODEL_META[m] || { name: m, color: '#888', cls: '', logo: '' };
    return {
      key: m,
      name: meta.name,
      visibility,
      mentions: modelTargetMentions.length,
      avg_rank: avgRank,
      color: meta.color,
      cls: meta.cls,
      logo: meta.logo,
    };
  });

  // Ensure consistent order: chatgpt, gemini, perplexity, aio
  const order = ['chatgpt', 'gemini', 'perplexity', 'google_ai_overview'];
  platforms.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  // Overall weighted score = avg of platform visibility (range 0–100)
  const score = platforms.length > 0
    ? clamp(platforms.reduce((s, p) => s + p.visibility, 0) / platforms.length, 0, 100)
    : 0;

  const grades = ['Critical — lots to fix', 'Weak — big upside', 'Fair — room to climb', 'Good — a few gaps', 'Strong — keep pushing'];
  const score_grade = grades[Math.min(4, Math.floor(score / 20))];

  // ── Competitor leaderboard ──
  const totalMentions = mentions.length;
  const competitors = metrics.slice(0, 10).map((m, i) => ({
    rank: i + 1,
    brand: m.brand_name,
    visibility: Math.round(m.visibility_pct),
    mentions: m.mention_count,
    avg_rank: m.avg_rank,
    sov: m.market_share_pct,
    you: m.normalized_name === targetNorm,
  }));
  // Ensure target is in the list even if outside top-10
  if (target && !competitors.some(c => c.you)) {
    const targetMetric = metrics.find(m => m.normalized_name === targetNorm);
    competitors.push({
      rank: competitors.length + 1,
      brand: target.brand_name,
      visibility: Math.round(targetMetric?.visibility_pct || 0),
      mentions: targetMetric?.mention_count || 0,
      avg_rank: targetMetric?.avg_rank || 0,
      sov: targetMetric?.market_share_pct || 0,
      you: true,
    });
  }

  const leader = competitors[0];
  const youRow = competitors.find(c => c.you);
  const gap = youRow && leader && !leader.you ? Math.max(0, leader.visibility - youRow.visibility) : 0;

  // ── Stat strip ──
  const modelsCiting = platforms.filter(p => p.visibility >= 25).length;
  const worst = [...platforms].sort((a, b) => a.visibility - b.visibility)[0];
  const avgPos = (target && target.avg_rank) ? +target.avg_rank.toFixed(1) : 0;
  const stats = [
    { label: 'AI Mentions',           value: target.mention_count || 0,
      delta: score > 50 ? `Across ${modelsCiting} platforms` : 'Low total vs category',
      dir: score > 50 ? 'pos' : 'neg' },
    { label: 'Models citing you',     value: `${modelsCiting} / ${platforms.length}`,
      delta: modelsCiting < platforms.length ? `Missing on ${worst?.name || 'some platforms'}` : 'Cited on every platform',
      dir: modelsCiting < platforms.length ? 'neg' : 'pos' },
    { label: 'Share of voice',        value: (target.market_share_pct || 0).toFixed(1) + '%',
      delta: `Rank #${youRow?.rank || '—'} of ${competitors.length}`,
      dir: (youRow && youRow.rank <= 3) ? 'pos' : 'neg' },
    { label: 'Avg position in list',  value: avgPos || '—',
      delta: !avgPos ? 'Not yet cited' : avgPos < 3 ? 'Strong (lower = better)' : avgPos < 5 ? 'Middling' : 'Buried — push for top 3',
      dir: avgPos && avgPos < 3.5 ? 'pos' : 'neg' },
  ];

  // ── Insights ──
  const best = [...platforms].sort((a, b) => b.visibility - a.visibility)[0] || { name: 'None', visibility: 0 };
  const insights = [
    { tone: best.visibility >= 60 ? 'good' : 'info',
      title: `Strongest on ${best.name} (${best.visibility}%)`,
      body: best.visibility >= 60
        ? `You're consistently cited here — this is your anchor channel. Keep leveraging it.`
        : `${best.name} is your best channel but still below category average — the whole funnel needs work.` },
    { tone: worst && worst.visibility < 30 ? 'bad' : 'warn',
      title: worst ? `Only ${worst.visibility}% visibility on ${worst.name}` : 'No platform data',
      body: worst && worst.name.includes('Overview')
        ? `SEO authority isn't translating into AI Overview inclusion. Schema + passage structure are likely holding you back.`
        : worst ? `${worst.name} is a weak channel. Schema, freshness, and citability fixes typically lift this 2–3×.`
               : 'Check scan logs.' },
    { tone: gap > 30 ? 'bad' : gap > 15 ? 'warn' : 'good',
      title: youRow && youRow.rank === 1 ? `You're #1 in your category` : `${gap} pts behind ${leader?.brand || 'leader'}`,
      body: youRow && youRow.rank === 1
        ? `You're ahead — but AI rankings shift fast. Ship freshness signals and defend.`
        : `Closing half of that gap is realistic in 60 days with schema, listicle outreach, and FAQ structure.` },
    { tone: 'info',
      title: `You rank #${youRow?.rank || '—'} of ${competitors.length} brands tracked`,
      body: `Across the ${totalPrompts} buyer prompts we ran, these are the competitors AI mentioned most in your category.` },
  ];

  // ── Prompt matrix ──
  const promptsOut = (prompt_results || []).map(pr => {
    // Which models cited the target on this prompt?
    const modelsForThis = mentions
      .filter(m => m.prompt_text === pr.prompt && m.normalized_name === targetNorm)
      .map(m => m.model_name);
    const uniqModels = [...new Set(modelsForThis)];
    return {
      q: pr.prompt,
      cat: pr.category || 'recommendation',
      vis: pr.visibility_pct,
      models: uniqModels,
      top: pr.top_brand || '—',
    };
  });

  // ── Topic coverage (by category) ──
  const categoriesMap = {};
  for (const pr of prompt_results || []) {
    const cat = pr.category || 'other';
    if (!categoriesMap[cat]) categoriesMap[cat] = { total: 0, score: 0 };
    categoriesMap[cat].total += 1;
    categoriesMap[cat].score += pr.visibility_pct;
  }
  const topics = Object.keys(categoriesMap);
  const topic_scores = topics.map(k => Math.round(categoriesMap[k].score / categoriesMap[k].total));

  // ── Audits: real data from the technical-audit module, stored on scan.audit_json ──
  // Fallback to an empty list if the audit didn't run (shouldn't happen normally).
  let audits = [];
  try {
    const row = db.db.prepare('SELECT audit_json FROM scans WHERE id = ?').get(scanId);
    if (row && row.audit_json) audits = JSON.parse(row.audit_json);
  } catch (e) {
    console.error('[public-report] audit read failed:', e.message);
  }

  // ── Recommendations (static best-practice list, score-sensitive ordering not required) ──
  const recommendations = buildRecommendations();

  // ── Sources: leave empty for now; we don't yet extract citation URLs ──
  const sources = [];

  return {
    scan: {
      id: scan.id,
      brand_name: scan.brand_name,
      website_url: scan.website_url,
      industry: scan.industry,
      location: scan.location,
      created_at: scan.created_at,
    },
    score,
    score_grade,
    insights,
    stats,
    platforms,
    competitors,
    topics, topic_scores,
    sources,
    prompts: promptsOut,
    audits,
    recommendations,
  };
}

function buildAudits(score) {
  const flip = (t) => score >= t ? 'pass' : score >= (t - 20) ? 'warn' : 'fail';
  return [
    { title: 'AI Crawler Access', score: clamp(score + 20, 30, 95), items: [
      { status: flip(40), title: 'GPTBot allowed in robots.txt', note: 'OpenAI crawler access.' },
      { status: flip(40), title: 'ClaudeBot & PerplexityBot allowed', note: 'Anthropic & Perplexity coverage.' },
      { status: flip(70), title: 'Google-Extended explicit allow',   note: 'Needed for Gemini / AI Overviews training.' },
      { status: score >= 80 ? 'pass' : 'fail', title: 'llms.txt at site root', note: 'Declares canonical content to LLM crawlers.' },
    ]},
    { title: 'Structured Data', score: clamp(score + 8, 25, 95), items: [
      { status: flip(40), title: 'Organization schema', note: 'Entity resolution.' },
      { status: flip(55), title: 'WebPage / Article schema', note: 'Article metadata for AI extraction.' },
      { status: flip(70), title: 'FAQPage schema',         note: '#1 signal for AI Overview inclusion.' },
      { status: flip(80), title: 'Service schema',         note: 'Category match for "best X for Y" queries.' },
      { status: flip(75), title: 'Author / Person schema', note: 'E-E-A-T trust signal.' },
    ]},
    { title: 'Citability Signals', score: clamp(score - 5, 20, 90), items: [
      { status: flip(65), title: 'TL;DR blocks on blog posts',    note: 'Bing/ChatGPT extract the top 100 words.' },
      { status: flip(45), title: 'Heading hierarchy (H1/H2/H3)',  note: 'Structured passage extraction.' },
      { status: flip(75), title: 'dateModified present',          note: 'Freshness signal — AI drops stale content.' },
      { status: flip(65), title: 'Bulleted / numbered lists in answers', note: 'Lists are extracted 3× more often.' },
    ]},
    { title: 'Content Depth & E-E-A-T', score: clamp(score + 12, 30, 96), items: [
      { status: flip(40), title: '50+ published articles',       note: 'SEJ threshold for crawler attention.' },
      { status: flip(55), title: 'Case studies with outcomes',   note: 'Quantified results are AI-quotable.' },
      { status: flip(70), title: 'Author bios with credentials', note: 'Real humans + sameAs links.' },
      { status: flip(85), title: 'Original research / data',     note: 'AI prefers primary sources.' },
    ]},
    { title: 'Meta & Social', score: clamp(score + 15, 40, 98), items: [
      { status: flip(30), title: 'Unique <title> on every page', note: 'Good.' },
      { status: flip(40), title: 'Meta descriptions',            note: 'Social / SERP snippet.' },
      { status: flip(55), title: 'Open Graph complete',          note: 'LinkedIn/Slack preview.' },
      { status: flip(70), title: 'Twitter Card consistent',      note: 'summary_large_image site-wide.' },
    ]},
    { title: 'Performance', score: clamp(score - 8, 20, 92), items: [
      { status: flip(70), title: 'LCP < 2.5s on mobile', note: 'Core Web Vital.' },
      { status: flip(55), title: 'INP < 200ms',          note: 'Interaction responsiveness.' },
      { status: flip(50), title: 'CLS < 0.1',            note: 'Layout stability.' },
      { status: flip(60), title: 'TTFB < 800ms',         note: 'Crawl budget.' },
    ]},
    { title: 'SEO Fundamentals', score: clamp(score + 4, 25, 94), items: [
      { status: flip(35), title: 'Unique, keyword-led <title> on every page', note: '50–60 chars, primary keyword up front.' },
      { status: flip(40), title: 'Meta description present site-wide',    note: '140–160 chars. Drives CTR in SERPs.' },
      { status: flip(55), title: 'H1 per page, matches search intent',    note: 'One H1, aligned to target query.' },
      { status: flip(60), title: 'Internal link coverage (no orphans)',   note: 'Every indexable page reachable in ≤ 3 clicks.' },
      { status: flip(70), title: 'Image alt text on 95%+ of images',      note: 'Descriptive alt — skip decorative.' },
      { status: flip(65), title: 'XML sitemap submitted + fresh lastmod', note: 'GSC + Bing Webmaster Tools.' },
      { status: flip(75), title: 'Canonical tags correct',                note: 'No loops, no canonical to dev.' },
      { status: flip(80), title: 'No broken links / redirect chains',     note: 'Crawl eats budget on 404s and 30x chains.' },
    ]},
  ];
}

function buildRecommendations() {
  return [
    { n: 1,  cat: 'GEO',         impact: 'hi',  effort: 'easy', title: 'Add FAQPage schema to top 20 service/landing pages',       body: 'Google explicitly rewards FAQPage markup for AI Overview and rich-result inclusion.' },
    { n: 2,  cat: 'GEO',         impact: 'hi',  effort: 'easy', title: 'Publish /llms.txt at your site root',                       body: 'Emerging standard signals canonical content and policy to LLM crawlers.' },
    { n: 3,  cat: 'GEO',         impact: 'hi',  effort: 'med',  title: 'Ship 5 "alternatives to" / "vs" comparison pages',          body: 'Comparison intent is the query type AI Overviews cite most.' },
    { n: 4,  cat: 'GEO',         impact: 'hi',  effort: 'med',  title: 'Add a 2-sentence TL;DR to every blog post',                 body: 'Bing/ChatGPT Search extracts the first ~100 words as the answer summary.' },
    { n: 5,  cat: 'Schema',      impact: 'hi',  effort: 'easy', title: 'Add Service JSON-LD for each offering',                     body: 'Required for category match on "best X for Y" queries.' },
    { n: 6,  cat: 'Schema',      impact: 'med', effort: 'easy', title: 'Add Organization schema with sameAs links',                 body: 'Entity resolution across AI knowledge graphs.' },
    { n: 7,  cat: 'Schema',      impact: 'lo',  effort: 'easy', title: 'Add Review / AggregateRating schema',                       body: 'Surfaces star ratings in AI Overview cards.' },
    { n: 8,  cat: 'SEO',         impact: 'hi',  effort: 'easy', title: 'Rewrite title tags to lead with primary keyword',           body: 'Target 50–60 chars, primary intent keyword in first 3 words.' },
    { n: 9,  cat: 'SEO',         impact: 'med', effort: 'easy', title: 'Fill every meta description (140–160 chars)',               body: 'Missing metas force Google to synthesize one — usually worse than yours.' },
    { n: 10, cat: 'SEO',         impact: 'hi',  effort: 'med',  title: 'Fix orphan pages — every page ≤ 3 clicks from home',        body: 'Internal linking determines crawl discovery and PageRank flow.' },
    { n: 11, cat: 'SEO',         impact: 'med', effort: 'easy', title: 'Audit and fix image alt text site-wide',                    body: 'Also feeds AI visual understanding — increasingly relevant for multimodal search.' },
    { n: 12, cat: 'SEO',         impact: 'med', effort: 'easy', title: 'Submit XML sitemap to GSC + Bing Webmaster',                body: 'Bing Webmaster is critical for ChatGPT Search (Bing-powered).' },
    { n: 13, cat: 'SEO',         impact: 'med', effort: 'med',  title: 'Clean up redirect chains and broken links',                 body: 'Every 30x hop loses ~15% of link equity.' },
    { n: 14, cat: 'SEO',         impact: 'lo',  effort: 'easy', title: 'Audit canonical tags — no loops, no canonical to dev',      body: 'Misfiring canonicals cause de-indexing.' },
    { n: 15, cat: 'Content',     impact: 'hi',  effort: 'med',  title: 'Refactor top 10 posts to use numbered / bulleted answers',  body: 'AI Overviews extract structured lists 3× more often than prose.' },
    { n: 16, cat: 'Content',     impact: 'hi',  effort: 'hard', title: 'Publish 1 proprietary study / data report per quarter',     body: 'Original data is the most re-cited asset type on the web.' },
    { n: 17, cat: 'E-E-A-T',     impact: 'med', effort: 'med',  title: 'Expand author bios with credentials + sameAs links',         body: "Google's Quality Rater Guidelines weight author identity heavily." },
    { n: 18, cat: 'Freshness',   impact: 'med', effort: 'easy', title: 'Backfill dateModified on stale pages',                       body: 'Freshness is a confirmed AI + Google ranking signal.' },
    { n: 19, cat: 'Crawler',     impact: 'med', effort: 'easy', title: 'Explicitly allow Google-Extended in robots.txt',             body: 'Unlocks Gemini / AI Overview training data.' },
    { n: 20, cat: 'Performance', impact: 'med', effort: 'med',  title: 'Cut TTFB below 800ms',                                       body: 'Edge caching or a CDN solves 90% of TTFB problems.' },
    { n: 21, cat: 'Performance', impact: 'med', effort: 'med',  title: 'Hit LCP < 2.5s and INP < 200ms on mobile',                   body: 'Core Web Vitals are a confirmed Google ranking factor.' },
    { n: 22, cat: 'Outreach',    impact: 'hi',  effort: 'hard', title: 'Get listed in 10 category listicles / review sites',        body: 'AI engines cite listicles disproportionately.' },
    { n: 23, cat: 'Outreach',    impact: 'med', effort: 'hard', title: 'Run a mention-exchange with 20 adjacent blogs',             body: 'Trade listicle inclusions with non-competing peers.' },
  ];
}

module.exports = { assembleReport, assemblePublicReport };
