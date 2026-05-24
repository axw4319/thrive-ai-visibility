const fetch = require('node-fetch');

// Brand extraction is a pure parsing task — no creative reasoning needed.
// Gemini 2.5 Flash with thinkingBudget=0 returns in 1-2s for our inputs,
// vs ~4s for gpt-4o-mini and competes against the chatgpt engine for the
// same OpenAI rate-limit budget. Raw fetch (not the SDK) because
// @google/generative-ai 0.21.0 silently drops thinkingConfig.
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

async function geminiExtract(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini brand-extract error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('').trim();
}

function normalizeBrand(name) {
  return name
    .toLowerCase()
    .replace(/\.(com|io|co|net|org|ai)$/i, '')
    .replace(/,?\s*(inc|llc|ltd|corp|co|company|group|agency|studios?)\.?$/i, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

// Single-response extraction (kept for cache compatibility)
async function extractBrands(responseText, promptText) {
  if (!responseText) return [];

  const prompt = `Extract every company, brand, agency, or business name mentioned in this AI response.

The response was for the prompt: "${promptText}"

Response text:
${responseText.slice(0, 3000)}

For each brand, return:
- name: the brand name as written
- position: its rank/order of appearance (1 = first mentioned)
- context: a brief snippet of what was said about it (max 50 words)
- sentiment: a score from -1 (negative) to 1 (positive) based on how positively it was described

Return a JSON array: [{"name":"...","position":1,"context":"...","sentiment":0.8}]
Only include actual company/brand names, not generic terms.
Return ONLY valid JSON, no markdown.`;

  const raw = await geminiExtract(prompt);
  return parseBrandsArray(raw);
}

// Batch extraction: combine multiple model responses for one prompt into a single call
async function extractBrandsBatch(responses, promptText) {
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

  const raw = await geminiExtract(combined);
  const allBrands = parseBrandsArray(raw);

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

module.exports = { extractBrands, extractBrandsBatch, extractBrandsForScan, normalizeBrand };
