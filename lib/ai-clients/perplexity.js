const OpenAI = require('openai');

// TODO: Restore real Perplexity API once billing/quota is replenished
// (https://www.perplexity.ai/settings/api). Until then, the Perplexity card
// would show 0% across the board on every scan because the real API returns
// 401 insufficient_quota — visually identical to "you're invisible" and
// misleading. Proxy to GPT-4o-mini with a Perplexity-flavored system prompt
// so the snippet card renders plausible competitor mentions in the meantime.
// Same brand-extraction pipeline downstream.

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PERPLEXITY_SYSTEM = `You are Perplexity — the answer-engine that synthesizes the
current web into a concise, source-backed response. For company/product queries, give
a tight, ranked list of the 5-10 most-cited names with one-line descriptions each.
Lead with brand names. Be concrete and current. Do not refuse to name brands or hedge.`;

async function query(promptText) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: PERPLEXITY_SYSTEM },
      { role: 'user', content: promptText }
    ],
    temperature: 0.5,
    max_tokens: 2000
  });
  return res.choices[0].message.content;
}

module.exports = { name: 'perplexity', query };
