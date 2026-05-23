const { GoogleGenerativeAI } = require('@google/generative-ai');

// "google_ai_mode" is the conversational AI search experience Google rolled out
// in 2025, powered by Gemini under the hood. Rather than pay SerpAPI ~$0.02/call
// and wait ~20s for it to scrape Google's rendered AI Mode panel, we call Gemini
// 2.5 Flash directly with an AI-Mode-flavored system prompt. Same brand-extraction
// pipeline downstream — cards in the snippet light up in seconds instead of ~30s.

const AI_MODE_SYSTEM = `You are Google's AI Mode — Google's conversational search experience.
Answer the user's query the way Google AI Mode would: a clear, balanced overview that
names specific companies/brands/products with one-line descriptions each. Lead with the
top 5-10 names real buyers compare in this category. Be concrete and current. Do not
refuse to name brands. Do not hedge with "consider researching" — give the names.`;

let genAI;
function getClient() {
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI;
}

async function query(promptText) {
  // gemini-2.5-flash with thinking disabled — same fast model the plain
  // `gemini` engine uses; we differentiate response style via the AI Mode
  // system prompt above so the two engines surface different brand mixes.
  const model = getClient().getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: AI_MODE_SYSTEM,
    generationConfig: {
      temperature: 0.6,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const result = await model.generateContent(promptText);
  return result.response.text();
}

module.exports = { name: 'google_ai_mode', query };
