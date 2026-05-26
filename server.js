require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');
const { scrapeWebsite, analyzeAndGeneratePrompts } = require('./lib/scraper');
const { runTechnicalAudit } = require('./lib/technical-audit');
const { queryAll, getModelNames, clients } = require('./lib/ai-clients');
const { extractBrands, extractBrandsBatch, extractBrandsForScan } = require('./lib/brand-extractor');
const { calculateMetrics } = require('./lib/metrics-calculator');
const { assembleReport, assemblePublicReport } = require('./lib/report-data');
const { findFuzzyMatch } = require('./lib/prompt-matcher');
const { notifyScanSubmitted } = require('./lib/email-notify');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── CORS: locked to Thrive landing-page origins ──
const ALLOWED_ORIGINS = new Set([
  'https://thriveagency.com',
  'https://www.thriveagency.com',
  'https://get.thriveagency.com',         // Google Ads LPs (Astro on Render)
  'http://localhost:4321',                // Astro dev
  'http://localhost:3000',
  'http://localhost:5173',
  ...(process.env.EXTRA_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
]);
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/thrive-[a-z0-9-]+\.onrender\.com$/,  // Render previews
  /^https:\/\/[a-z0-9-]+\.thriveagency\.com$/,     // any thriveagency subdomain
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = origin && (ALLOWED_ORIGINS.has(origin) || ALLOWED_ORIGIN_PATTERNS.some(re => re.test(origin)));
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Authentication ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'visibility2026';
const AUTH_COOKIE = 'aiv_auth';
const AUTH_MAX_AGE = 365 * 24 * 60 * 60; // 1 year in seconds

function makeToken(password) {
  return crypto.createHmac('sha256', 'ai-visibility-salt').update(password).digest('hex');
}

function isAuthed(req) {
  const cookie = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith(AUTH_COOKIE + '='));
  if (!cookie) return false;
  return cookie.split('=')[1]?.trim() === makeToken(ADMIN_PASSWORD);
}

