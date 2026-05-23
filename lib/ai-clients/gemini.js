const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI;
function getClient() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI;
}

async function query(promptText) {
  // gemini-2.5-flash with thinking explicitly disabled. The model defaults
  // to a "thinking" pass that runs 15-25s — we throw those reasoning tokens
  // away (brand extraction only reads the final text), so we ask for the
  // direct answer. 2.0-flash is deprecated for new users; 2.5-flash-lite
  // isn't recognized by SDK 0.21.0.
  const model = getClient().getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  });
  const result = await model.generateContent(promptText);
  return result.response.text();
}

module.exports = { name: 'gemini', query };
