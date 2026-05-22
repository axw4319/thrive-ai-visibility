const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI;
function getClient() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI;
}

async function query(promptText) {
  const model = getClient().getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(promptText);
  return result.response.text();
}

module.exports = { name: 'gemini', query };
