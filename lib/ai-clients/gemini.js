const fetch = require('node-fetch');

// We call the Gemini REST API directly instead of going through the
// @google/generative-ai SDK because the SDK we're pinned to (^0.21.0) doesn't
// recognize `thinkingConfig` and silently drops it — leaving gemini-2.5-flash
// running its full 15-25s chain-of-thought pass on every call. Direct fetch
// lets us pass thinkingBudget=0 and complete in 1-2s.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Tight bullet-list system instruction — same approach as the chatgpt and
// perplexity engines. The heuristic brand extractor only needs brand names,
// so a short listicle response keeps the call to 2-4s instead of 11s.
const SYSTEM_INSTRUCTION = `You are Gemini answering a user's product/service question. Reply with the top 8-10 specific company/brand/product names that best answer the query.

Format: a numbered list. One brand per line. Bold the brand name. Add a 5-12 word descriptor after a colon. No intro, no outro, no caveats — just the list.

Example shape:
1. **Brand Name**: short description
2. **Brand Name**: short description`;

async function query(promptText) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  const res = await fetch(`${ENDPOINT}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        temperature: 0.7,
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 400,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('').trim() || null;
}

module.exports = { name: 'gemini', query };
