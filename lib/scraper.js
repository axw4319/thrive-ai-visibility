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

async function analyzeWebsite(scraped, brandName) {
  const prompt = `Analyze this website and return a JSON object with:
- brand_name: the official company / brand name (cleaned — no tagline, no "Inc.", no city suffix). Example: "Thrive Internet Marketing Agency", not "Thrive — Digital Marketing in Arlington TX".
- industry: the primary industry (e.g. "Digital Marketing", "SaaS", "E-commerce")
- services: array of main services/products offered (max 8)
- location: primary business location/city if mentioned (or "National" / "Global")
- target_market: who their customers are (e.g. "Small businesses", "Enterprise", "E-commerce brands")
- summary: 2-sentence description of what this company does

Caller-provided hint for brand_name (may be rough — prefer what's in the site content): "${brandName}"

Website data:
Title: ${scraped.title}
Meta: ${scraped.metaDesc}
H1: ${scraped.h1s}
H2: ${scraped.h2s}
Body: ${scraped.bodyText}
${scraped.jsonLd ? 'Schema: ' + scraped.jsonLd : ''}

Return ONLY valid JSON, no markdown.`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    // Try to extract JSON from response
    const match = res.choices[0].message.content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Failed to parse website analysis');
  }
}

module.exports = { scrapeWebsite, analyzeWebsite };
