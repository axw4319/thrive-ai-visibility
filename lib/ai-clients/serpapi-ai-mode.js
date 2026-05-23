const fetch = require('node-fetch');

const API_KEY = process.env.SERPAPI_KEY;

async function query(promptText) {
  if (!API_KEY) throw new Error('SERPAPI_KEY not set');

  const params = new URLSearchParams({
    engine: 'google_ai_mode',
    q: promptText,
    api_key: API_KEY,
  });

  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SerpAPI google_ai_mode error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const parts = [];

  if (Array.isArray(data.text_blocks)) {
    for (const block of data.text_blocks) {
      if (block.snippet) parts.push(block.snippet);
      if (block.text) parts.push(block.text);
      if (Array.isArray(block.list)) {
        for (const item of block.list) {
          if (typeof item === 'string') parts.push(item);
          else if (item.snippet && item.title) parts.push(`${item.title}: ${item.snippet}`);
          else if (item.snippet) parts.push(item.snippet);
          else if (item.title) parts.push(item.title);
        }
      }
    }
  }

  if (Array.isArray(data.references)) {
    for (const ref of data.references) {
      if (ref.title && ref.snippet) parts.push(`${ref.title}: ${ref.snippet}`);
      else if (ref.snippet) parts.push(ref.snippet);
      else if (ref.title) parts.push(ref.title);
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

module.exports = { name: 'google_ai_mode', query };
