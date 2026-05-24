const fetch = require('node-fetch');

// Quota refilled 2026-05-24. Tight prompt + small max_tokens so the call
// returns in 2-4s — heuristic extractor downstream only needs brand names,
// not paragraph descriptions.
const SYSTEM_PROMPT = `You are Perplexity answering a user's product/service question. Reply with the top 8-10 specific company/brand/product names that best answer the query.

Format: a numbered list. One brand per line. Bold the brand name. Add a 5-12 word descriptor after a colon. No intro, no outro, no caveats — just the list.

Example shape:
1. **Brand Name**: short description
2. **Brand Name**: short description`;

async function query(promptText) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set');

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: promptText },
      ],
      temperature: 0.5,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Perplexity API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

module.exports = { name: 'perplexity', query };
