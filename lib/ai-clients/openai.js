const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Tight prompt + short max_tokens — gpt-4o-mini generates ~50 tok/sec, so
// the prior "give comprehensive lists with details" + max_tokens=2000 took
// 10-14s per call. We only need brand names for the heuristic extractor
// downstream, not paragraphs, so a 10-brand bullet listicle is plenty.
const SYSTEM_PROMPT = `You are ChatGPT answering a user's product/service question. Reply with the top 8-10 specific company/brand/product names that best answer the query.

Format: a numbered list. One brand per line. Bold the brand name. Add a 5-12 word descriptor after a colon. No intro, no outro, no caveats — just the list.

Example shape:
1. **Brand Name**: short description
2. **Brand Name**: short description`;

async function query(promptText) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: promptText },
    ],
    temperature: 0.7,
    max_tokens: 500,
  });
  return res.choices[0].message.content;
}

module.exports = { name: 'chatgpt', query };
