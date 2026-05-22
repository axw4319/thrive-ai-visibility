const fetch = require('node-fetch');

const API_KEY = process.env.SERPAPI_KEY;

async function query(promptText) {
  if (!API_KEY) throw new Error('SERPAPI_KEY not set');

  const params = new URLSearchParams({
    engine: 'google',
    q: promptText,
    api_key: API_KEY,
    num: 10
  });

  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SerpAPI error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();

  // Extract AI Overview content if present
  if (data.ai_overview) {
    return extractOverviewText(data.ai_overview);
  }

  // Fallback: check for featured snippet or knowledge graph
  const parts = [];

  if (data.answer_box) {
    if (data.answer_box.snippet) parts.push(data.answer_box.snippet);
    if (data.answer_box.answer) parts.push(data.answer_box.answer);
  }

  if (data.knowledge_graph) {
    const kg = data.knowledge_graph;
    if (kg.description) parts.push(kg.description);
  }

  // Include top organic results as supplemental context
  if (data.organic_results && data.organic_results.length > 0) {
    const topResults = data.organic_results.slice(0, 8);
    for (const r of topResults) {
      const entry = [r.title || '', r.snippet || ''].filter(Boolean).join(' — ');
      if (entry) parts.push(entry);
    }
  }

  if (parts.length === 0) {
    return null; // No useful content found
  }

  return parts.join('\n\n');
}

function extractOverviewText(overview) {
  const parts = [];

  // Handle text blocks
  if (overview.text) {
    parts.push(overview.text);
  }

  // Handle text_blocks array
  if (overview.text_blocks) {
    for (const block of overview.text_blocks) {
      if (block.snippet) parts.push(block.snippet);
      if (block.text) parts.push(block.text);
      if (block.list) {
        for (const item of block.list) {
          if (typeof item === 'string') parts.push(item);
          else if (item.snippet) parts.push(item.snippet);
          else if (item.title) parts.push(`${item.title}: ${item.snippet || ''}`);
        }
      }
    }
  }

  // Handle references/sources
  if (overview.references) {
    for (const ref of overview.references) {
      if (ref.snippet) parts.push(ref.snippet);
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

module.exports = { name: 'google_ai_overview', query };
