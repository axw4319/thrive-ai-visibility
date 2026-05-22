const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2
  });

  return parseBrandsArray(res.choices[0].message.content);
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

module.exports = { extractBrands, extractBrandsBatch, normalizeBrand };
