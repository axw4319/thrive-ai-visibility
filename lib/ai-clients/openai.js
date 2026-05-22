const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function query(promptText) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a helpful assistant. When asked about companies or services, provide comprehensive lists with details about each company mentioned. Include company names, brief descriptions, and any relevant details.' },
      { role: 'user', content: promptText }
    ],
    temperature: 0.7,
    max_tokens: 2000
  });
  return res.choices[0].message.content;
}

module.exports = { name: 'chatgpt', query };
