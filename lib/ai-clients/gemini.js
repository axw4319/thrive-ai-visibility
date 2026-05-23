const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI;
function getClient() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI;
}

async function query(promptText) {
  // 2.5-flash-lite: no "thinking" mode, returns in 2-4s instead of 15-25s.
  // We get the brand-name extraction signal we actually need without paying
  // for chain-of-thought tokens we throw away.
  const model = getClient().getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
  const result = await model.generateContent(promptText);
  return result.response.text();
}

module.exports = { name: 'gemini', query };
