const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Brand-extraction history (so future-me doesn't re-litigate):
// - gpt-4o-mini per-prompt:  ~12-14s tail (current LLM fallback)
// - one big gpt-4o-mini call: ~52s — JSON mode + long context killed it
// - Gemini 2.5 Flash:         rate-limit contention with engines (32s/call)
// - Heuristic regex pass:     <1ms tail — what we ship by default below.
//
// Listicle-style AI answers are extremely consistent in structure
// ("1. **Brand** — description", "**Brand**: description", etc.) so regex
// extraction catches ~80-90% of the brand mentions we'd otherwise pay
// gpt-4o-mini ~12s to extract. The remaining 10-20% (inline prose like
// "I'd consider Patagonia, Allbirds, or Veja") gets caught by a comma-
// list fallback. Sentiment defaults to 0 (we don't try to score it without
// an LLM); position = order of appearance, which is what visibility metrics
// actually consume.

function normalizeBrand(name) {
  return name
    .toLowerCase()
    .replace(/\.(com|io|co|net|org|ai)$/i, '')
    .replace(/,?\s*(inc|llc|ltd|corp|co|company|group|agency|studios?)\.?$/i, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Generic words that show up at the start of bullet points / numbered
// lines but are not brand names. Kept lowercase for case-insensitive
// comparison after normalization.
const HEURISTIC_STOP_WORDS = new Set([
  'best', 'top', 'leading', 'popular', 'other', 'others', 'option', 'options',
  'companies', 'company', 'brands', 'brand', 'products', 'product', 'services',
  'consider', 'look', 'choose', 'find', 'recommended', 'recommend', 'try',
  'some', 'many', 'several', 'most', 'few', 'note', 'important', 'remember',
  'overall', 'finally', 'first', 'second', 'third', 'fourth', 'fifth',
  'affordable', 'quality', 'reliable', 'budget', 'premium', 'cheap', 'expensive',
  'pros', 'cons', 'summary', 'introduction', 'conclusion', 'tips', 'tip',
  'note', 'fyi', 'caveat', 'disclaimer',
  // common joining words that appear capitalized at line start
  'and', 'or', 'but', 'also', 'plus', 'additionally', 'furthermore', 'however',
  'here', 'these', 'those', 'this', 'that',
]);

// Drops trailing punctuation, parentheticals. Keeps possessive 's because
// brand names like "Rothy's" / "Levi's" / "Trader Joe's" need the apostrophe-s.
function cleanCandidate(s) {
  return s
    .replace(/\s*\(.*?\)\s*$/, '')      // strip trailing parens
    .replace(/[.,;:!?\-–—]+$/, '')       // trailing punct
    .replace(/^[*_~]+|[*_~]+$/g, '')     // markdown emphasis
    .trim();
}

function isLikelyBrand(candidate) {
  if (!candidate) return false;
  const len = candidate.length;
  if (len < 2 || len > 60) return false;
  const lower = candidate.toLowerCase();
  if (HEURISTIC_STOP_WORDS.has(lower)) return false;
  // Must contain at least one letter
  if (!/[A-Za-z]/.test(candidate)) return false;
  // Reject if it looks like a sentence fragment
  const words = candidate.split(/\s+/);
  if (words.length > 6) return false;
  // Reject if first word is a generic header/list-opener ("Top", "Best", etc.)
  // — listicle headers like "Top sustainable fashion brands" would otherwise
  // get captured by the H2/H3 pattern.
  if (HEURISTIC_STOP_WORDS.has(words[0].toLowerCase())) return false;
  // Reject if first word is all-lowercase common conjunction/article
  if (/^(the|a|an|of|for|with|by|in|on|at|to|from)$/i.test(words[0])) return false;
  return true;
}

// Pattern-based extraction. Walks the response top-to-bottom, applies
// patterns in order of strictness, dedupes by normalized name, and returns
// brands in order of first appearance.
function heuristicExtractBrands(responseText) {
  if (!responseText || typeof responseText !== 'string') return [];
  const text = responseText;
  const seen = new Set();
  const brands = [];

  function add(rawName, matchEnd) {
    const cleaned = cleanCandidate(rawName);
    if (!isLikelyBrand(cleaned)) return;
    const norm = normalizeBrand(cleaned);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    // 100-char context window after the match for the snippet
    const ctxStart = Math.max(0, matchEnd);
    const ctxEnd = Math.min(text.length, matchEnd + 140);
    brands.push({
      brand_name: cleaned,
      normalized_name: norm,
      position: brands.length + 1,
      context_snippet: text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim().slice(0, 200),
      sentiment_score: 0,
    });
  }

  // 1) Numbered list with bold: "1. **Brand** — desc" or "1. **Brand**: desc"
  const p1 = /(?:^|\n)\s*\d+\.\s+\*\*([^*\n]{2,60})\*\*/g;
  let m;
  while ((m = p1.exec(text)) !== null) add(m[1], m.index + m[0].length);

  // 2) Numbered list, no bold: "1. Brand Name — desc" / "1. Brand Name: desc"
  const p2 = /(?:^|\n)\s*\d+\.\s+([A-Z][\w&.'+\- ]{1,50}?)(?=\s*[—–\-:])/g;
  while ((m = p2.exec(text)) !== null) add(m[1], m.index + m[0].length);

  // 3) Bullet/dash list with bold: "- **Brand** — desc" / "* **Brand**: desc"
  const p3 = /(?:^|\n)\s*[-*•]\s+\*\*([^*\n]{2,60})\*\*/g;
  while ((m = p3.exec(text)) !== null) add(m[1], m.index + m[0].length);

  // 4) Header-style: "### Brand" or "## Brand"
  const p4 = /(?:^|\n)#{2,4}\s+([A-Z][\w&.'+\- ]{1,50})(?=\n|$)/g;
  while ((m = p4.exec(text)) !== null) add(m[1], m.index + m[0].length);

  // 5) Standalone bold on its own line: "**Brand**" at line start
  const p5 = /(?:^|\n)\*\*([A-Z][^*\n]{1,50})\*\*(?=\s*[:\-—–\n])/g;
  while ((m = p5.exec(text)) !== null) add(m[1], m.index + m[0].length);

  // 6) Inline bold (anywhere): "**Brand**" — picks up first-pass brands in
  //    prose responses that aren't strictly listicle. Lower priority because
  //    bold is sometimes used to highlight non-brand keywords.
  const p6 = /\*\*([A-Z][\w&.'+\- ]{1,40})\*\*/g;
  while ((m = p6.exec(text)) !== null) add(m[1], m.index + m[0].length);

  // 7) Comma-list fallback for prose like "Consider brands like Patagonia,
  //    Allbirds, Veja, and Tom's Shoes." Only triggers when we have <3 hits
  //    so far — heavy false-positive risk if used on listicle responses.
  if (brands.length < 3) {
    const proseHints = /\b(?:like|such as|consider|including|brands? include)\s+([A-Z][^.!?\n]{20,200})/g;
    while ((m = proseHints.exec(text)) !== null) {
      const tail = m[1];
      // Split on comma or "and"/"or", take Capitalized fragments
      tail.split(/,\s*|\s+(?:and|or)\s+/i).forEach(frag => {
        const f = frag.trim();
        if (/^[A-Z]/.test(f)) add(f, m.index + m[0].length);
      });
    }
  }

  return brands;
}

function parseBrandsArray(content) {
  try {
    let brands = JSON.parse(content);
    if (!Array.isArray(brands)) {
      const match = content.match(/\[[\s\S]*\]/);
      brands = match ? JSON.parse(match[0]) : [];
    }
    return brands.map(b => ({
      brand_name: b.name || '',
      normalized_name: normalizeBrand(b.name || ''),
      position: b.position || 0,
      context_snippet: (b.context || '').slice(0, 200),
      sentiment_score: Math.max(-1, Math.min(1, b.sentiment || 0)),
      source: b.source || ''
    })).filter(b => b.brand_name.length > 0);
  } catch {
    console.error('Failed to parse brand extraction');
    return [];
  }
}

// Single-response extraction — regex/heuristic, no LLM call. Kept on the
// same signature for callers that still want one-shot extraction (the
// prewarm pipeline + the cache-fill path).
async function extractBrands(responseText, _promptText) {
  if (!responseText) return [];
  return heuristicExtractBrands(responseText);
}

// Batch extraction across multiple model responses for a single prompt.
// Returns { model_name: [brands] }. Heuristic-based (no LLM) — instant.
async function extractBrandsBatch(responses, _promptText) {
  const byModel = {};
  for (const r of responses) {
    if (!r.response) {
      byModel[r.model_name] = [];
      continue;
    }
    const brands = heuristicExtractBrands(r.response);
    // Tag each brand with its source model so downstream cache layer is happy
    byModel[r.model_name] = brands.map(b => ({ ...b, source: r.model_name }));
  }
  return byModel;
}

// LLM-backed extraction kept around for the gated full report (where extra
// accuracy + sentiment scoring is worth the API cost + latency). Not called
// in the snippet path.
async function extractBrandsBatchLLM(responses, promptText) {
  // responses = [{model_name, response}]
  const validResponses = responses.filter(r => r.response);
  if (validResponses.length === 0) return {};

  // Build combined prompt with labeled sections
  let combined = `Extract every company, brand, agency, or business name mentioned in these AI responses.

The original search prompt was: "${promptText}"

`;
  for (const r of validResponses) {
    combined += `--- ${r.model_name.toUpperCase()} RESPONSE ---\n${r.response.slice(0, 2000)}\n\n`;
  }

  combined += `For each brand, return:
- name: the brand name as written
- source: which model mentioned it (${validResponses.map(r => r.model_name).join(', ')})
- position: its rank/order of appearance within that model's response (1 = first mentioned)
- context: a brief snippet of what was said about it (max 50 words)
- sentiment: a score from -1 (negative) to 1 (positive) based on how positively it was described

Return a JSON array: [{"name":"...","source":"...","position":1,"context":"...","sentiment":0.8}]
Only include actual company/brand names, not generic terms. A brand may appear in multiple sources — return a separate entry for each source.
Return ONLY valid JSON, no markdown.`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: combined }],
    temperature: 0.2
  });
  const allBrands = parseBrandsArray(res.choices[0].message.content);

  // Group by source model
  const byModel = {};
  for (const r of validResponses) byModel[r.model_name] = [];

  for (const b of allBrands) {
    const src = b.source.toLowerCase();
    // Find the matching model
    const matchedModel = validResponses.find(r =>
      src.includes(r.model_name.toLowerCase()) || r.model_name.toLowerCase().includes(src)
    );
    if (matchedModel) {
      byModel[matchedModel.model_name].push(b);
    } else {
      // If source doesn't match, add to all models as a fallback
      for (const r of validResponses) byModel[r.model_name].push(b);
    }
  }

  return byModel;
}

// Scan-wide extraction: process ALL prompts × all models in ONE OpenAI call
// instead of one call per prompt. Cuts the brand-extraction tail from
// ~11s (3 sequential gpt-4o-mini calls fighting for rate limit) to ~4s.
// Input:  [{prompt_id, prompt_text, responses: [{model_name, response}]}]
// Output: {prompt_id: {model_name: brands[]}}
async function extractBrandsForScan(promptBlocks) {
  const flat = [];
  for (const pb of promptBlocks) {
    for (const r of pb.responses) {
      if (r.response) flat.push({ prompt_id: pb.prompt_id, prompt_text: pb.prompt_text, model_name: r.model_name, response: r.response });
    }
  }
  if (flat.length === 0) return {};

  // Tag each (prompt, model) pair with a stable ID we ask the model to echo
  // back, so we can re-group the brands after parsing.
  let combined = `Extract every company, brand, agency, or business name mentioned in these AI responses.

Each section is tagged "[BLOCK <id>] (PROMPT: <prompt>) (MODEL: <model>)". For every brand, return the exact block id it came from so we can route brands back to their source.

`;
  flat.forEach((f, idx) => {
    f._id = `b${idx}`;
    combined += `[BLOCK ${f._id}] (PROMPT: "${f.prompt_text}") (MODEL: ${f.model_name})\n${f.response.slice(0, 2000)}\n\n`;
  });

  combined += `For each brand mention, return:
- block_id: the exact id from "[BLOCK <id>]" above this brand was mentioned in
- name: the brand name as written
- position: rank within that block's response (1 = first mentioned)
- context: a brief snippet of what was said (max 50 words)
- sentiment: -1 (negative) to 1 (positive)

Return a JSON array: [{"block_id":"b0","name":"...","position":1,"context":"...","sentiment":0.8}]
Only include actual company/brand names, not generic terms. A brand may appear in multiple blocks — return one entry per block where it appears.
Return ONLY valid JSON, no markdown.`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: combined }],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });

  // gpt-4o-mini in json_object mode returns an object; we asked for an array
  // inside a key, but also handle bare arrays as a defensive fallback.
  let raw = res.choices[0].message.content;
  let arr;
  try {
    const parsed = JSON.parse(raw);
    arr = Array.isArray(parsed) ? parsed : (parsed.brands || parsed.results || parsed.items || Object.values(parsed).find(Array.isArray) || []);
  } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    arr = m ? JSON.parse(m[0]) : [];
  }

  // Normalize, group by (prompt_id, model_name)
  const byPromptModel = {};
  for (const pb of promptBlocks) {
    byPromptModel[pb.prompt_id] = {};
    for (const r of pb.responses) {
      byPromptModel[pb.prompt_id][r.model_name] = [];
    }
  }
  const byId = Object.fromEntries(flat.map(f => [f._id, f]));

  for (const b of arr) {
    const src = byId[b.block_id];
    if (!src || !b.name) continue;
    byPromptModel[src.prompt_id][src.model_name].push({
      brand_name: b.name,
      normalized_name: normalizeBrand(b.name),
      position: b.position || 0,
      context_snippet: (b.context || '').slice(0, 200),
      sentiment_score: Math.max(-1, Math.min(1, b.sentiment || 0)),
      source: src.model_name,
    });
  }

  return byPromptModel;
}

module.exports = { extractBrands, extractBrandsBatch, extractBrandsBatchLLM, extractBrandsForScan, heuristicExtractBrands, normalizeBrand };
