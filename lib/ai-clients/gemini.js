const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI;
function getClient() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI;
}

async function query(promptText) {
  // gemini-1.5-flash returns in 1-2s. The 2.5 series defaults to a "thinking"
  // pass that runs 15-25s, and @google/generative-ai 0.21.0 doesn't honor
  // thinkingConfig.thinkingBudget=0 (the SDK predates the param). Brand
  // extraction only reads the final text, so the older model gives us the
  // signal we use without paying for reasoning tokens we throw away.
  const model = getClient().getGenerativeModel({ model: 'gemini-1.5-flash' });
  const result = await model.generateContent(promptText);
  return result.response.text();
}

module.exports = { name: 'gemini', query };
