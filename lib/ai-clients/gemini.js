const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI;
function getClient() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI;
}

async function query(promptText) {
  // gemini-2.0-flash: no thinking mode, returns in 2-3s. 2.5-flash defaults
  // to chain-of-thought "thinking" which takes 15-25s — and we throw those
  // tokens away anyway since brand extraction only reads the final text.
  const model = getClient().getGenerativeModel({ model: 'gemini-2.0-flash' });
  const result = await model.generateContent(promptText);
  return result.response.text();
}

module.exports = { name: 'gemini', query };