app.get('/login', (req, res) => {
  const error = req.query.error ? '<div style="color:#ff5e6e;margin-bottom:16px;font-size:13px">Incorrect password</div>' : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Login — AI Visibility Report</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',sans-serif;background:#07070d;color:#e0e0f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#111119;border:1px solid #282840;border-radius:14px;padding:40px;width:100%;max-width:380px}
h1{font-size:20px;font-weight:700;margin-bottom:6px}p{font-size:13px;color:#7878a0;margin-bottom:24px}
input{width:100%;background:#07070d;border:1px solid #282840;border-radius:7px;padding:10px 14px;color:#e0e0f0;font-family:'DM Sans',sans-serif;font-size:14px;outline:none;margin-bottom:16px}
input:focus{border-color:#6c5ce7}
button{width:100%;padding:13px;background:linear-gradient(135deg,#6c5ce7,#8b7cf7);border:none;border-radius:9px;color:#fff;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;cursor:pointer}
button:hover{transform:translateY(-1px);box-shadow:0 6px 24px #6c5ce755}</style></head>
<body><div class="card"><h1>AI Visibility Report</h1><p>Enter password to access the tool</p>${error}
<form method="POST" action="/login"><input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Sign In</button></form></div></body></html>`);
});

app.post('/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${makeToken(ADMIN_PASSWORD)}; Path=/; Max-Age=${AUTH_MAX_AGE}; HttpOnly; SameSite=Lax`);
    res.redirect(req.query.next || '/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; Max-Age=0`);
  res.redirect('/login');
});

// Trust X-Forwarded-For when behind a proxy (Render, Cloudflare)
app.set('trust proxy', true);

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || req.connection?.remoteAddress || 'unknown';
}

// Protect admin routes only. Public routes below bypass auth.
const PUBLIC_PATH_PREFIXES = [
  '/login',
  '/report/',
  '/api/health',
  '/api/public/',
  '/api/scan/',           // status + report endpoints for shareable links
  '/ai-visibility-checker',
  '/favicon/',
  '/logo-white.png',
];
app.use((req, res, next) => {
  if (PUBLIC_PATH_PREFIXES.some(p => req.path === p || req.path.startsWith(p))) return next();
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/login')) return next();
  if (!isAuthed(req)) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Health endpoint for Render
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Per-scan engine selection (in-memory). Defaults to all clients if not set.
const scanEngines = new Map();

// Per-scan per-engine completion tracking for the status endpoint. Frontend
// uses this to fill each engine's progress bar independently as that engine
// returns. Shape: scanId -> {model_name: {done: N, total: M}}.
const scanEngineProgress = new Map();

// Engine-level deadline. Any single engine call exceeding this fails the
// scan's slowest-link calculation — we'd rather show 3/4 cards with real
// data than wait 11s on one Gemini outlier. The underlying fetch keeps
// running in the background but its result is discarded.
const ENGINE_TIMEOUT_MS = 5000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Purge expired cache on startup
db.purgeExpiredCache.run();

// --- Scan Pipeline (runs async) ---
async function runScan(scanId) {
  try {
    const scan = db.getScan.get(scanId);
    if (!scan) return;

    // Step 1: Scrape website
    console.log(`[SCAN ${scanId}] Scraping ${scan.website_url}...`);
    db.updateScanStatus.run('scraping', 'Scraping website...', scanId);
    const scraped = await scrapeWebsite(scan.website_url);

    // Step 1b: kick off technical audit in parallel (doesn't block downstream)
    const auditPromise = runTechnicalAudit(scan.website_url, scraped.rawHtml).then(audit => {
      try { db.saveAuditJson.run(JSON.stringify(audit), scanId); } catch (e) { console.error('[audit] save failed:', e.message); }
      console.log(`[SCAN ${scanId}] Technical audit complete (${audit.length} categories)`);
      return audit;
    }).catch(err => {
      console.error(`[SCAN ${scanId}] Technical audit failed:`, err.message);
      return null;
    });

    // Step 2: Analyze website + generate search prompts (one OpenAI call)
    console.log(`[SCAN ${scanId}] Analyzing + generating prompts...`);
    db.updateScanStatus.run('analyzing', 'Analyzing website content...', scanId);
    const clusters = (scan.prompt_clusters || '').trim();
    const { profile, prompts } = await analyzeAndGeneratePrompts(scraped, scan.brand_name, clusters);
    const industry = (profile.industry || '').toLowerCase().trim();

    // If scraper inferred a cleaner brand name, persist it
    if (profile.brand_name && profile.brand_name.trim() && profile.brand_name !== scan.brand_name) {
      db.db.prepare('UPDATE scans SET brand_name = ? WHERE id = ?').run(profile.brand_name.trim(), scanId);
      scan.brand_name = profile.brand_name.trim();
    }

    db.updateScan.run(
      profile.industry || '', JSON.stringify(profile.services || []),
      profile.location || '', profile.target_market || '',
      profile.summary || '', 'querying', 'Querying AI models...', scanId
    );

    for (const p of prompts) {
      db.insertPrompt.run(scanId, p.prompt, p.category);
    }
    console.log(`[SCAN ${scanId}] ${prompts.length} prompts ready`);

    // Step 4: Query AI models (with response cache)
    // Filter clients to engines selected for this scan (defaults to all)
    const selectedEngines = scanEngines.get(scanId);
    const activeClients = selectedEngines && selectedEngines.length > 0
      ? clients.filter(c => selectedEngines.includes(c.name))
      : clients;
    if (selectedEngines && activeClients.length === 0) {
      throw new Error(`No matching engines for: ${selectedEngines.join(', ')}`);
    }
    const savedPrompts = db.getPrompts.all(scanId);
    const total = savedPrompts.length;

    // Per-engine progress tracking — frontend reads this from /status and
    // fills each engine's card bar independently as that engine finishes.
    const engineProgress = {};
    for (const c of activeClients) engineProgress[c.name] = { done: 0, total };
    scanEngineProgress.set(scanId, engineProgress);

    // Per-prompt processing: each prompt queries engines in parallel, then
    // extracts brands from the engine responses. All prompts run in parallel,
    // so we get max(prompt_time) wall clock, not sum.
    //
    // We tried merging extraction into one scan-wide call — turned out a
    // single ~18KB-input gpt-4o-mini extract took ~50s, MUCH worse than 3
    // parallel ~4s per-prompt extracts. So we kept it per-prompt.
    const promptResults = await Promise.all(savedPrompts.map(async (p, i) => {
      const promptSnip = p.prompt_text.slice(0, 50);
      const cachedResults = [];
      const uncachedClients = [];

      const fuzzyPrompt = findFuzzyMatch(p.prompt_text, db.db);

      for (const client of activeClients) {
        let cached = db.getCachedResponse.get(p.prompt_text, client.name);
        if (!cached && fuzzyPrompt) {
          cached = db.getCachedResponse.get(fuzzyPrompt, client.name);
          if (cached) console.log(`[SCAN ${scanId}]   Fuzzy match [${i+1}] for ${client.name}`);
        }
        if (cached) {
          cachedResults.push({
            model_name: client.name,
            response: cached.response,
            brands: cached.brands_json ? JSON.parse(cached.brands_json) : null,
            fromCache: true,
          });
          // Cached counts as "done" immediately
          engineProgress[client.name].done++;
        } else {
          uncachedClients.push(client);
        }
      }

      let freshResults = [];
      if (uncachedClients.length > 0) {
        console.log(`[SCAN ${scanId}] [${i+1}/${total}] Querying ${uncachedClients.map(c => c.name).join('+')}: "${promptSnip}..."`);
        const settled = await Promise.allSettled(
          uncachedClients.map(client => {
            const t0 = Date.now();
            return withTimeout(client.query(p.prompt_text), ENGINE_TIMEOUT_MS, client.name).then(
              response => {
                const latency = Date.now() - t0;
                console.log(`[SCAN ${scanId}]   [${client.name}] ok in ${latency}ms (prompt ${i+1})`);
                engineProgress[client.name].done++;
                return { model_name: client.name, response, latency_ms: latency, fromCache: false };
              },
              err => {
                const latency = Date.now() - t0;
                console.error(`[SCAN ${scanId}]   [${client.name}] Error in ${latency}ms: ${err.message}`);
                engineProgress[client.name].done++;
                return { model_name: client.name, response: null, latency_ms: latency, error: err.message, fromCache: false };
              }
            );
          })
        );
        freshResults = settled.map(r => r.value);
      }

      const allResults = [...cachedResults, ...freshResults];

      // Per-prompt brand extraction (one OpenAI call per prompt — they run
      // in parallel across prompts because each processPrompt promise is
      // awaited inside Promise.all).
      const uncachedWithResponses = allResults.filter(r => !r.fromCache && r.response);
      let brandsByModel = {};
      if (uncachedWithResponses.length > 0) {
        const t0 = Date.now();
        brandsByModel = await extractBrandsBatch(uncachedWithResponses, p.prompt_text);
        console.log(`[SCAN ${scanId}]   [extract] prompt ${i+1} in ${Date.now() - t0}ms`);
      }

      return { p, allResults, brandsByModel };
    }));

    // Persist all results (cached + fresh) to the DB. latency_ms is null
    // for cache hits (instant lookup) and the actual measured wall-time for
    // fresh API calls; error_message is null on success.
    for (const { p, allResults, brandsByModel } of promptResults) {
      for (const r of allResults) {
        if (!r.response) {
          db.insertResponse.run(p.id, r.model_name, null, r.latency_ms ?? null, r.error || null);
          continue;
        }
        const latency = r.fromCache ? null : (r.latency_ms ?? null);
        const respId = db.insertResponse.run(p.id, r.model_name, r.response, latency, null).lastInsertRowid;
        let brands;
        if (r.fromCache) {
          brands = r.brands || [];
        } else {
          brands = brandsByModel[r.model_name] || [];
          db.upsertCachedResponse.run(p.prompt_text, r.model_name, r.response, JSON.stringify(brands));
        }
        for (const b of brands) {
          db.insertMention.run(respId, b.brand_name, b.normalized_name, b.position, b.context_snippet, b.sentiment_score);
        }
      }
    }

    // Step 6: Calculate metrics
    console.log(`[SCAN ${scanId}] Calculating metrics...`);
    db.updateScanStatus.run('calculating', 'Calculating visibility metrics...', scanId);
    calculateMetrics(scanId);

    // Technical audit (auditPromise) continues in the background — it's only needed
    // for the gated full report, not the snippet, so we don't block completion on it.

    // Done
    db.completeScan.run(scanId);
    console.log(`[SCAN ${scanId}] Complete!`);

    // Background pre-warm: pre-query uncached prompts for this industry
    // This runs after the scan is done so it doesn't slow down the user
    if (industry) {
      prewarmIndustry(industry, prompts).catch(err =>
        console.error(`[PREWARM] Error for "${industry}":`, err.message)
      );
    }

  } catch (err) {
    console.error(`[SCAN ${scanId}] Error:`, err.message);
    console.error(`[SCAN ${scanId}] Stack:`, err.stack);
    db.updateScanStatus.run('error', err.message, scanId);
  } finally {
    // Drop per-engine progress after a short delay so any in-flight status
    // polls still see the final state, then free the memory.
    setTimeout(() => scanEngineProgress.delete(scanId), 30_000);
  }
}

// Background pre-warming: query AI models for any prompts not yet cached
async function prewarmIndustry(industry, prompts) {
  let warmed = 0;
  for (const p of prompts) {
    for (const client of clients) {
      const cached = db.getCachedResponse.get(p.prompt, client.name);
      if (!cached) {
        try {
          const response = await client.query(p.prompt);
          if (response) {
            const brands = await extractBrands(response, p.prompt);
            db.upsertCachedResponse.run(p.prompt, client.name, response, JSON.stringify(brands));
            warmed++;
          }
        } catch (err) {
          // Silently skip failed pre-warm queries
        }
      }
    }
  }
  if (warmed > 0) console.log(`[PREWARM] Cached ${warmed} new responses for "${industry}"`);
}

// LP-facing scan endpoint. CORS already locks the Origin to Thrive domains
// for browser callers, but curl/scripts can spoof Origin headers so we also
// rate-limit by IP and log every attempt to scan_log for abuse review.
//
// Rate limits (per-IP/day are the abuse floor; per-URL/day catches the
// "scan everyone's domain in a loop" pattern):
//   - 5 scans/hour/IP
//   - 20 scans/day/IP
//   - 3 scans/day/URL (subsequent same-URL hits serve the cached scan)
const SCAN_RATE = {
  perIpPerHour: Number(process.env.SCAN_PER_IP_HOUR || 5),
  perIpPerDay:  Number(process.env.SCAN_PER_IP_DAY  || 20),
  perUrlPerDay: Number(process.env.SCAN_PER_URL_DAY || 3),
};

// --- API Routes ---
app.post('/api/scan/start', (req, res) => {
  const ip = clientIp(req);
  const ua = (req.headers['user-agent'] || '').slice(0, 400);
  const referer = (req.headers.referer || '').slice(0, 400);
  const origin  = (req.headers.origin  || '').slice(0, 400);

  // Ad-attribution: GCLID + UTMs captured client-side (utm-capture.js), sent in body.
  const gclid = (req.body?.gclid || '').slice(0, 200) || null;
  const utm = {
    source:   (req.body?.utm_source   || '').slice(0, 200) || null,
    medium:   (req.body?.utm_medium   || '').slice(0, 200) || null,
    campaign: (req.body?.utm_campaign || '').slice(0, 200) || null,
    content:  (req.body?.utm_content  || '').slice(0, 200) || null,
    term:     (req.body?.utm_term     || '').slice(0, 200) || null,
  };
  const adCols = [gclid, utm.source, utm.medium, utm.campaign, utm.content, utm.term];

  let { brand_name, prompt_clusters, engines, website_url } = req.body;
  if (!website_url) {
    db.insertScanLog.run(ip, ua, String(req.body?.website_url || ''), referer, origin, null, null, 0, 'missing_url', ...adCols);
    return res.status(400).json({ error: 'Please enter your website domain to scan (e.g. yourcompany.com).' });
  }
  if (!/^https?:\/\//i.test(website_url)) website_url = 'https://' + website_url;

  // Rate limit checks before we spin up any AI work
  const ipHour = db.countRecentByIp.get(ip, '-1 hour').c;
  const ipDay  = db.countRecentByIp.get(ip, '-24 hours').c;
  const urlDay = db.countRecentByUrl.get(website_url, '-24 hours').c;

  if (ipHour >= SCAN_RATE.perIpPerHour) {
    db.insertScanLog.run(ip, ua, website_url, referer, origin, null, null, 0, 'rate_limit_ip_hour', ...adCols);
    return res.status(429).json({ error: `Too many scans this hour. Please wait (${SCAN_RATE.perIpPerHour}/hour).` });
  }
  if (ipDay >= SCAN_RATE.perIpPerDay) {
    db.insertScanLog.run(ip, ua, website_url, referer, origin, null, null, 0, 'rate_limit_ip_day', ...adCols);
    return res.status(429).json({ error: `Daily scan limit reached (${SCAN_RATE.perIpPerDay}/day). Try tomorrow.` });
  }
  if (urlDay >= SCAN_RATE.perUrlPerDay) {
    // Same URL hit too many times today — serve the most recent cached scan if we have one
    const recent = db.findRecentCompleteScanByUrl.get(website_url);
    if (recent) {
      db.insertScanLog.run(ip, ua, website_url, referer, origin, null, recent.id, 1, 'served_cached', ...adCols);
      return res.json({ scan_id: recent.id, status: 'cached' });
    }
    db.insertScanLog.run(ip, ua, website_url, referer, origin, null, null, 0, 'rate_limit_url_day', ...adCols);
    return res.status(429).json({ error: `This URL was scanned recently. Try a different one.` });
  }

  // If brand_name wasn't provided, derive from domain (e.g. "thriveagency.com" -> "Thriveagency")
  if (!brand_name) {
    try {
      const host = new URL(website_url).hostname.replace(/^www\./, '');
      const base = host.split('.')[0].replace(/[-_]+/g, ' ').trim();
      brand_name = base.charAt(0).toUpperCase() + base.slice(1);
    } catch (e) {
      db.insertScanLog.run(ip, ua, website_url, referer, origin, null, null, 0, 'invalid_url', ...adCols);
      return res.status(400).json({ error: 'invalid website_url' });
    }
  }

  const result = db.createScan.run(brand_name, website_url, prompt_clusters || '');
  const scanId = result.lastInsertRowid;

  // Gate the scan to caller-specified engines (e.g. ['google_ai_mode'])
  if (Array.isArray(engines) && engines.length > 0) {
    scanEngines.set(scanId, engines);
  }

  db.insertScanLog.run(ip, ua, website_url, referer, origin, null, scanId, 1, 'new_scan', ...adCols);

  // Notify Aaron / SDR pool about the new scan (fire-and-forget, never blocks response).
  notifyScanSubmitted({
    scanId, websiteUrl: website_url, brand: brand_name,
    ip, ua, referer, origin, gclid, utm,
  }).catch(err => console.error('[scan-notify] failed:', err.message));

  // Run async — don't await
  runScan(scanId);

  res.json({ scan_id: scanId, status: 'pending' });
});

// Snippet endpoint — teaser data only, used by gated LPs
app.get('/api/scan/:id/snippet', (req, res) => {
  const report = assembleReport(Number(req.params.id));
  if (!report) return res.status(404).json({ error: 'Report not found' });

  const target = report.target || { visibility_pct: 0, mention_count: 0, market_share_pct: 0 };
  const topBrands = (report.metrics || []).slice(0, 10);
  const targetNorm = (report.scan.brand_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const competitorsAbove = topBrands
    .filter(b => (b.normalized_name || '').toLowerCase() !== targetNorm)
    .filter(b => (b.visibility_pct || 0) > (target.visibility_pct || 0))
    .slice(0, 3)
    .map(b => ({ name: b.brand_name, visibility_pct: b.visibility_pct }));

  const totalPrompts = report.total_prompts || 0;
  const samplePrompt = (report.prompt_results && report.prompt_results.length > 0)
    ? report.prompt_results[0].prompt_text
    : null;

  res.json({
    scan_id: report.scan.id,
    brand_name: report.scan.brand_name,
    website_url: report.scan.website_url,
    industry: report.scan.industry || null,
    engines_used: report.models || [],
    target: {
      visibility_pct: target.visibility_pct || 0,
      mention_count: target.mention_count || 0,
      market_share_pct: target.market_share_pct || 0,
    },
    prompts_tested: totalPrompts,
    sample_prompt: samplePrompt,
    competitors_above_you_count: competitorsAbove.length,
    competitors_above_you_preview: competitorsAbove,
    full_report_locked: true,
  });
});

// ── Public endpoint: URL-only, rate-limited, logged for abuse review ──
const PUBLIC_RATE = {
  perIpPerHour:  Number(process.env.PUBLIC_PER_IP_HOUR  || 3),
  perIpPerDay:   Number(process.env.PUBLIC_PER_IP_DAY   || 10),
  perUrlPerDay:  Number(process.env.PUBLIC_PER_URL_DAY  || 2),
};

function normalizeUrl(raw) {
  if (!raw) return '';
  let u = String(raw).trim().replace(/^["'<]+|["'>]+$/g, '');
  u = u.replace(/^(https?:?\/*)/i, '').replace(/^\/+/, '');
  if (!/[a-z]/i.test(u) || !u.includes('.')) return '';
  u = u.split(/[\/?#]/)[0].toLowerCase(); // just the domain
  return 'https://' + u;
}

app.post('/api/public/scan/start', async (req, res) => {
  const ip = clientIp(req);
  const ua = (req.headers['user-agent'] || '').slice(0, 400);
  const referer = (req.headers.referer || '').slice(0, 400);
  const origin  = (req.headers.origin || '').slice(0, 400);

  // Ad-attribution: GCLID + UTMs captured client-side (utm-capture.js), sent in body.
  const gclid = (req.body?.gclid || '').slice(0, 200) || null;
  const utm = {
    source:   (req.body?.utm_source   || '').slice(0, 200) || null,
    medium:   (req.body?.utm_medium   || '').slice(0, 200) || null,
    campaign: (req.body?.utm_campaign || '').slice(0, 200) || null,
    content:  (req.body?.utm_content  || '').slice(0, 200) || null,
    term:     (req.body?.utm_term     || '').slice(0, 200) || null,
  };
  const adCols = [gclid, utm.source, utm.medium, utm.campaign, utm.content, utm.term];

  const website_url = normalizeUrl(req.body?.website_url);
  if (!website_url) {
    db.insertScanLog.run(ip, ua, String(req.body?.website_url || ''), referer, origin, null, null, 0, 'invalid_url', ...adCols);
    return res.status(400).json({ error: 'Please enter your website domain to scan (e.g. yourcompany.com).' });
  }

  // Rate limit: per-IP hour/day, per-URL day
  const ipHour = db.countRecentByIp.get(ip,  '-1 hour').c;
  const ipDay  = db.countRecentByIp.get(ip,  '-24 hours').c;
  const urlDay = db.countRecentByUrl.get(website_url, '-24 hours').c;

  if (ipHour >= PUBLIC_RATE.perIpPerHour) {
    db.insertScanLog.run(ip, ua, website_url, referer, origin, null, null, 0, 'rate_limit_ip_hour', ...adCols);
    return res.status(429).json({ error: `Too many scans — please wait a bit (${PUBLIC_RATE.perIpPerHour}/hour limit).` });
  }
  if (ipDay >= PUBLIC_RATE.perIpPerDay) {
    db.insertScanLog.run(ip, ua, website_url, referer, origin, null, null, 0, 'rate_limit_ip_day', ...adCols);
    return res.status(429).json({ error: `Daily limit reached (${PUBLIC_RATE.perIpPerDay}/day). Try again tomorrow.` });
  }
  if (urlDay >= PUBLIC_RATE.perUrlPerDay) {
    // Serve cached scan for same URL if one exists recently
    const recent = db.findRecentCompleteScanByUrl.get(website_url);
    if (recent) {
      db.insertScanLog.run(ip, ua, website_url, referer, origin, null, recent.id, 1, 'served_cached', ...adCols);
      return res.json({ scan_id: recent.id, status: 'cached' });
    }
    db.insertScanLog.run(ip, ua, website_url, referer, origin, null, null, 0, 'rate_limit_url_day', ...adCols);
    return res.status(429).json({ error: `This URL was already scanned recently. Try again tomorrow.` });
  }

  // URL dedupe: serve cached scan within 30 days for the same URL
  const cached = db.findRecentCompleteScanByUrl.get(website_url);
  if (cached) {
    db.insertScanLog.run(ip, ua, website_url, referer, origin, null, cached.id, 1, 'served_cached_30d', ...adCols);
    return res.json({ scan_id: cached.id, status: 'cached' });
  }

  // Create a new scan. Brand name will be inferred in the scrape step; start with a placeholder.
  const domain = website_url.replace(/^https?:\/\//, '');
  const placeholderBrand = domain.split('.')[0];
  const result = db.createScan.run(placeholderBrand, website_url, '');
  const scanId = result.lastInsertRowid;

  db.insertScanLog.run(ip, ua, website_url, referer, origin, null, scanId, 1, 'new_scan', ...adCols);

  // Notify Aaron / SDR pool about the new scan (fire-and-forget, never blocks response).
  notifyScanSubmitted({
    scanId, websiteUrl: website_url, brand: placeholderBrand,
    ip, ua, referer, origin, gclid, utm,
  }).catch(err => console.error('[scan-notify] failed:', err.message));

  runScan(scanId);
  res.json({ scan_id: scanId, status: 'pending' });
});

// Admin-only: recent scan log for abuse review
app.get('/api/admin/scan-log', (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const limit = Math.min(500, Number(req.query.limit) || 100);
  res.json(db.getRecentScanLogs.all(limit));
});

app.get('/api/scan/:id/status', (req, res) => {
  const scan = db.getScan.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const engines = scanEngineProgress.get(Number(req.params.id)) || null;
  res.json({ id: scan.id, status: scan.status, progress: scan.progress, brand_name: scan.brand_name, engines });
});

app.get('/api/scan/:id/report', (req, res) => {
  const report = assembleReport(Number(req.params.id));
  if (!report) return res.status(404).json({ error: 'Report not found' });
  res.json(report);
});

// Public-facing report: returns the shape the /ai-visibility-checker/ frontend expects
app.get('/api/scan/:id/public-report', (req, res) => {
  try {
    const report = assemblePublicReport(Number(req.params.id));
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (err) {
    console.error('[public-report] error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scans', (req, res) => {
  res.json(db.getAllScans.all());
});

app.delete('/api/scan/:id', (req, res) => {
  db.deleteScan.run(req.params.id);
  res.json({ ok: true });
});

// CSV export for cold outreach
app.get('/api/scan/:id/csv', (req, res) => {
  const report = assembleReport(Number(req.params.id));
  if (!report) return res.status(404).json({ error: 'Report not found' });

  const rows = [['Rank', 'Brand', 'Visibility %', 'Market Share %', 'Avg Position', 'Mentions', 'Reputation', 'Industry', 'Scan Date']];
  report.metrics.forEach((b, i) => {
    const rep = Math.round(((b.avg_sentiment + 1) / 2) * 100);
    rows.push([
      i + 1, `"${b.brand_name}"`, b.visibility_pct, b.market_share_pct,
      b.avg_rank.toFixed(1), b.mention_count, rep,
      `"${report.scan.industry || ''}"`, `"${report.scan.created_at}"`
    ]);
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  const brand = report.scan.brand_name.replace(/[^a-zA-Z0-9]/g, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="AI_Visibility_${brand}.csv"`);
  res.send(csv);
});

// Shareable report HTML page
app.get('/report/:id', (req, res) => {
  const report = assembleReport(Number(req.params.id));
  if (!report) return res.status(404).send('Report not found');
  // Serve the main page with auto-load script
  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Visibility Report - ${report.scan.brand_name}</title>
<meta property="og:title" content="AI Visibility Report - ${report.scan.brand_name}">
<meta property="og:description" content="${report.scan.brand_name} AI visibility: ${report.target.visibility_pct}% across ${report.models.length} AI platforms">
<script>window.__REPORT_DATA=${JSON.stringify(report)};window.__REPORT_ID=${req.params.id};</script>
</head><body><script>window.location.href='/?view=${req.params.id}';</script></body></html>`);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`\n  ✅  http://localhost:${PORT}\n`));
