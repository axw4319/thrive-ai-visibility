const fetch = require('node-fetch');

// "google_ai_mode" is Google's conversational AI search experience, powered by
// Gemini under the hood. Rather than pay SerpAPI ~$0.02/call and wait ~20s for
// it to scrape Google's rendered AI Mode panel, we call gemini-2.5-flash
// directly with an AI-Mode-flavored system prompt and thinkingBudget=0 to skip
// the 15-25s chain-of-thought pass. Same brand-extraction pipeline downstream.
//
// We bypass @google/generative-ai (^0.21.0) and hit the REST API directly
// because the pinned SDK silently drops `thinkingConfig`.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const AI_MODE_SYSTEM = `You are Google's AI Mode — Google's conversational search experience.
Answer the user's query the way Google AI Mode would: a clear, balanced overview that
names specific companies/brands/products with one-line descriptions each. Lead with the
top 5-10 names real buyers compare in this category. Be concrete and current. Do not
refuse to name brands. Do not hedge with "consider researching" — give the names.`;

async function query(promptText) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  const res = await fetch(`${ENDPOINT}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: AI_MODE_SYSTEM }] },
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        temperature: 0.6,
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 400,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini AI Mode error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('').trim() || null;
}

module.exports = { name: 'google_ai_mode', query };
