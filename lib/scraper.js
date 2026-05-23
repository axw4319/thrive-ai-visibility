const fetch = require('node-fetch');
const cheerio = require('cheerio');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function scrapeWebsite(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIVisibilityBot/1.0)' },
    timeout: 15000
  });
  const html = await res.text();
  const $ = cheerio.load(html);

  // Remove scripts, styles, nav, footer
  $('script, style, nav, footer, iframe, noscript').remove();

  const title = $('title').text().trim();
  const metaDesc = $('meta[name="description"]').attr('content') || '';
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get().join('; ');
  const h2s = $('h2').map((_, el) => $(el).text().trim()).get().slice(0, 10).join('; ');
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 5000);

  // Check for JSON-LD
  let jsonLd = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try { jsonLd += $(el).html() + '\n'; } catch {}
  });

  return { title, metaDesc, h1s, h2s, bodyText: bodyText.slice(0, 3000), jsonLd: jsonLd.slice(0, 1000), rawHtml: html };
}

// One OpenAI call that returns BOTH the website profile AND the search prompts.
// Saves a full round-trip vs analyzing then prompting in two sequential calls.
async function analyzeAndGeneratePrompts(scraped, brandName, clusters = '') {
  let clusterSection = '';
  if (clusters) {
    clusterSection = `\nUser-provided keyword clusters (heavily influence prompts):\n${clusters.split(',').map(c => `- "${c.trim()}"`).join('\n')}\n`;
  }

  const prompt = `Analyze this website AND generate 3 search prompts in a single response.

Website data:
Title: ${scraped.title}
Meta: ${scraped.metaDesc}
H1: ${scraped.h1s}
H2: ${scraped.h2s}
Body: ${scraped.bodyText}
${scraped.jsonLd ? 'Schema: ' + scraped.jsonLd : ''}

Caller hint for brand_name (may be rough — prefer site content): "${brandName}"
${clusterSection}
Return JSON:
{
  "profile": {
    "brand_name": "official brand — no tagline, no Inc., no city suffix",
    "industry": "primary industry (e.g. Digital Marketing, SaaS, E-commerce)",
    "services": ["array of main services/products, max 8"],
    "location": "primary city, or National/Global",
    "target_market": "who their customers are",
    "summary": "2-sentence description of what this company does"
  },
  "prompts": [
    {"prompt": "...", "category": "service|location|industry|comparison|recommendation"}
  ]
}

PROFILE RULES:
- brand_name should be cleaned: "Thrive Internet Marketing Agency", not "Thrive — Digital Marketing in Arlington TX"

PROMPT RULES (exactly 3 prompts):
1. Every prompt MUST naturally produce a LIST of DIRECT competitor companies to "${brandName}" — same core services, same target market
2. Be hyper-specific to the brand's industry and services — generic industry prompts attract unrelated brands
3. Use varied formats: "best X in Y", "top X for Y", "leading X providers", "compare X companies", "alternatives to X", "which companies specialize in X"
4. Do NOT mention "${brandName}" in any prompt — these are generic discovery queries
5. Cover a mix: one discovery ("best/top"), one comparison ("alternatives to/vs"), one service-specific
6. Pick the 3 HIGHEST-VALUE prompts real buyers would ask AI when evaluating vendors in this exact space

Return ONLY valid JSON, no markdown.`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    response_format: { type: 'json_object' },
  });

  const raw = res.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Failed to parse profile + prompts response');
    parsed = JSON.parse(match[0]);
  }

  if (!parsed.profile || !Array.isArray(parsed.prompts)) {
    throw new Error('Profile + prompts response missing required fields');
  }
  return parsed;
}

module.exports = { scrapeWebsite, analyzeAndGeneratePrompts };
